#!/usr/bin/env node
/**
 * collect.js — Comm's collection engine
 *
 * Gathers iMessages (chat.db) and Gmail (API) for a given date and stores
 * full message text + sender in SQLite. No AI summarization.
 *
 * Usage:  node collect.js [YYYY-MM-DD]   (default: yesterday)
 *
 * iMessage permission: Full Disk Access for Terminal / node binary
 *   System Settings → Privacy & Security → Full Disk Access
 *
 * Gmail: connect accounts via the Comm's dashboard at http://localhost:3748
 */

'use strict';

const { execFileSync } = require('child_process');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const crypto   = require('crypto');
const Database = require('better-sqlite3');
const { fetchEmailsForDate } = require('./gmail');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'comms');
const DB_PATH  = path.join(DATA_DIR, 'comms.db');

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

    -- Individual messages with full text and sender
    CREATE TABLE IF NOT EXISTS messages (
      id        TEXT PRIMARY KEY,
      run_id    TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      date      TEXT NOT NULL,
      contact   TEXT NOT NULL,
      handle_id TEXT,
      direction TEXT NOT NULL,
      sender    TEXT NOT NULL,
      text      TEXT,
      sent_at   TEXT
    );

    CREATE TABLE IF NOT EXISTS emails (
      id        TEXT PRIMARY KEY,
      run_id    TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      date      TEXT NOT NULL,
      direction TEXT NOT NULL,
      contact   TEXT NOT NULL,
      subject   TEXT,
      snippet   TEXT,
      account   TEXT
    );

    -- Legacy tables kept for DB compat; no longer written
    CREATE TABLE IF NOT EXISTS contacts (
      id       TEXT PRIMARY KEY,
      run_id   TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      date     TEXT NOT NULL,
      contact  TEXT NOT NULL,
      sent     INTEGER DEFAULT 0,
      received INTEGER DEFAULT 0
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

    CREATE INDEX IF NOT EXISTS idx_messages_date ON messages(date);
    CREATE INDEX IF NOT EXISTS idx_emails_date   ON emails(date);
  `);

  // Migration: add snippet to emails if not present
  const emailCols = db.pragma('table_info(emails)').map(c => c.name);
  if (!emailCols.includes('snippet')) db.exec('ALTER TABLE emails ADD COLUMN snippet TEXT');

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
      const e = new Error('Automation permission denied for Contacts — grant access in System Settings → Privacy & Security → Automation');
      e.permissionDenied = true;
      throw e;
    }
    if (stderr.trim()) throw new Error(`AppleScript: ${stderr.trim()}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Contact name resolution via Contacts.app
// ---------------------------------------------------------------------------

function resolveHandlesToNames(handles) {
  if (!handles.length) return {};

  // Only attempt to resolve phone numbers (+digits) and email addresses,
  // not display names (e.g. "Family Chat") which won't be in Contacts.
  const toResolve = [...new Set(handles)].filter(h => h && (/^\+?\d{5,}/.test(h) || h.includes('@')));
  if (!toResolve.length) return {};

  const listStr = toResolve
    .map(h => `"${h.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    .join(', ');

  const script = `
set handleList to {${listStr}}
set resultList to {}
tell application "Contacts"
  repeat with theHandle in handleList
    set resolvedName to theHandle as text
    try
      set phonePeople to (every person whose value of phones contains (theHandle as text))
      if (count of phonePeople) > 0 then
        set resolvedName to name of item 1 of phonePeople
      else
        set emailPeople to (every person whose value of emails contains (theHandle as text))
        if (count of emailPeople) > 0 then
          set resolvedName to name of item 1 of emailPeople
        end if
      end if
    end try
    set end of resultList to ((theHandle as text) & "~~SEP~~" & resolvedName)
  end repeat
end tell
set AppleScript's text item delimiters to "~~NL~~"
return resultList as text`;

  try {
    const raw = runAppleScript(script, { timeout: 60_000 });
    const result = {};
    if (!raw) return result;
    for (const pair of raw.split('~~NL~~')) {
      const idx = pair.indexOf('~~SEP~~');
      if (idx === -1) continue;
      const handle = pair.slice(0, idx).trim();
      const name   = pair.slice(idx + 7).trim();
      if (handle) result[handle] = name || handle;
    }
    return result;
  } catch (err) {
    console.warn(`Contact resolution: ${err.message}`);
    return {};
  }
}

// ---------------------------------------------------------------------------
// iMessage collector — reads chat.db directly (Full Disk Access required)
// ---------------------------------------------------------------------------

const CHAT_DB = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
// Apple's CoreData epoch is Jan 1 2001; message.date is nanoseconds since then
const APPLE_EPOCH_OFFSET = 978307200;

function fetchMessages(date) {
  if (!fs.existsSync(CHAT_DB)) {
    throw new Error(`chat.db not found at ${CHAT_DB}`);
  }

  const startUnix  = Date.UTC(...date.split('-').map((v, i) => i === 1 ? Number(v) - 1 : Number(v))) / 1000;
  const endUnix    = startUnix + 86400;
  const startApple = BigInt(Math.round((startUnix - APPLE_EPOCH_OFFSET) * 1e9));
  const endApple   = BigInt(Math.round((endUnix   - APPLE_EPOCH_OFFSET) * 1e9));

  let db;
  try {
    db = new Database(CHAT_DB, { readonly: true, timeout: 5000 });
  } catch (err) {
    const e = new Error(`Cannot open chat.db — grant Full Disk Access to Terminal (or node) in System Settings → Privacy & Security → Full Disk Access. Detail: ${err.message}`);
    e.fullDiskAccessRequired = true;
    throw e;
  }

  try {
    const rows = db.prepare(`
      SELECT
        m.is_from_me,
        m.text,
        CAST(m.date / 1000000000 AS INTEGER) AS apple_seconds,
        h.id AS sender_handle,
        NULLIF(c.display_name, '')  AS group_name,
        c.chat_identifier,
        (SELECT ch.id FROM chat_handle_join chj
         JOIN handle ch ON ch.ROWID = chj.handle_id
         WHERE chj.chat_id = c.ROWID LIMIT 1) AS first_participant
      FROM message m
      LEFT JOIN handle h              ON h.ROWID = m.handle_id
      LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      LEFT JOIN chat c                ON c.ROWID = cmj.chat_id
      WHERE m.date >= ? AND m.date < ?
        AND m.item_type = 0
      ORDER BY m.date
    `).all(startApple, endApple);

    // Collect all raw handles for name resolution
    const rawHandles = new Set();
    for (const r of rows) {
      if (r.sender_handle)  rawHandles.add(r.sender_handle);
      if (r.first_participant) rawHandles.add(r.first_participant);
      // chat_identifier is a phone number for 1-on-1 chats
      if (r.chat_identifier && /^\+?\d/.test(r.chat_identifier)) rawHandles.add(r.chat_identifier);
    }
    const nameMap = resolveHandlesToNames([...rawHandles]);

    return rows.map(row => {
      const unixSec = Number(row.apple_seconds) + APPLE_EPOCH_OFFSET;
      const sentAt  = new Date(unixSec * 1000).toISOString();

      // contact = who this conversation is with (group name or other person)
      let contact;
      if (row.group_name) {
        contact = row.group_name;
      } else {
        const handle = row.first_participant || row.chat_identifier;
        contact = handle ? (nameMap[handle] || handle) : 'Unknown';
      }

      const sender = row.is_from_me
        ? 'Me'
        : (row.sender_handle ? (nameMap[row.sender_handle] || row.sender_handle) : 'Unknown');

      return {
        contact,
        sender,
        handle_id: row.sender_handle || null,
        direction: row.is_from_me ? 'sent' : 'received',
        text:      row.text || null,
        sent_at:   sentAt,
      };
    });
  } finally {
    db.close();
  }
}

// Quick connectivity test — used by the debug endpoint
function testMessagesAccess() {
  if (!fs.existsSync(CHAT_DB)) return { ok: false, error: `chat.db not found at ${CHAT_DB}` };
  try {
    const db    = new Database(CHAT_DB, { readonly: true, timeout: 3000 });
    const count = db.prepare('SELECT COUNT(*) n FROM message').get().n;
    db.close();
    return { ok: true, method: 'chat.db', messageCount: count };
  } catch (err) {
    return { ok: false, error: err.message, fullDiskAccessRequired: true };
  }
}

// ---------------------------------------------------------------------------
// Core collect — called by CLI and server
// ---------------------------------------------------------------------------

async function collect(date, { onProgress } = {}) {
  const emit = onProgress || (() => {});
  const db   = openDb();

  db.prepare('DELETE FROM runs WHERE date = ?').run(date);
  const runId = crypto.randomUUID();
  db.prepare(`INSERT INTO runs (id, date, collected_at, status) VALUES (?, ?, ?, 'running')`)
    .run(runId, date, new Date().toISOString());

  let messages = [], emails = [];
  const warnings = [];

  try {
    // iMessages (reads chat.db directly — requires Full Disk Access)
    emit({ step: 'messages', status: 'running' });
    try {
      messages = fetchMessages(date);
      emit({ step: 'messages', status: 'done', count: messages.length });
    } catch (err) {
      warnings.push(err.message);
      emit({ step: 'messages', status: 'error', error: err.message, fullDiskAccessRequired: err.fullDiskAccessRequired });
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

    // Write to DB
    db.transaction(() => {
      for (const m of messages) {
        db.prepare(`
          INSERT INTO messages (id, run_id, date, contact, handle_id, direction, sender, text, sent_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(crypto.randomUUID(), runId, date, m.contact, m.handle_id, m.direction, m.sender, m.text, m.sent_at);
      }
      for (const e of emails) {
        db.prepare(`
          INSERT INTO emails (id, run_id, date, direction, contact, subject, snippet, account)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(crypto.randomUUID(), runId, date, e.direction, e.contact, e.subject || null, e.snippet || null, e.account || null);
      }
      db.prepare(`UPDATE runs SET status='done', messages_count=?, emails_count=? WHERE id=?`)
        .run(messages.length, emails.length, runId);
    })();

    emit({ step: 'done', messages: messages.length, emails: emails.length, warnings });
    return { ok: true, runId, date, messages, emails, warnings };

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

// Returns every ISO date from the day after the last successful run up to today.
// Returns [] if nothing has been collected yet (caller can decide to collect from today).
function getMissingDates() {
  const db = openDb();
  try {
    const last = db.prepare(`SELECT date FROM runs WHERE status='done' ORDER BY date DESC LIMIT 1`).get();
    const today = new Date().toISOString().slice(0, 10);
    if (!last) return [today];

    const dates = [];
    const cursor = new Date(last.date + 'T12:00:00Z');
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const end = new Date(today + 'T12:00:00Z');
    while (cursor <= end) {
      dates.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return dates;
  } finally { db.close(); }
}

function getRunDetail(date) {
  const db = openDb();
  try {
    const run = db.prepare('SELECT * FROM runs WHERE date = ?').get(date);
    if (!run) return null;
    const messages = db.prepare('SELECT * FROM messages WHERE run_id = ? ORDER BY sent_at').all(run.id);
    const emails   = db.prepare('SELECT * FROM emails   WHERE run_id = ? ORDER BY rowid').all(run.id);
    return { run, messages, emails };
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
  collect, getRuns, getRunDetail, getMissingDates,
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
      else if (status === 'done')    log(`${step}: ${count != null ? count : 'ok'}`);
      else if (status === 'error')   log(`${step}: skipped — ${error}`);
      else if (status === 'skipped') log(`${step}: skipped — ${error || 'no data'}`);
      else if (step === 'done') {
        log(`complete — ${warnings?.length || 0} warnings`);
        if (warnings?.length) for (const w of warnings) log(`  ⚠ ${w}`);
      }
    },
  }).then(r => {
    log(`DB: ${DB_PATH}`);
    if (r.messages.length) {
      console.log(`\niMessages (${r.messages.length} messages):`);
      for (const m of r.messages) {
        const ts = m.sent_at ? new Date(m.sent_at).toLocaleTimeString() : '';
        console.log(`  [${ts}] ${m.sender} → ${m.contact}: ${(m.text || '(no text)').slice(0, 80)}`);
      }
    }
    if (r.emails.length) {
      console.log(`\nGmail (${r.emails.length} emails):`);
      for (const e of r.emails) {
        const arrow = e.direction === 'received' ? '↓' : '↑';
        console.log(`  ${arrow} [${e.account}] ${e.contact}: ${e.subject}`);
      }
    }
  }).catch(err => { console.error('Fatal:', err.message); process.exit(1); });
}
