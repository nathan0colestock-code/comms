'use strict';

// Scheduled inbox triage — runs at 8am and noon local time (see server.js
// scheduler). For each unread INBOX thread:
//   • bulk/newsletter/transactional → archive if AUTO_ARCHIVE_BULK=true,
//     otherwise skip. Never auto-unsubscribes; unsubscribable senders land
//     in email_unsub_queue for weekly review.
//   • spam → archive (quiet) + stash in unsub queue if listable.
//   • real person → build a context profile (gloss + comms + black + thread
//     history), ask Gemini to draft a reply, save to Gmail Drafts. Never
//     sends. If the thread already has a draft we save a fresh one so the
//     user always sees the most recent context.
//
// Context profiles are cached per contact in email_contact_context with a
// 6-hour stale_after so we don't cold-search the suite on every run — the
// 8am job builds them, the noon job reuses them.

const crypto = require('crypto');
const {
  gmailClientFor, listUnreadInboxThreads, getMessageFull,
  createDraftReply, archiveThread, extractEmail, hasScope,
} = require('./gmail');

const CACHE_STALE_MS = 6 * 60 * 60 * 1000; // 6h
const MAX_BODY_FOR_LLM = 6000;
const AUTO_ARCHIVE_BULK = process.env.AUTO_ARCHIVE_BULK === 'true';

// ─── Classifier ────────────────────────────────────────────────────────────
// Pure heuristic. Returns { kind, reason }.
//   real           — looks like human-to-human; drafts a reply
//   newsletter     — substack/mailchimp/etc with List-Unsubscribe
//   transactional  — receipts, noreply, system mail; never drafts or archives
//                    (user might need to act on them)
//   spam           — hard-negative signals; archive quietly
function classifyEmail(msg) {
  const from = (msg.from || '').toLowerCase();
  const email = extractEmail(from);
  const subject = (msg.subject || '').toLowerCase();
  const hasListUnsub = !!msg.listUnsubscribe;

  // Transactional: receipts, shipping, password resets, etc. Keep in inbox.
  const TRANSACTIONAL_PATTERNS = [
    /^(no-?reply|noreply|do-?not-?reply|postmaster|mailer-daemon)@/i,
    /@(stripe|paypal|square|amazon|usps|fedex|ups|dhl)\./i,
    /@accounts\.google\.com/i, /@apple\.com$/i, /@github\.com$/i,
  ];
  if (TRANSACTIONAL_PATTERNS.some(p => p.test(email))) {
    return { kind: 'transactional', reason: 'sender pattern' };
  }
  if (/(receipt|order|shipped|delivery|verification code|2fa|sign-in|password reset)/i.test(subject)) {
    return { kind: 'transactional', reason: 'subject pattern' };
  }

  // Newsletter / bulk: List-Unsubscribe header is the near-definitive signal,
  // plus noreply-ish senders with promotional subjects.
  if (hasListUnsub) {
    // Real people occasionally send via lists (conference CFPs from
    // individuals); the combination of List-Unsub AND bulk sender pattern
    // is what tips to newsletter.
    const looksBulk = /@(newsletter|mail|mailer|email|news|updates|hello|team|info|support)\./i.test(email)
      || /noreply|no-reply/i.test(email);
    if (looksBulk) return { kind: 'newsletter', reason: 'list-unsub + bulk sender' };
    return { kind: 'newsletter', reason: 'list-unsubscribe header' };
  }

  // Spam: obvious subject signals. We stay conservative — false-positive is
  // worse than false-negative here since archive is recoverable but missing
  // a real email is not.
  if (/\b(earn \$|make money|crypto|bitcoin|lottery winner|nigerian prince|viagra|cialis)\b/i.test(subject)) {
    return { kind: 'spam', reason: 'subject keyword' };
  }

  // Default — treat as a real person.
  return { kind: 'real', reason: 'no triage signal' };
}

