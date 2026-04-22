#!/usr/bin/env node
/**
 * collect.js — Comm's collection engine
 *
 * Gathers iMessages (AppleScript) and Gmail (API) for a given date,
 * summarizes with Gemini, and writes to the SQLite DB.
 *
 * Usage:  node collect.js [YYYY-MM-DD]   (default: yesterday)
 *
 * iMessage permission: System Settings → Privacy & Security → Automation
 *   → your terminal app → Messages ✓
 *
 * Gmail: connect accounts via the Comm's dashboard at http://localhost:3748
 */

'use strict';

const { execFileSync } = require('child_process');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const crypto  = require('crypto');
const Database = require('better-sqlite3');
const { GoogleGenAI } = require('@google/genai');
const { fetchEmailsForDate } = require('./gmail');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'comms');
const DB_PATH  = path.join(DATA_DIR, 'comms.db');

// Load .env from this directory
function loadEnv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();

// ---------------------------------------------------------------------------
// DB
// ---------------------------------------------------------------------------

function openDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id             TEXT PRIMARY KEY,
      date           TEXT NOT NULL UNIQUE,
      collected_at   TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'pending',
      messages_count INTEGER DEFAULT 0,
      emails_count   INTEGER DEFAULT 0,
      error          TEXT
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id       TEXT PRIMARY KEY,
      run_id   TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      date     TEXT NOT NULL,
      contact  TEXT NOT NULL,
      sent     INTEGER DEFAULT 0,
      received INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS emails (
      id        TEXT PRIMARY KEY,
      run_id    TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      date      TEXT NOT NULL,
      direction TEXT NOT NULL,
      contact   TEXT NOT NULL,
      subject   TEXT,
      account   TEXT
    );

    CREATE TABLE IF NOT EXISTS summaries (
      run_id        TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      date          TEXT NOT NULL,
      text          TEXT,
      items_json    TEXT,
      entities_json TEXT
    );

    CREATE TABLE IF NOT EXISTS gmail_accounts (
      id         TEXT PRIMARY KEY,
      email      TEXT NOT NULL UNIQUE,
      token_json TEXT NOT NULL,
      added_at   TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_contacts_date  ON contacts(date);
    CREATE INDEX IF NOT EXISTS idx_emails_date    ON emails(date);
    CREATE INDEX IF NOT EXISTS idx_summaries_date ON summaries(date);
  `);
  return db;
}

// ---------------------------------------------------------------------------
// AppleScript runner
// ---------------------------------------------------------------------------

function runAppleScript(script, { timeout = 120_000 } = {}) {
  try {
    return execFileSync('osascript', ['-'], {
      input: script,
      encoding: 'utf8',
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    const stderr = (err.stderr || '').toString();
    const lower  = stderr.toLowerCase();
    if (lower.includes('not allowed') || lower.includes('not authorized') ||
        lower.includes('authorization') || lower.includes('-1743')) {
      const e = new Error('Automation permission denied for Messages — grant access in System Settings → Privacy & Security → Automation');
      e.permissionDenied = true;
      throw e;
    }
    if (stderr.trim()) throw new Error(`AppleScript: ${stderr.trim()}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// iMessage collector
// ---------------------------------------------------------------------------

function fetchMessages(year, month, day) {
  const script = `
tell application "Messages"
  set targetYear  to ${year}
  set targetMonth to ${month}
  set targetDay   to ${day}
  set out to {}
  repeat with aChat in every chat
    set s to 0
    set r to 0
    try
      repeat with aMsg in (messages of aChat)
        try
          set d to date sent of aMsg
          if (year of d as integer) is targetYear and ¬
             (month of d as integer) is targetMonth and ¬
             (day of d as integer) is targetDay then
            try
              if direction of aMsg is outgoing then
                set s to s + 1
              else
                set r to r + 1
              end if
            on error
              set r to r + 1
            end try
          end if
        end try
      end repeat
    end try
    if s > 0 or r > 0 then
      set end of out to ((name of aChat) & "|" & s & "|" & r)
    end if
  end repeat
  return out
end tell`;

  const raw = runAppleScript(script);
  if (!raw) return [];
  return raw.split(', ')
    .map(l => l.trim()).filter(Boolean)
    .map(l => {
      const p = l.split('|');
      if (p.length < 3) return null;
      return { contact: p[0].trim(), sent: parseInt(p[1], 10) || 0, received: parseInt(p[2], 10) || 0 };
    })
    .filter(r => r && r.contact && r.contact !== 'missing value');
}

// Quick connectivity test — used by the server's debug endpoint
function testMessagesAccess() {
  try {
    const result = runAppleScript(`tell application "Messages" to count every chat`);
    return { ok: true, chatCount: parseInt(result, 10) || 0 };
  } catch (err) {
    return { ok: false, error: err.message, permissionDenied: err.permissionDenied || false };
  }
}

// ---------------------------------------------------------------------------
// Gemini summarization
// ---------------------------------------------------------------------------

const COMM_SYSTEM = `You are summarizing a day's communication activity for a private personal knowledge system.
Never quote message text or email bodies verbatim. All items must be pointer-summaries.
Return ONLY valid JSON, no markdown fences.`;

async function summarize(date, messages, emails) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const lines = [];
  if (messages.length) {
    lines.push('iMessage activity:');
    for (const m of messages) lines.push(`  ${m.contact}: sent ${m.sent}, received ${m.received}`);
  }
  if (emails.length) {
    lines.push('Email activity:');
    for (const e of emails) {
      lines.push(e.direction === 'received'
        ? `  Received from ${e.contact}${e.account ? ` (→${e.account})` : ''}: "${e.subject}"`
        : `  Sent to ${e.contact}${e.account ? ` (from ${e.account})` : ''}: "${e.subject}"`);
    }
  }
  if (!lines.length) return null;

  const prompt = `Summarize this communication log for ${date}.

Return JSON:
{
  "text": "<2-4 sentences, first-person, pointer-summaries only. Who the user communicated with and why it mattered. Never quote message content.>",
  "items": [
    { "text": "<pointer-phrase per notable exchange, max 18 words>", "kind": "note" }
  ],
  "entities": [
    { "kind": "person", "label": "<full name or contact identifier>" }
  ]
}

Only include people with meaningful exchanges (skip newsletters, mass email, automated senders).
Capture 3-7 most substantive exchanges in items.

DATA:\n${lines.join('\n')}`;

  try {
    const genai = new GoogleGenAI({ apiKey });
    const resp = await genai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { systemInstruction: COMM_SYSTEM, responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: 2048 },
    });
    const raw = (resp.text || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`Gemini failed: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core collect — called by CLI and server
// ---------------------------------------------------------------------------

async function collect(date, { onProgress } = {}) {
  const [year, month, day] = date.split('-').map(Number);
  const emit = onProgress || (() => {});
  const db   = openDb();

  db.prepare('DELETE FROM runs WHERE date = ?').run(date);
  const runId = crypto.randomUUID();
  db.prepare(`INSERT INTO runs (id, date, collected_at, status) VALUES (?, ?, ?, 'running')`)
    .run(runId, date, new Date().toISOString());

  let messages = [], emails = [], geminiResult = null;
  const warnings = [];

  try {
    // iMessages
    emit({ step: 'messages', status: 'running' });
    try {
      messages = fetchMessages(year, month, day);
      emit({ step: 'messages', status: 'done', count: messages.length });
    } catch (err) {
      warnings.push(err.message);
      emit({ step: 'messages', status: 'error', error: err.message, permissionDenied: err.permissionDenied });
    }

    // Gmail — one pass per connected account
    emit({ step: 'gmail', status: 'running' });
    const accounts = db.prepare('SELECT * FROM gmail_accounts').all();
    if (!accounts.length) {
      emit({ step: 'gmail', status: 'skipped', error: 'No Gmail accounts connected' });
    } else {
      let gmailErrors = 0;
      for (const account of accounts) {
        try {
          const { emails: accountEmails, refreshedTokens } = await fetchEmailsForDate(account.token_json, date);
          for (const e of accountEmails) emails.push({ ...e, account: account.email });
          // Persist refreshed tokens (access tokens expire; googleapis auto-refreshes)
          if (refreshedTokens) {
            const updated = { ...JSON.parse(account.token_json), ...refreshedTokens };
            db.prepare('UPDATE gmail_accounts SET token_json = ? WHERE id = ?')
              .run(JSON.stringify(updated), account.id);
          }
        } catch (err) {
          gmailErrors++;
          warnings.push(`Gmail ${account.email}: ${err.message}`);
        }
      }
      emit({ step: 'gmail', status: 'done', count: emails.length, errors: gmailErrors });
    }

    // Summarize
    emit({ step: 'gemini', status: 'running' });
    if (messages.length || emails.length) {
      geminiResult = await summarize(date, messages, emails);
    }
    emit({ step: 'gemini', status: geminiResult ? 'done' : 'skipped' });

    // Write to DB
    db.transaction(() => {
      for (const m of messages) {
        db.prepare(`INSERT INTO contacts (id, run_id, date, contact, sent, received) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(crypto.randomUUID(), runId, date, m.contact, m.sent, m.received);
      }
      for (const e of emails) {
        db.prepare(`INSERT INTO emails (id, run_id, date, direction, contact, subject, account) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(crypto.randomUUID(), runId, date, e.direction, e.contact, e.subject || null, e.account || null);
      }
      if (geminiResult) {
        db.prepare(`INSERT INTO summaries (run_id, date, text, items_json, entities_json) VALUES (?, ?, ?, ?, ?)`)
          .run(runId, date, geminiResult.text || null,
            JSON.stringify(geminiResult.items || []),
            JSON.stringify(geminiResult.entities || []));
      }
      db.prepare(`UPDATE runs SET status='done', messages_count=?, emails_count=? WHERE id=?`)
        .run(messages.length, emails.length, runId);
    })();

    emit({ step: 'done', messages: messages.length, emails: emails.length, warnings });
    return { ok: true, runId, date, messages, emails, summary: geminiResult, warnings };

  } catch (err) {
    db.prepare(`UPDATE runs SET status='error', error=? WHERE id=?`).run(err.message, runId);
    emit({ step: 'error', error: err.message });
    throw err;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// DB read helpers (used by server)
// ---------------------------------------------------------------------------

function getRuns(limit = 60) {
  const db = openDb();
  try { return db.prepare('SELECT * FROM runs ORDER BY date DESC LIMIT ?').all(limit); }
  finally { db.close(); }
}

function getRunDetail(date) {
  const db = openDb();
  try {
    const run = db.prepare('SELECT * FROM runs WHERE date = ?').get(date);
    if (!run) return null;
    const contacts = db.prepare('SELECT * FROM contacts WHERE run_id = ? ORDER BY (sent + received) DESC').all(run.id);
    const emails   = db.prepare('SELECT * FROM emails   WHERE run_id = ? ORDER BY rowid').all(run.id);
    const summary  = db.prepare('SELECT * FROM summaries WHERE run_id = ?').get(run.id);
    return {
      run, contacts, emails,
      summary: summary ? {
        text:     summary.text,
        items:    JSON.parse(summary.items_json    || '[]'),
        entities: JSON.parse(summary.entities_json || '[]'),
      } : null,
    };
  } finally { db.close(); }
}

function getGmailAccounts() {
  const db = openDb();
  try { return db.prepare('SELECT id, email, added_at FROM gmail_accounts ORDER BY added_at').all(); }
  finally { db.close(); }
}

function saveGmailAccount(email, tokens) {
  const db = openDb();
  try {
    db.prepare(`
      INSERT INTO gmail_accounts (id, email, token_json, added_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET token_json = excluded.token_json
    `).run(crypto.randomUUID(), email, JSON.stringify(tokens), new Date().toISOString());
  } finally { db.close(); }
}

function deleteGmailAccount(id) {
  const db = openDb();
  try { db.prepare('DELETE FROM gmail_accounts WHERE id = ?').run(id); }
  finally { db.close(); }
}

module.exports = {
  collect, getRuns, getRunDetail,
  getGmailAccounts, saveGmailAccount, deleteGmailAccount,
  testMessagesAccess,
  DB_PATH,
};

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const date = (() => {
    const arg = process.argv[2];
    if (arg && /^\d{4}-\d{2}-\d{2}$/.test(arg)) return arg;
    const d = new Date(); d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  })();

  function log(msg) { console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`); }

  collect(date, {
    onProgress({ step, status, count, error, warnings }) {
      if (status === 'running') log(`${step}…`);
      else if (status === 'done') log(`${step}: ${count != null ? count : 'ok'}`);
      else if (status === 'error') log(`${step}: skipped — ${error}`);
      else if (status === 'skipped') log(`${step}: skipped — ${error || 'no data'}`);
      else if (step === 'done') {
        log(`complete — ${count || 0} messages contacts, ${warnings?.length || 0} warnings`);
        if (warnings?.length) for (const w of warnings) log(`  ⚠ ${w}`);
      }
    },
  }).then(r => {
    log(`DB: ${DB_PATH}`);
    if (r.summary?.text) console.log('\n' + r.summary.text);
    if (r.messages.length) {
      console.log('\niMessages:');
      for (const m of r.messages) console.log(`  ${m.contact}: ↑${m.sent} ↓${m.received}`);
    }
    if (r.emails.length) {
      console.log('\nGmail:');
      for (const e of r.emails) console.log(`  ${e.direction === 'received' ? '↓' : '↑'} [${e.account}] ${e.contact}: ${e.subject}`);
    }
  }).catch(err => { console.error('Fatal:', err.message); process.exit(1); });
}
