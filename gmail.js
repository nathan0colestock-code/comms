'use strict';

// Gmail API integration — OAuth2 + email fetching (metadata only, no bodies).

const { google } = require('googleapis');

// Redirect URI honours PUBLIC_ORIGIN so the same code works in dev + on Fly.
function redirectUri() {
  const origin = process.env.PUBLIC_ORIGIN || `http://localhost:${process.env.PORT || 3748}`;
  return `${origin.replace(/\/+$/, '')}/api/gmail/callback`;
}

// Gmail (modify = read + archive + draft), Calendar (read-only), Contacts
// (read-only). gmail.modify covers everything gmail.readonly does, plus
// the draft-save + label-change surfaces the email helper needs. Google
// will ask the user to approve all three at once on first connect.
// Existing accounts keep working with whatever scope they last consented to;
// the email helper checks hasScope() before acting so unscoped accounts
// just skip rather than fail.
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/contacts.readonly',
];

function makeClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri(),
  );
}

function getAuthUrl(loginHint) {
  const client = makeClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    login_hint: loginHint || undefined,
    prompt: 'consent',
  });
}

function hasScope(tokenJson, scope) {
  try {
    const t = typeof tokenJson === 'string' ? JSON.parse(tokenJson) : tokenJson;
    const s = t?.scope || '';
    return s.split(/\s+/).includes(scope);
  } catch { return false; }
}

async function exchangeCode(code) {
  const client = makeClient();
  const { tokens } = await client.getToken(code);
  return tokens;
}

async function getAccountEmail(tokens) {
  const client = makeClient();
  client.setCredentials(tokens);
  const gmail = google.gmail({ version: 'v1', auth: client });
  const { data } = await gmail.users.getProfile({ userId: 'me' });
  return data.emailAddress;
}

// Returns { emails: [{direction, contact, subject}], refreshedTokens }
async function fetchEmailsForDate(tokenJson, date) {
  const client = makeClient();
  client.setCredentials(JSON.parse(tokenJson));

  let refreshedTokens = null;
  client.on('tokens', t => { refreshedTokens = t; });

  const gmail = google.gmail({ version: 'v1', auth: client });

  // Build date range — Gmail uses YYYY/M/D format; use UTC to avoid local-time day shift
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const afterStr  = `${y}/${m}/${d}`;
  const beforeStr = `${next.getUTCFullYear()}/${next.getUTCMonth() + 1}/${next.getUTCDate()}`;

  const emails = [];

  for (const [direction, labelQuery] of [
    ['received', `in:inbox after:${afterStr} before:${beforeStr}`],
    ['sent',     `in:sent  after:${afterStr} before:${beforeStr}`],
  ]) {
    try {
      const list = await gmail.users.messages.list({
        userId: 'me',
        q: labelQuery,
        maxResults: 100,
      });

      for (const msg of list.data.messages || []) {
        try {
          const detail = await gmail.users.messages.get({
            userId: 'me',
            id: msg.id,
            format: 'metadata',
            metadataHeaders: ['From', 'To', 'Subject'],
          });
          const headers = detail.data.payload?.headers || [];
          const h = name => headers.find(x => x.name.toLowerCase() === name)?.value || '';

          const rawContact = direction === 'received' ? h('from') : h('to');
          const contact = parseContact(rawContact);
          const subject = h('subject') || '(no subject)';

          const emailAddress = extractEmail(rawContact);
          if (contact) emails.push({
            direction,
            contact,
            emailAddress,
            subject,
            snippet: detail.data.snippet || null,
            threadId: detail.data.threadId || msg.threadId || null,
          });
        } catch (err) {
          console.warn(`[gmail] message fetch error: ${err.message}`);
        }
      }
    } catch (err) {
      console.warn(`[gmail] list error (${direction}): ${err.message}`);
      throw err; // re-throw so collect() can count it as an error
    }
  }

  return { emails, refreshedTokens };
}

// "Jane Doe <jane@example.com>" → "Jane Doe"
function parseContact(raw) {
  const m = raw.match(/^(.+?)\s*<[^>]+>/);
  return (m ? m[1].replace(/^["']|["']$/g, '') : raw).trim();
}

// Extract bare email address from a header value
function extractEmail(raw) {
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1] : raw.trim()).toLowerCase();
}

// ── Email helper primitives ─────────────────────────────────────────────────
// These support the scheduled inbox-triage job. Each takes a Gmail client
// already authed for an account (via gmailClientFor below) so the helper
// can reuse one client across many calls per account.

function gmailClientFor(tokenJson) {
  const client = makeClient();
  client.setCredentials(typeof tokenJson === 'string' ? JSON.parse(tokenJson) : tokenJson);
  const refreshed = { value: null };
  client.on('tokens', t => { refreshed.value = t; });
  return { gmail: google.gmail({ version: 'v1', auth: client }), refreshed };
}

// List unread INBOX threads (one row per thread, newest first). We dedupe by
// threadId so a thread with multiple unread messages only shows up once.
async function listUnreadInboxThreads(gmail, { max = 50 } = {}) {
  const list = await gmail.users.messages.list({
    userId: 'me', q: 'is:unread in:inbox', maxResults: max,
  });
  const byThread = new Map();
  for (const m of list.data.messages || []) {
    if (!byThread.has(m.threadId)) byThread.set(m.threadId, m.id);
  }
  return [...byThread.entries()].map(([threadId, messageId]) => ({ threadId, messageId }));
}

// Fetch a message with headers + snippet + plain-text body (best effort).
async function getMessageFull(gmail, messageId) {
  const { data } = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
  const headers = data.payload?.headers || [];
  const h = name => headers.find(x => x.name.toLowerCase() === name.toLowerCase())?.value || '';
  const body = extractPlainText(data.payload) || '';
  return {
    id: data.id, threadId: data.threadId, snippet: data.snippet || '',
    labelIds: data.labelIds || [],
    from: h('From'), to: h('To'), subject: h('Subject'),
    date: h('Date'), listUnsubscribe: h('List-Unsubscribe'),
    messageId: h('Message-ID'), references: h('References'),
    body: body.slice(0, 20_000),
  };
}

function extractPlainText(part) {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf8');
  }
  for (const p of part.parts || []) {
    const t = extractPlainText(p);
    if (t) return t;
  }
  return '';
}

// Create a draft reply in the same thread. `to` and `subject` build a minimal
// RFC-822 message; Gmail handles threading via threadId + In-Reply-To.
async function createDraftReply(gmail, { threadId, to, subject, body, inReplyTo, references }) {
  const normalizedSubject = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
  const lines = [
    `To: ${to}`,
    `Subject: ${normalizedSubject}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : '',
    references ? `References: ${references}` : '',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    body,
  ].filter(Boolean);
  const raw = Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
  const { data } = await gmail.users.drafts.create({
    userId: 'me', requestBody: { message: { raw, threadId } },
  });
  return { draftId: data.id, messageId: data.message?.id };
}

// Remove the INBOX label (== "archive" in Gmail's model). Used by the bulk-
// mail triage path, gated behind AUTO_ARCHIVE_BULK. Never deletes.
async function archiveThread(gmail, threadId) {
  await gmail.users.threads.modify({
    userId: 'me', id: threadId, requestBody: { removeLabelIds: ['INBOX'] },
  });
}

module.exports = {
  getAuthUrl, exchangeCode, getAccountEmail,
  fetchEmailsForDate, parseContact, extractEmail, hasScope,
  gmailClientFor, listUnreadInboxThreads, getMessageFull,
  createDraftReply, archiveThread, extractPlainText,
};
