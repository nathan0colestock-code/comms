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

// On macOS we store the DB under ~/Library/Application Support/comms/comms.db.
// On Fly.io (or anywhere the env var is set), honor COMMS_DB_PATH instead —
// e.g. /data/comms.db on the mounted volume.
const DATA_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'comms');
const DB_PATH  = process.env.COMMS_DB_PATH || path.join(DATA_DIR, 'comms.db');

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
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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
      id           TEXT PRIMARY KEY,
      run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      date         TEXT NOT NULL,
      direction    TEXT NOT NULL,
      contact      TEXT NOT NULL,
      email_address TEXT,
      subject      TEXT,
      snippet      TEXT,
      account      TEXT
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

    -- Enriched profiles pushed from Gloss (the notebook app).
    -- One row per canonical person. The "contact" name is the join key that
    -- matches messages.contact / emails.contact (case-insensitive).
    CREATE TABLE IF NOT EXISTS gloss_contacts (
      contact            TEXT PRIMARY KEY COLLATE NOCASE,
      aliases            TEXT,              -- JSON array of alt names
      gloss_id           TEXT NOT NULL,
      gloss_url          TEXT NOT NULL,
      mention_count      INTEGER DEFAULT 0,
      last_mentioned_at  TEXT,              -- YYYY-MM-DD
      priority           INTEGER DEFAULT 0,
      growth_note        TEXT,
      recent_context     TEXT,              -- JSON: [{date, role_summary, collection}]
      linked_collections TEXT,              -- JSON: [string,...]
      synced_at          TEXT NOT NULL
    );

    -- Google Calendar events (rolling 14-day window).
    CREATE TABLE IF NOT EXISTS calendar_events (
      id           TEXT PRIMARY KEY,        -- Google event ID
      calendar_id  TEXT,
      account      TEXT,                    -- which Gmail account owns it
      date         TEXT NOT NULL,           -- YYYY-MM-DD (local date of start)
      start_time   TEXT,                    -- ISO 8601
      end_time     TEXT,
      title        TEXT,
      description  TEXT,
      location     TEXT,
      attendees    TEXT,                    -- JSON: [{name, email, response}]
      html_link    TEXT,
      synced_at    TEXT NOT NULL
    );

    -- AI-generated contact insights (cached; regenerated on demand).
    CREATE TABLE IF NOT EXISTS contact_insights (
      contact      TEXT PRIMARY KEY COLLATE NOCASE,
      insight      TEXT NOT NULL,
      generated_at TEXT NOT NULL
    );

    -- AI-generated meeting briefs (cached per event).
    CREATE TABLE IF NOT EXISTS meeting_briefs (
      event_id     TEXT PRIMARY KEY,
      brief        TEXT NOT NULL,
      generated_at TEXT NOT NULL
    );

    -- Nudge dismissals keyed by ISO week so they auto-expire each Monday.
    CREATE TABLE IF NOT EXISTS nudge_dismissals (
      contact  TEXT NOT NULL,
      week     TEXT NOT NULL,               -- e.g. "2026-W17"
      PRIMARY KEY (contact, week)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_date       ON messages(date);
    CREATE INDEX IF NOT EXISTS idx_emails_date         ON emails(date);
    CREATE INDEX IF NOT EXISTS idx_messages_contact    ON messages(contact COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_emails_contact      ON emails(contact COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_calendar_events_date ON calendar_events(date);
    CREATE INDEX IF NOT EXISTS idx_gloss_contacts_prio  ON gloss_contacts(priority DESC);
  `);

  // Migrations for emails table
  const emailCols = db.pragma('table_info(emails)').map(c => c.name);
  if (!emailCols.includes('snippet'))        db.exec('ALTER TABLE emails ADD COLUMN snippet TEXT');
  if (!emailCols.includes('email_address'))  db.exec('ALTER TABLE emails ADD COLUMN email_address TEXT');

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
// Contact name resolution — reads AddressBook SQLite directly (Full Disk Access)
// ---------------------------------------------------------------------------

const AB_BASE = path.join(os.homedir(), 'Library', 'Application Support', 'AddressBook');

// Strip non-digits; normalize US 11-digit (1xxxxxxxxxx) to 10-digit
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits[0] === '1') return digits.slice(1);
  return digits || null;
}

// Build phone→name and email→name maps from all AddressBook sources
let _contactsCache = null;
function getContactsMap() {
  if (_contactsCache) return _contactsCache;

  const phoneMap = new Map();
  const emailMap = new Map();

  const srcDir = path.join(AB_BASE, 'Sources');
  const dbPaths = [];
  if (fs.existsSync(srcDir)) {
    for (const src of fs.readdirSync(srcDir)) {
      const p = path.join(srcDir, src, 'AddressBook-v22.abcddb');
      if (fs.existsSync(p)) dbPaths.push(p);
    }
  }
  const mainDb = path.join(AB_BASE, 'AddressBook-v22.abcddb');
  if (fs.existsSync(mainDb)) dbPaths.unshift(mainDb);

  for (const dbPath of dbPaths) {
    try {
      const db = new Database(dbPath, { readonly: true, timeout: 3000 });
      try {
        const fullName = r =>
          ([r.ZFIRSTNAME, r.ZLASTNAME].filter(Boolean).join(' ') || r.ZORGANIZATION || '').trim();

        for (const row of db.prepare(`
          SELECT r.ZFIRSTNAME, r.ZLASTNAME, r.ZORGANIZATION, p.ZFULLNUMBER
          FROM ZABCDPHONENUMBER p JOIN ZABCDRECORD r ON r.Z_PK = p.ZOWNER
          WHERE p.ZFULLNUMBER IS NOT NULL
        `).all()) {
          const name = fullName(row);
          const norm = normalizePhone(row.ZFULLNUMBER);
          if (name && norm) phoneMap.set(norm, name);
        }

        for (const row of db.prepare(`
          SELECT r.ZFIRSTNAME, r.ZLASTNAME, r.ZORGANIZATION, e.ZADDRESSNORMALIZED
          FROM ZABCDEMAILADDRESS e JOIN ZABCDRECORD r ON r.Z_PK = e.ZOWNER
          WHERE e.ZADDRESSNORMALIZED IS NOT NULL
        `).all()) {
          const name = fullName(row);
          if (name) emailMap.set(row.ZADDRESSNORMALIZED.toLowerCase(), name);
        }
      } finally { db.close(); }
    } catch { /* skip inaccessible source */ }
  }

  _contactsCache = { phoneMap, emailMap };
  return _contactsCache;
}

const AUTOMATED_EMAIL = /noreply|no[-.]reply|donotreply|notification|newsletter|mailer-daemon|postmaster|unsubscribe|marketing|bounce|automated|alert|digest|confirm|verify|welcome|updates@|news@|info@|support@|hello@|team@|billing@|invoice@|receipt@/i;

// Keep email if: (a) sender is in Contacts, or (b) doesn't match automated patterns
function isRealPersonEmail(emailAddress, emailMap) {
  if (!emailAddress) return false;
  if (emailMap.has(emailAddress)) return true;
  if (AUTOMATED_EMAIL.test(emailAddress)) return false;
  return true;
}

function resolveHandlesToNames(handles) {
  if (!handles.length) return {};
  const toResolve = [...new Set(handles)].filter(h => h && (/^\+?\d{5,}/.test(h) || h.includes('@')));
  if (!toResolve.length) return {};

  try {
    const { phoneMap, emailMap } = getContactsMap();
    const result = {};
    for (const handle of toResolve) {
      if (handle.includes('@')) {
        result[handle] = emailMap.get(handle.toLowerCase()) || handle;
      } else {
        const norm = normalizePhone(handle);
        result[handle] = (norm && phoneMap.get(norm)) || handle;
      }
    }
    return result;
  } catch (err) {
    console.warn(`Contact resolution: ${err.message}`);
    return {};
  }
}

// ---------------------------------------------------------------------------
// attributedBody decoder — NSTypedStream binary → plain text
// ---------------------------------------------------------------------------

/**
 * Extract plain text from the NSTypedStream-encoded NSMutableAttributedString
 * stored in chat.db's `attributedBody` column.
 *
 * The blob starts with \x04\x0bstreamtyped, then class info, then the string
 * value.  Text is length-prefixed using NSTypedStream's compact integer format:
 *   length < 128    → single byte (no marker)
 *   128 ≤ len ≤ 255 → 0x81 [1 byte]
 *   256 ≤ len       → 0x82 [2 bytes big-endian]
 *
 * Observed in the wild: the string is introduced by 0x2b ('+', the NSTypedStream
 * selector/string type), then the compact length, then one flag byte (0x00 or
 * 0x01, probably encoding hint), then the raw UTF-8 bytes.
 *
 * Example: 2b 81 26 01 <38 UTF-8 bytes>
 *          2b 81 af 00 <175 UTF-8 bytes>
 */
function extractTextFromAttributedBody(blob) {
  if (!blob || blob.length < 14) return null;
  // Verify NSTypedStream magic: 04 0b "streamtyped"
  if (blob[0] !== 0x04 || blob[1] !== 0x0b) return null;
  if (blob.slice(2, 13).toString('ascii') !== 'streamtyped')  return null;

  // Only scan the first 500 bytes — the string value is always near the start
  const limit = Math.min(blob.length, 500);

  // Helper: test whether a candidate string looks like message text
  function plausible(s) {
    if (!s || s.length < 1) return false;
    // Reject known binary noise / class name prefixes
    if (/^(NS|CK|UI|__C|stream|attribute)/.test(s)) return false;
    if (s.charCodeAt(0) === 0) return false; // starts with null byte
    // At least 80% of chars must be printable (including emoji which are multi-byte)
    let ok = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) ok++;
    }
    return ok / s.length >= 0.80;
  }

  // NSTypedStream compact integer encoding used for string lengths:
  //   length < 128          → stored as single byte (no marker)
  //   128 ≤ length ≤ 255   → 0x81 [1 byte]
  //   256 ≤ length          → 0x82 [2 bytes big-endian]
  //
  // String intro pattern (observed in iMessage attributedBody):
  //   Direct:   0x2b [len<128]        [UTF-8 text of len bytes]     ← NO flag byte
  //   Extended: 0x2b 0x81 [len] [flag] [UTF-8 text of len bytes]    ← flag = 0x00 or 0x01
  //   Long:     0x2b 0x82 [hi] [lo] [flag] [UTF-8 text]

  for (let i = 13; i < limit - 4; i++) {
    if (blob[i] !== 0x2b) continue;

    const b1 = blob[i + 1];
    let len, textStart;

    if (b1 === 0x81) {
      // Extended 1-byte length: 0x2b 0x81 [len] [flag] [text]
      len = blob[i + 2];
      textStart = i + 4;   // skip: 0x2b, 0x81, len, flag
    } else if (b1 === 0x82) {
      // Extended 2-byte length: 0x2b 0x82 [hi] [lo] [flag] [text]
      len = (blob[i + 2] << 8) | blob[i + 3];
      textStart = i + 5;   // skip: 0x2b, 0x82, hi, lo, flag
    } else if (b1 >= 0x04 && b1 < 0x80) {
      // Direct 1-byte length: 0x2b [len] [text]  — no flag byte
      len = b1;
      textStart = i + 2;   // skip: 0x2b, len
    } else {
      continue;
    }

    if (len < 1 || textStart + len > blob.length) continue;

    try {
      const text = blob.slice(textStart, textStart + len).toString('utf8');
      if (plausible(text)) return text;
    } catch { /* invalid UTF-8, skip */ }
  }

  return null;
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
        SUBSTR(m.attributedBody, 1, 1000) AS attributed_body,
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
        AND m.associated_message_type = 0
        AND (m.text IS NOT NULL OR m.attributedBody IS NOT NULL)
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

      // Resolve text: prefer the plain text column; fall back to attributedBody parse
      let text = (row.text && row.text.trim()) ? row.text.trim() : null;
      if (!text && row.attributed_body) {
        text = extractTextFromAttributedBody(row.attributed_body) || null;
        if (text) text = text.trim();
      }
      // Skip messages with no recoverable text (pure attachments, stickers, etc.)
      if (!text) return null;

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
        text,
        sent_at:   sentAt,
      };
    }).filter(Boolean);
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
          const { emailMap } = getContactsMap();
          for (const e of accountEmails) {
            if (isRealPersonEmail(e.emailAddress, emailMap)) emails.push({ ...e, account: account.email });
          }
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
          INSERT INTO emails (id, run_id, date, direction, contact, email_address, subject, snippet, account)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(crypto.randomUUID(), runId, date, e.direction, e.contact, e.emailAddress || null, e.subject || null, e.snippet || null, e.account || null);
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
function localDateStr(d = new Date()) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function getMissingDates(from) {
  const db = openDb();
  try {
    const today = localDateStr(); // local date, not UTC
    let startDate;
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
      startDate = from;
    } else {
      const last = db.prepare(`SELECT date FROM runs WHERE status='done' ORDER BY date DESC LIMIT 1`).get();
      if (!last) return [today];
      // day after last successful run
      const cursor = new Date(last.date + 'T12:00:00Z');
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      startDate = cursor.toISOString().slice(0, 10);
    }

    const dates = [];
    const cursor = new Date(startDate + 'T12:00:00Z');
    const end    = new Date(today + 'T12:00:00Z');
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

function saveGmailTokens(id, tokens) {
  const db = openDb();
  try {
    db.prepare('UPDATE gmail_accounts SET token_json = ? WHERE id = ?')
      .run(JSON.stringify(tokens), id);
  } finally { db.close(); }
}

// ---------------------------------------------------------------------------
// gloss_contacts — profiles pushed from the notebook app
// ---------------------------------------------------------------------------

function upsertGlossContact(p) {
  if (!p || !p.contact || !p.gloss_id) {
    throw new Error('upsertGlossContact: contact and gloss_id are required');
  }
  const db = openDb();
  try {
    db.prepare(`
      INSERT INTO gloss_contacts (
        contact, aliases, gloss_id, gloss_url,
        mention_count, last_mentioned_at, priority, growth_note,
        recent_context, linked_collections, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(contact) DO UPDATE SET
        aliases            = excluded.aliases,
        gloss_id           = excluded.gloss_id,
        gloss_url          = excluded.gloss_url,
        mention_count      = excluded.mention_count,
        last_mentioned_at  = excluded.last_mentioned_at,
        priority           = excluded.priority,
        growth_note        = excluded.growth_note,
        recent_context     = excluded.recent_context,
        linked_collections = excluded.linked_collections,
        synced_at          = excluded.synced_at
    `).run(
      p.contact,
      JSON.stringify(p.aliases || []),
      p.gloss_id,
      p.gloss_url,
      p.mention_count ?? 0,
      p.last_mentioned_at || null,
      p.priority ?? 0,
      p.growth_note || null,
      JSON.stringify(p.recent_context || []),
      JSON.stringify(p.linked_collections || []),
      new Date().toISOString(),
    );
  } finally { db.close(); }
}

function getGlossContact(contact) {
  const db = openDb();
  try {
    const row = db.prepare('SELECT * FROM gloss_contacts WHERE contact = ? COLLATE NOCASE').get(contact);
    if (!row) {
      // Also try alias match
      const all = db.prepare('SELECT * FROM gloss_contacts WHERE aliases IS NOT NULL').all();
      for (const r of all) {
        try {
          const aliases = JSON.parse(r.aliases || '[]');
          if (aliases.some(a => a.toLowerCase() === contact.toLowerCase())) return hydrateGloss(r);
        } catch {}
      }
      return null;
    }
    return hydrateGloss(row);
  } finally { db.close(); }
}

function hydrateGloss(row) {
  if (!row) return null;
  let recent_context = [];
  let aliases = [];
  let linked_collections = [];
  try { recent_context = JSON.parse(row.recent_context || '[]'); } catch {}
  try { aliases = JSON.parse(row.aliases || '[]'); } catch {}
  try { linked_collections = JSON.parse(row.linked_collections || '[]'); } catch {}
  return { ...row, recent_context, aliases, linked_collections };
}

// Aggregated contact list: everyone we've ever messaged/emailed, plus any
// gloss profile we have. Rows returned sorted by priority DESC, then last
// contact date DESC. Each row: { contact, message_count, email_count,
// last_contact_date, gloss: {...}|null }.
function listContacts({ q = '', limit = 500 } = {}) {
  const db = openDb();
  try {
    const pattern = q ? `%${q}%` : null;
    // Gather per-contact stats from messages + emails, unioned.
    const rows = db.prepare(`
      SELECT contact,
             SUM(msg) AS message_count,
             SUM(eml) AS email_count,
             MAX(last_date) AS last_contact_date
      FROM (
        SELECT contact, COUNT(*) AS msg, 0 AS eml, MAX(date) AS last_date
        FROM messages
        ${pattern ? 'WHERE contact LIKE ? COLLATE NOCASE' : ''}
        GROUP BY contact COLLATE NOCASE
        UNION ALL
        SELECT contact, 0, COUNT(*), MAX(date)
        FROM emails
        ${pattern ? 'WHERE contact LIKE ? COLLATE NOCASE' : ''}
        GROUP BY contact COLLATE NOCASE
      )
      GROUP BY contact COLLATE NOCASE
    `).all(...(pattern ? [pattern, pattern] : []));

    // Also union in any gloss_contacts with zero comms (so priority people with
    // no messages/emails still appear).
    const glossRows = db.prepare(`
      SELECT contact FROM gloss_contacts
      ${pattern ? 'WHERE contact LIKE ? COLLATE NOCASE' : ''}
    `).all(...(pattern ? [pattern] : []));

    const map = new Map();
    for (const r of rows) {
      map.set(r.contact.toLowerCase(), {
        contact: r.contact,
        message_count: r.message_count || 0,
        email_count: r.email_count || 0,
        last_contact_date: r.last_contact_date || null,
      });
    }
    for (const g of glossRows) {
      if (!map.has(g.contact.toLowerCase())) {
        map.set(g.contact.toLowerCase(), {
          contact: g.contact, message_count: 0, email_count: 0, last_contact_date: null,
        });
      }
    }

    // Attach gloss profiles (by contact name OR alias).
    const allGloss = db.prepare('SELECT * FROM gloss_contacts').all().map(hydrateGloss);
    const byName = new Map(allGloss.map(g => [g.contact.toLowerCase(), g]));
    const byAlias = new Map();
    for (const g of allGloss) {
      for (const a of (g.aliases || [])) byAlias.set(a.toLowerCase(), g);
    }

    const result = [];
    for (const row of map.values()) {
      const key = row.contact.toLowerCase();
      const gloss = byName.get(key) || byAlias.get(key) || null;
      result.push({ ...row, gloss });
    }

    result.sort((a, b) => {
      const pa = a.gloss?.priority || 0;
      const pb = b.gloss?.priority || 0;
      if (pa !== pb) return pb - pa;
      const da = a.last_contact_date || '';
      const dbd = b.last_contact_date || '';
      return dbd.localeCompare(da);
    });
    return result.slice(0, limit);
  } finally { db.close(); }
}

// Full contact detail: stats, gloss profile, and last N messages/emails.
function getContactDetail(name, { recentLimit = 50 } = {}) {
  const db = openDb();
  try {
    const stats = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM messages WHERE contact = ? COLLATE NOCASE) AS message_count,
        (SELECT COUNT(*) FROM emails   WHERE contact = ? COLLATE NOCASE) AS email_count,
        (SELECT MIN(date) FROM (
           SELECT MIN(date) date FROM messages WHERE contact = ? COLLATE NOCASE
           UNION ALL
           SELECT MIN(date) date FROM emails   WHERE contact = ? COLLATE NOCASE
         )) AS first_contact_date,
        (SELECT MAX(date) FROM (
           SELECT MAX(date) date FROM messages WHERE contact = ? COLLATE NOCASE
           UNION ALL
           SELECT MAX(date) date FROM emails   WHERE contact = ? COLLATE NOCASE
         )) AS last_contact_date
    `).get(name, name, name, name, name, name);

    const messages = db.prepare(`
      SELECT id, date, direction, sender, text, sent_at, handle_id
      FROM messages WHERE contact = ? COLLATE NOCASE
      ORDER BY sent_at DESC LIMIT ?
    `).all(name, recentLimit);

    const emails = db.prepare(`
      SELECT id, date, direction, contact, email_address, subject, snippet, account
      FROM emails WHERE contact = ? COLLATE NOCASE
      ORDER BY rowid DESC LIMIT ?
    `).all(name, recentLimit);

    const handles = new Set();
    for (const m of messages) if (m.handle_id) handles.add(m.handle_id);
    const emailAddrs = new Set();
    for (const e of emails) if (e.email_address) emailAddrs.add(e.email_address);

    const gloss = getGlossContact(name);
    const insight = db.prepare('SELECT insight, generated_at FROM contact_insights WHERE contact = ? COLLATE NOCASE').get(name);

    return {
      contact: name,
      stats,
      handles: [...handles],
      emails_addrs: [...emailAddrs],
      gloss,
      insight: insight || null,
      messages,
      emails,
    };
  } finally { db.close(); }
}

// Counts + email subjects for the last N days, used as input to the AI.
// Does NOT include message text.
function getRecentCommsForAI(name, days = 30) {
  const db = openDb();
  try {
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
    const stats = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM messages WHERE contact = ? COLLATE NOCASE AND date >= ?) AS message_count_30d,
        (SELECT COUNT(*) FROM emails   WHERE contact = ? COLLATE NOCASE AND date >= ?) AS email_count_30d,
        (SELECT MAX(date) FROM messages WHERE contact = ? COLLATE NOCASE) AS last_message_date,
        (SELECT MAX(date) FROM emails   WHERE contact = ? COLLATE NOCASE) AS last_email_date
    `).get(name, cutoff, name, cutoff, name, name);
    const subjects = db.prepare(`
      SELECT subject FROM emails
      WHERE contact = ? COLLATE NOCASE AND subject IS NOT NULL AND date >= ?
      ORDER BY rowid DESC LIMIT 10
    `).all(name, cutoff).map(r => r.subject);
    return { ...stats, recent_email_subjects: subjects };
  } finally { db.close(); }
}

function saveContactInsight(contact, insight) {
  const db = openDb();
  try {
    db.prepare(`
      INSERT INTO contact_insights (contact, insight, generated_at) VALUES (?, ?, ?)
      ON CONFLICT(contact) DO UPDATE SET insight = excluded.insight, generated_at = excluded.generated_at
    `).run(contact, insight, new Date().toISOString());
  } finally { db.close(); }
}

// ---------------------------------------------------------------------------
// calendar_events
// ---------------------------------------------------------------------------

function upsertCalendarEvents(account, events) {
  if (!events?.length) return 0;
  const db = openDb();
  try {
    const now = new Date().toISOString();
    const stmt = db.prepare(`
      INSERT INTO calendar_events (
        id, calendar_id, account, date, start_time, end_time,
        title, description, location, attendees, html_link, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        calendar_id = excluded.calendar_id,
        account     = excluded.account,
        date        = excluded.date,
        start_time  = excluded.start_time,
        end_time    = excluded.end_time,
        title       = excluded.title,
        description = excluded.description,
        location    = excluded.location,
        attendees   = excluded.attendees,
        html_link   = excluded.html_link,
        synced_at   = excluded.synced_at
    `);
    db.transaction(() => {
      for (const e of events) {
        stmt.run(
          e.id, e.calendar_id || 'primary', account, e.date,
          e.start_time || null, e.end_time || null,
          e.title || '(no title)', e.description || null, e.location || null,
          JSON.stringify(e.attendees || []), e.html_link || null, now,
        );
      }
    })();
    return events.length;
  } finally { db.close(); }
}

// Prune events older than N days past so the table doesn't grow forever.
function pruneOldCalendarEvents(keepPastDays = 2) {
  const db = openDb();
  try {
    const cutoff = new Date(Date.now() - keepPastDays * 86400_000).toISOString().slice(0, 10);
    const r = db.prepare('DELETE FROM calendar_events WHERE date < ?').run(cutoff);
    return r.changes;
  } finally { db.close(); }
}

function listCalendarEvents({ days = 14 } = {}) {
  const db = openDb();
  try {
    const today = localDateStr();
    const end = new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
    const rows = db.prepare(`
      SELECT * FROM calendar_events
      WHERE date >= ? AND date <= ?
      ORDER BY date, start_time
    `).all(today, end);
    return rows.map(hydrateEvent);
  } finally { db.close(); }
}

function getCalendarEvent(id) {
  const db = openDb();
  try {
    const row = db.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id);
    return hydrateEvent(row);
  } finally { db.close(); }
}

function hydrateEvent(row) {
  if (!row) return null;
  let attendees = [];
  try { attendees = JSON.parse(row.attendees || '[]'); } catch {}
  return { ...row, attendees };
}

function getMeetingBrief(eventId) {
  const db = openDb();
  try {
    return db.prepare('SELECT brief, generated_at FROM meeting_briefs WHERE event_id = ?').get(eventId) || null;
  } finally { db.close(); }
}

function saveMeetingBrief(eventId, brief) {
  const db = openDb();
  try {
    db.prepare(`
      INSERT INTO meeting_briefs (event_id, brief, generated_at) VALUES (?, ?, ?)
      ON CONFLICT(event_id) DO UPDATE SET brief = excluded.brief, generated_at = excluded.generated_at
    `).run(eventId, brief, new Date().toISOString());
  } finally { db.close(); }
}

// ---------------------------------------------------------------------------
// Nudges — priority people with no recent contact
// ---------------------------------------------------------------------------

// Return ISO week label like "2026-W17" for a given Date.
function isoWeekOf(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function getNudges() {
  const db = openDb();
  try {
    const week = isoWeekOf();
    const rows = db.prepare(`
      SELECT * FROM gloss_contacts WHERE priority > 0 ORDER BY priority DESC
    `).all().map(hydrateGloss);

    const dismissed = new Set(
      db.prepare('SELECT contact FROM nudge_dismissals WHERE week = ?').all(week).map(r => r.contact.toLowerCase())
    );

    const today = new Date();
    const out = [];
    for (const g of rows) {
      if (dismissed.has(g.contact.toLowerCase())) continue;

      // Most recent comms: check name + all aliases
      const names = [g.contact, ...(g.aliases || [])];
      const placeholders = names.map(() => '? COLLATE NOCASE').join(',');
      const lastDate = db.prepare(`
        SELECT MAX(date) d FROM (
          SELECT MAX(date) date FROM messages WHERE contact IN (${placeholders})
          UNION ALL
          SELECT MAX(date) date FROM emails   WHERE contact IN (${placeholders})
        )
      `).get(...names, ...names)?.d || null;

      let daysSince;
      if (lastDate) {
        daysSince = Math.floor((today - new Date(lastDate + 'T12:00:00')) / 86400000);
      } else {
        daysSince = 999; // never contacted via comms → always nudge
      }

      const threshold = g.priority >= 3 ? 7 : 14;
      if (daysSince < threshold) continue;

      out.push({
        contact: g.contact,
        priority: g.priority,
        days_since_contact: daysSince,
        last_contact_date: lastDate,
        growth_note: g.growth_note,
        gloss_url: g.gloss_url,
      });
    }
    return out;
  } finally { db.close(); }
}

function dismissNudge(contact) {
  const db = openDb();
  try {
    db.prepare(`
      INSERT OR IGNORE INTO nudge_dismissals (contact, week) VALUES (?, ?)
    `).run(contact, isoWeekOf());
  } finally { db.close(); }
}

module.exports = {
  collect, getRuns, getRunDetail, getMissingDates,
  getGmailAccounts, saveGmailAccount, deleteGmailAccount, saveGmailTokens,
  testMessagesAccess,
  // Gloss profiles
  upsertGlossContact, getGlossContact, listContacts, getContactDetail, getRecentCommsForAI,
  saveContactInsight,
  // Calendar
  upsertCalendarEvents, pruneOldCalendarEvents, listCalendarEvents, getCalendarEvent,
  getMeetingBrief, saveMeetingBrief,
  // Nudges
  getNudges, dismissNudge, isoWeekOf,
  DB_PATH,
  // Exported for testing
  extractTextFromAttributedBody, normalizePhone, isRealPersonEmail,
};

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const date = (() => {
    const arg = process.argv[2];
    if (arg && /^\d{4}-\d{2}-\d{2}$/.test(arg)) return arg;
    const d = new Date(); d.setDate(d.getDate() - 1);
    return localDateStr(d); // local date, not UTC
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