// ─── Context builder (lazy, cached) ─────────────────────────────────────────
// Aggregates everything comms knows about a sender into a compact context
// block the LLM can use. Cached per-contact with a 6h stale window.
function getOrBuildContactContext(db, senderEmail, senderName) {
  const cached = db.prepare(
    'SELECT context_json, stale_after FROM email_contact_context WHERE sender_email = ?'
  ).get(senderEmail);

  if (cached && new Date(cached.stale_after) > new Date()) {
    try { return JSON.parse(cached.context_json); } catch { /* rebuild below */ }
  }

  // Build fresh. Each source is try/catch so a schema surprise doesn't kill
  // the whole run.
  const ctx = { sender_email: senderEmail, sender_name: senderName, built_at: new Date().toISOString() };

  // Matching contact in comms (people table resolves variants)
  try {
    const row = db.prepare(
      `SELECT p.id, p.display_name FROM people p
       JOIN cards c ON c.person_id = p.id
       WHERE c.email = ? LIMIT 1`
    ).get(senderEmail);
    if (row) ctx.contact_id = row.id, ctx.contact_name = row.display_name;
  } catch { /* no cards table yet — skip */ }

  // Recent email history with this sender (subject + snippet only — no bodies)
  try {
    const rows = db.prepare(
      `SELECT direction, subject, snippet, date FROM emails
       WHERE email_address = ? ORDER BY date DESC LIMIT 8`
    ).all(senderEmail);
    ctx.recent_emails = rows;
  } catch { ctx.recent_emails = []; }

  // Messages history (iMessage) — look up by display name since iMessages
  // aren't keyed on email. Heuristic: if we have a contact_name, try that.
  try {
    if (ctx.contact_name) {
      const rows = db.prepare(
        `SELECT direction, text, sent_at FROM messages
         WHERE contact = ? ORDER BY sent_at DESC LIMIT 6`
      ).all(ctx.contact_name);
      ctx.recent_messages = rows.map(r => ({ ...r, text: (r.text || '').slice(0, 200) }));
    } else { ctx.recent_messages = []; }
  } catch { ctx.recent_messages = []; }

  // Gloss contact profile (if pushed) — pulls priority/growth_note/linked_collections
  try {
    const row = db.prepare(
      `SELECT contact, priority, growth_note, linked_collections, recent_context, gloss_url
       FROM gloss_contacts WHERE contact = ? OR aliases LIKE ? LIMIT 1`
    ).get(ctx.contact_name || senderName || '', `%${ctx.contact_name || senderName || ''}%`);
    if (row) {
      ctx.gloss_profile = {
        priority: row.priority,
        growth_note: row.growth_note,
        gloss_url: row.gloss_url,
        linked_collections: safeParse(row.linked_collections),
        recent_context: safeParse(row.recent_context),
      };
    }
  } catch { /* table shape may vary */ }

  // Stash in cache
  try {
    db.prepare(
      `INSERT INTO email_contact_context (sender_email, context_json, built_at, stale_after)
       VALUES (?, ?, datetime('now'), datetime('now', '+6 hours'))
       ON CONFLICT(sender_email) DO UPDATE SET
         context_json = excluded.context_json,
         built_at = excluded.built_at,
         stale_after = excluded.stale_after`
    ).run(senderEmail, JSON.stringify(ctx));
  } catch (err) { console.warn('[email-helper] cache write failed:', err.message); }

  return ctx;
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

// ─── Outbound draft generator (check-in / new thread) ──────────────────────
// Generates a cold-start outbound message body — used by the contact-page
// "Draft a check-in" button. Shape of `ctx` mirrors getOrBuildContactContext
// output so this reuses the same prompt-context framing as reply drafts.
async function draftOutboundBody({ ctx, occasion, style = 'warm', medium = 'email' }) {
  if (!process.env.GEMINI_API_KEY) return null;
  const { GoogleGenAI } = require('@google/genai');
  const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const contextBlock = [
    ctx.contact_name ? `Recipient: ${ctx.contact_name} <${ctx.sender_email || ''}>` : `Recipient: ${ctx.sender_email || ctx.sender_name || 'unknown'}`,
    ctx.gloss_profile?.growth_note ? `Gloss note about them: ${ctx.gloss_profile.growth_note}` : null,
    ctx.gloss_profile?.linked_collections?.length ? `Gloss topics involving them: ${ctx.gloss_profile.linked_collections.slice(0, 5).join(', ')}` : null,
    ctx.recent_emails?.length ? `Recent email history:\n${ctx.recent_emails.slice(0, 6).map(e => `  ${e.direction} ${e.date}: ${e.subject}`).join('\n')}` : null,
    ctx.recent_messages?.length ? `Recent iMessages:\n${ctx.recent_messages.slice(0, 6).map(m => `  ${m.direction} ${m.sent_at}: ${m.text}`).join('\n')}` : null,
  ].filter(Boolean).join('\n\n');

  const styleGuide = style === 'formal'
    ? 'Keep the tone formal and respectful; complete sentences, no lowercase starts.'
    : style === 'direct'
      ? 'Be direct and brief — get to the point in the first sentence. No small talk.'
      : "Warm, short, in Nathan's voice: lowercase starts are fine, plain words, no corporate preamble, no emojis.";

  const mediumGuide = medium === 'imessage'
    ? 'Target medium: iMessage. Keep it very short (1–3 sentences). No subject line.'
    : 'Target medium: email. Body only — user fills the subject. 2–5 short paragraphs max.';

  const prompt = `You are drafting an outbound message for Nathan Colestock to send. He will review and edit before sending — never send or assume you're right.

${styleGuide}
${mediumGuide}

Occasion / reason for reaching out: ${occasion || '(general check-in, no specific occasion)'}

Reference specifics from the prior context when relevant. When uncertain about a fact or commitment, use a placeholder like [confirm date] rather than guessing.

== Context about the recipient ==
${contextBlock || '(no prior context in the suite)'}

== Your outbound message ==
Write only the body. No greeting like "Dear X" unless the relationship calls for it. Sign with just "Nathan" or nothing.`;

  try {
    const response = await genai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { temperature: 0.55, maxOutputTokens: 600 },
    });
    return (response.text || '').trim() || null;
  } catch (err) {
    console.warn('[email-helper] outbound draft failed:', err.message);
    return null;
  }
}

// ─── Draft generator ────────────────────────────────────────────────────────
// Uses Gemini (via google GenAI SDK already in the dep graph from
// gloss-style apps — falls back gracefully if SDK/key is missing).
async function draftReplyBody(msg, ctx) {
  if (!process.env.GEMINI_API_KEY) return null;
  const { GoogleGenAI } = require('@google/genai');
  const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const contextBlock = [
    ctx.contact_name ? `Sender (resolved): ${ctx.contact_name} <${ctx.sender_email}>` : `Sender: ${ctx.sender_email}`,
    ctx.gloss_profile?.growth_note ? `Gloss note about them: ${ctx.gloss_profile.growth_note}` : null,
    ctx.gloss_profile?.linked_collections?.length ? `Gloss topics involving them: ${ctx.gloss_profile.linked_collections.slice(0, 5).join(', ')}` : null,
    ctx.recent_emails?.length ? `Recent email history:\n${ctx.recent_emails.map(e => `  ${e.direction} ${e.date}: ${e.subject}`).join('\n')}` : null,
    ctx.recent_messages?.length ? `Recent iMessages:\n${ctx.recent_messages.map(m => `  ${m.direction} ${m.sent_at}: ${m.text}`).join('\n')}` : null,
  ].filter(Boolean).join('\n\n');

  const prompt = `You are drafting a reply for Nathan Colestock. He will review and edit before sending — never send or assume you're right.

Write a short, warm, direct reply in Nathan's voice: lowercase starts are fine, plain words, no corporate preamble, no "I hope this email finds you well", no emojis. Reference specifics from the thread and context when relevant. When uncertain about a fact or commitment, use a placeholder like [confirm date] rather than guessing.

== Context about the sender ==
${contextBlock || '(no prior context in the suite)'}

== Incoming email ==
Subject: ${msg.subject}
From: ${msg.from}
Date: ${msg.date}

${(msg.body || msg.snippet || '').slice(0, MAX_BODY_FOR_LLM)}

== Your reply ==
Write only the body of the reply. No greeting like "Dear X" unless the relationship calls for it. Sign with just "Nathan" or nothing.`;

  try {
    const response = await genai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { temperature: 0.55, maxOutputTokens: 600 },
    });
    return (response.text || '').trim() || null;
  } catch (err) {
    console.warn('[email-helper] draft failed:', err.message);
    return null;
  }
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

async function runForAccount(account, db) {
  if (!hasScope(account.token_json, 'https://www.googleapis.com/auth/gmail.modify')) {
    return { account: account.email, skipped: 'needs-gmail.modify-scope', counts: {} };
  }

  const { gmail, refreshed } = gmailClientFor(account.token_json);
  const threads = await listUnreadInboxThreads(gmail, { max: 30 });
  const counts = { total: threads.length, drafted: 0, archived: 0, skipped: 0, queued_unsub: 0, errors: 0 };
  const results = [];

  for (const t of threads) {
    try {
      const msg = await getMessageFull(gmail, t.messageId);
      const cls = classifyEmail(msg);

      if (cls.kind === 'transactional') {
        counts.skipped++;
        results.push({ thread: t.threadId, action: 'skip', class: cls.kind, subject: msg.subject });
        continue;
      }

      if (cls.kind === 'newsletter' || cls.kind === 'spam') {
        if (msg.listUnsubscribe) {
          db.prepare(
            `INSERT OR IGNORE INTO email_unsub_queue
               (message_id, thread_id, account, sender_email, sender_name, subject, list_unsubscribe, classified_as)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(t.messageId, t.threadId, account.email, extractEmail(msg.from),
            msg.from, msg.subject, msg.listUnsubscribe, cls.kind);
          counts.queued_unsub++;
        }
        if (AUTO_ARCHIVE_BULK) {
          await archiveThread(gmail, t.threadId);
          counts.archived++;
          results.push({ thread: t.threadId, action: 'archive', class: cls.kind, subject: msg.subject });
        } else {
          counts.skipped++;
          results.push({ thread: t.threadId, action: 'skip-archive-off', class: cls.kind, subject: msg.subject });
        }
        continue;
      }

      // Real person — build context + draft.
      const senderEmail = extractEmail(msg.from);
      const ctx = getOrBuildContactContext(db, senderEmail, msg.from);
      const body = await draftReplyBody(msg, ctx);
      if (!body) {
        counts.skipped++;
        results.push({ thread: t.threadId, action: 'skip-no-draft', class: cls.kind, subject: msg.subject });
        continue;
      }
      await createDraftReply(gmail, {
        threadId: t.threadId,
        to: msg.from,
        subject: msg.subject || '(no subject)',
        body,
        inReplyTo: msg.messageId,
        references: msg.references || msg.messageId,
      });
      counts.drafted++;
      results.push({ thread: t.threadId, action: 'draft', class: cls.kind, subject: msg.subject });
    } catch (err) {
      counts.errors++;
      results.push({ thread: t.threadId, action: 'error', error: err.message });
    }
  }

  return {
    account: account.email,
    counts, results,
    refreshed_tokens: refreshed.value,
  };
}

async function runEmailHelper({ db, getGmailAccountsWithTokens, saveGmailTokens }) {
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const accounts = getGmailAccountsWithTokens();
  const perAccount = [];
  for (const acct of accounts) {
    try {
      const r = await runForAccount(acct, db);
      if (r.refreshed_tokens) {
        try { saveGmailTokens(acct.id, { ...JSON.parse(acct.token_json), ...r.refreshed_tokens }); } catch {}
      }
      perAccount.push(r);
    } catch (err) {
      perAccount.push({ account: acct.email, error: err.message });
    }
  }
  const endedAt = new Date().toISOString();
  const totals = perAccount.reduce((acc, r) => {
    for (const k of ['total', 'drafted', 'archived', 'skipped', 'queued_unsub', 'errors']) {
      acc[k] = (acc[k] || 0) + (r.counts?.[k] || 0);
    }
    return acc;
  }, {});
  try {
    db.prepare(
      `INSERT INTO email_helper_runs (id, started_at, ended_at, summary_json)
       VALUES (?, ?, ?, ?)`
    ).run(runId, startedAt, endedAt, JSON.stringify({ totals, per_account: perAccount }));
  } catch (err) { console.warn('[email-helper] run log failed:', err.message); }
  return { id: runId, started_at: startedAt, ended_at: endedAt, totals, per_account: perAccount };
}

module.exports = {
  classifyEmail, getOrBuildContactContext, draftReplyBody, draftOutboundBody,
  runForAccount, runEmailHelper,
};
