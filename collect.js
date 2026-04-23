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
const { importCalls: importCallsFromSource } = require('./calls');

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

    -- Name-equivalence table: one row per known alias → canonical mapping.
    -- Messages/emails/notes keep their original contact strings (lossless);
    -- queries COALESCE through this table to group variants. Invariant: canonical
    -- is always terminal (never appears in the alias column).
    CREATE TABLE IF NOT EXISTS contact_aliases (
      alias      TEXT PRIMARY KEY COLLATE NOCASE,
      canonical  TEXT NOT NULL COLLATE NOCASE,
      reason     TEXT,
      created_at TEXT NOT NULL
    );

    -- Dismissed merge suggestions — don't resurface these pairs.
    CREATE TABLE IF NOT EXISTS merge_dismissals (
      name_a     TEXT NOT NULL COLLATE NOCASE,
      name_b     TEXT NOT NULL COLLATE NOCASE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (name_a, name_b)
    );

    -- User-authored profile per contact: relationship framing + free-form
    -- notes + follow-up cadence. Unlike gloss_notes (timeline entries) these
    -- are long-lived and only have one row per contact. followup_days = NULL
    -- means "no reminder"; any integer is treated as the staleness threshold.
    CREATE TABLE IF NOT EXISTS contact_profiles (
      contact             TEXT PRIMARY KEY COLLATE NOCASE,
      relationship_type   TEXT,
      personality_notes   TEXT,
      practical_notes     TEXT,
      relationship_goals  TEXT,
      followup_days       INTEGER,
      updated_at          TEXT NOT NULL
    );

    -- User-authored agenda items. Scope is either a person (scope_type='person',
    -- scope_id = contact name) or a specific calendar event (scope_type='event',
    -- scope_id = calendar_events.id). Person-scoped items are what to talk
    -- about next time you see them; event-scoped items belong to that meeting.
    CREATE TABLE IF NOT EXISTS agenda_items (
      id          TEXT PRIMARY KEY,
      scope_type  TEXT NOT NULL,          -- 'person' | 'event'
      scope_id    TEXT NOT NULL COLLATE NOCASE,
      content     TEXT NOT NULL,
      done_at     TEXT,                   -- NULL = open, ISO = checked off
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      sort_index  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_agenda_scope ON agenda_items(scope_type, scope_id COLLATE NOCASE);

    -- Imported address-book contacts (Apple + Google). Separate from the
    -- 'people' derived view — these are "people I know" regardless of whether
    -- we've exchanged messages/emails/meetings. Identifiers go in a child
    -- table so we can look up quickly by email or normalized phone number.
    CREATE TABLE IF NOT EXISTS address_book (
      id                 TEXT PRIMARY KEY,         -- 'source:account:source_id' composite
      source             TEXT NOT NULL,            -- 'apple' | 'google'
      source_account     TEXT NOT NULL,            -- Google account email; 'local' for Apple
      source_id          TEXT NOT NULL,            -- ZUNIQUEID or Google resourceName
      display_name       TEXT,
      given_name         TEXT,
      family_name        TEXT,
      nickname           TEXT,
      organization       TEXT,
      job_title          TEXT,
      emails_json        TEXT NOT NULL DEFAULT '[]',
      phones_json        TEXT NOT NULL DEFAULT '[]',
      photo_url          TEXT,
      notes              TEXT,
      source_modified_at TEXT,
      imported_at        TEXT NOT NULL,
      updated_at         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ab_source  ON address_book(source, source_account);
    CREATE INDEX IF NOT EXISTS idx_ab_display ON address_book(display_name COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS address_book_identifiers (
      address_book_id TEXT NOT NULL,
      kind            TEXT NOT NULL,               -- 'email' | 'phone'
      value           TEXT NOT NULL,               -- normalized: email=lowercase; phone=+E.164 when possible
      label           TEXT,
      PRIMARY KEY (kind, value, address_book_id)
    );
    CREATE INDEX IF NOT EXISTS idx_abi_value ON address_book_identifiers(kind, value);

    -- Tracks per-(source, account) sync runs so the UI can show a last-sync
    -- stamp and surface failures without a separate runs table.
    CREATE TABLE IF NOT EXISTS address_book_sync_log (
      source         TEXT NOT NULL,
      source_account TEXT NOT NULL,
      ran_at         TEXT NOT NULL,
      total          INTEGER NOT NULL DEFAULT 0,
      upserted       INTEGER NOT NULL DEFAULT 0,
      removed        INTEGER NOT NULL DEFAULT 0,
      error          TEXT,
      PRIMARY KEY (source, source_account, ran_at)
    );

    -- User-defined conversation/meeting frameworks for the playbook generator.
    -- Built-in models live in ai.js; these are custom additions. Key is
    -- user-chosen (slug); label is display name; blurb is the framework
    -- description fed into the system prompt.
    CREATE TABLE IF NOT EXISTS playbook_models (
      key        TEXT PRIMARY KEY,
      label      TEXT NOT NULL,
      blurb      TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Notes about a specific contact pushed from Gloss.
    -- One row per (Gloss page, person) mention; Comms just keeps and displays.
    CREATE TABLE IF NOT EXISTS gloss_notes (
      id         TEXT PRIMARY KEY,          -- Gloss block ID
      contact    TEXT NOT NULL COLLATE NOCASE,
      date       TEXT NOT NULL,             -- YYYY-MM-DD
      note       TEXT NOT NULL,
      collection TEXT,
      gloss_url  TEXT,
      synced_at  TEXT NOT NULL
    );

    -- Canonical person registry. One row per real human, unifying address-book
    -- cards (across sources), gloss_contacts, and the free-text contact names
    -- that appear in messages/emails. Rebuilt from the source tables by
    -- rebuildPeople(); merge_lock=1 means a human overrode clustering and the
    -- automatic rebuild should leave it alone.
    CREATE TABLE IF NOT EXISTS people (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      display_name TEXT NOT NULL,
      given_name   TEXT,
      family_name  TEXT,
      merge_lock   INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );

    -- Every name variant known to resolve to a person. Seeded from address_book
    -- (display/given/family/nickname), gloss_contacts (contact + aliases), and
    -- contact_aliases. The resolver (resolvePerson) queries this table.
    CREATE TABLE IF NOT EXISTS people_names (
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      name      TEXT NOT NULL COLLATE NOCASE,
      source    TEXT,
      PRIMARY KEY (person_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_people_names_name ON people_names(name COLLATE NOCASE);

    -- Pairs the user has dismissed as "not the same person". The duplicate
    -- detector consults this so a dismissed pair doesn't keep surfacing.
    -- We always store the lower person_id as person_a so lookups are order-
    -- independent, and keep it keyed on person_id (not signal) so the
    -- dismissal survives merges that happen on adjacent rows.
    CREATE TABLE IF NOT EXISTS rejected_merges (
      person_a    INTEGER NOT NULL,
      person_b    INTEGER NOT NULL,
      rejected_at TEXT NOT NULL,
      PRIMARY KEY (person_a, person_b)
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Special dates: birthdays, anniversaries, deaths, memorials, custom.
    -- Sourced from Apple Contacts, Google Contacts, or entered manually.
    -- contact is NULL for standalone special days (no associated person).
    CREATE TABLE IF NOT EXISTS special_dates (
      id         TEXT PRIMARY KEY,
      contact    TEXT COLLATE NOCASE,
      type       TEXT NOT NULL,      -- 'birthday'|'anniversary'|'death'|'memorial'|'custom'
      month      INTEGER NOT NULL,   -- 1-12
      day        INTEGER NOT NULL,   -- 1-31
      year       INTEGER,            -- NULL if unknown
      label      TEXT,               -- custom label; required for type='custom'
      notes      TEXT,
      source     TEXT NOT NULL DEFAULT 'manual', -- 'apple'|'google'|'manual'
      source_id  TEXT,               -- source record id for dedup on re-sync
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_special_dates_contact  ON special_dates(contact COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_special_dates_month_day ON special_dates(month, day);

    -- macOS phone / FaceTime call history. Sourced from
    -- ~/Library/Application Support/CallHistoryDB/CallHistory.storedata via
    -- calls.js. id is the ZUNIQUE_ID from the source record so re-imports
    -- idempotently upsert.
    CREATE TABLE IF NOT EXISTS calls (
      id               TEXT PRIMARY KEY,
      date             TEXT NOT NULL,           -- YYYY-MM-DD (local)
      contact          TEXT NOT NULL,           -- resolved name, or phone if unknown
      phone            TEXT,                    -- normalized E.164
      direction        TEXT NOT NULL,           -- 'incoming'|'outgoing'|'missed'
      duration_seconds INTEGER,
      answered         INTEGER NOT NULL DEFAULT 1,
      started_at       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_calls_contact ON calls(contact COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_calls_date    ON calls(date);

    CREATE INDEX IF NOT EXISTS idx_messages_date        ON messages(date);
    CREATE INDEX IF NOT EXISTS idx_emails_date          ON emails(date);
    CREATE INDEX IF NOT EXISTS idx_messages_contact     ON messages(contact COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_emails_contact       ON emails(contact COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_calendar_events_date ON calendar_events(date);
    CREATE INDEX IF NOT EXISTS idx_gloss_contacts_prio  ON gloss_contacts(priority DESC);
    CREATE INDEX IF NOT EXISTS idx_gloss_notes_contact  ON gloss_notes(contact COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_contact_aliases_canon ON contact_aliases(canonical COLLATE NOCASE);

    -- Email-helper tables: lazy-cached context per sender, unsub review queue,
    -- and per-run audit log.
    CREATE TABLE IF NOT EXISTS email_contact_context (
      sender_email TEXT PRIMARY KEY,
      context_json TEXT NOT NULL,
      built_at     TEXT NOT NULL,
      stale_after  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS email_unsub_queue (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id       TEXT NOT NULL UNIQUE,
      thread_id        TEXT NOT NULL,
      account          TEXT NOT NULL,
      sender_email     TEXT NOT NULL,
      sender_name      TEXT,
      subject          TEXT,
      list_unsubscribe TEXT,
      classified_as    TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'pending',
      created_at       TEXT NOT NULL DEFAULT (datetime('now')),
      actioned_at      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_email_unsub_status ON email_unsub_queue(status);
    CREATE INDEX IF NOT EXISTS idx_email_unsub_sender ON email_unsub_queue(sender_email);
    CREATE TABLE IF NOT EXISTS email_helper_runs (
      id           TEXT PRIMARY KEY,
      started_at   TEXT NOT NULL,
      ended_at     TEXT,
      summary_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_email_helper_runs_started ON email_helper_runs(started_at DESC);
  `);

  // Migrations for emails table
  const emailCols = db.pragma('table_info(emails)').map(c => c.name);
  if (!emailCols.includes('snippet'))        db.exec('ALTER TABLE emails ADD COLUMN snippet TEXT');
  if (!emailCols.includes('email_address'))  db.exec('ALTER TABLE emails ADD COLUMN email_address TEXT');
  if (!emailCols.includes('thread_id'))      db.exec('ALTER TABLE emails ADD COLUMN thread_id TEXT');

  // Migrations for address_book: link_id (Apple ZLINKID) + person_id FK.
  const abCols = db.pragma('table_info(address_book)').map(c => c.name);
  if (!abCols.includes('link_id'))   db.exec('ALTER TABLE address_book ADD COLUMN link_id TEXT');
  if (!abCols.includes('person_id')) db.exec('ALTER TABLE address_book ADD COLUMN person_id INTEGER REFERENCES people(id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_address_book_person ON address_book(person_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_address_book_link   ON address_book(link_id)');

  // Migration for gloss_contacts: person_id FK.
  const gcCols = db.pragma('table_info(gloss_contacts)').map(c => c.name);
  if (!gcCols.includes('person_id')) db.exec('ALTER TABLE gloss_contacts ADD COLUMN person_id INTEGER REFERENCES people(id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_gloss_contacts_person ON gloss_contacts(person_id)');

  // Migration for runs: calls_count.
  const runCols = db.pragma('table_info(runs)').map(c => c.name);
  if (!runCols.includes('calls_count')) db.exec('ALTER TABLE runs ADD COLUMN calls_count INTEGER DEFAULT 0');

  // Migration for people: last_reviewed_at (Feature 3).
  const peopleCols = db.pragma('table_info(people)').map(c => c.name);
  if (!peopleCols.includes('last_reviewed_at')) db.exec('ALTER TABLE people ADD COLUMN last_reviewed_at TEXT');

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

/**
 * Import macOS call-history records from CallHistory.storedata.
 * Idempotent: keyed on the source UUID (ZUNIQUE_ID). Pulls records from
 * (date - 2 days) onward to tolerate slight clock drift and cross-device
 * sync delay from iCloud call-history, then inserts any new ones.
 *
 * Resolves phone → contact via findAddressBookByIdentifiers; falls back to
 * the source row's name hint, then the raw phone number.
 *
 * Returns { total: recordsRead, imported: newlyInserted }.
 */
function collectCalls(date) {
  // Lookback gives iCloud-synced calls from other devices a chance to land.
  let since = null;
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const d = new Date(date + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 2);
    since = d.toISOString();
  }

  const db = openDb();
  try {
    const existing = db.prepare('SELECT id FROM calls WHERE id = ?');
    const insert = db.prepare(`
      INSERT INTO calls (id, date, contact, phone, direction, duration_seconds, answered, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let imported = 0;
    const res = importCallsFromSource({
      since,
      upsertCall: (row) => {
        if (existing.get(row.id)) return; // already imported — skip
        // Resolve a name via the address book.
        let contactName = null;
        if (row.phone) {
          try {
            const matches = findAddressBookByIdentifiers({ phones: [row.phone] });
            if (matches.length) {
              const m = matches[0];
              contactName = (m.display_name ||
                [m.given_name, m.family_name].filter(Boolean).join(' ') ||
                null);
            }
          } catch { /* resolver is best-effort */ }
        }
        if (!contactName) contactName = row.name_hint || row.phone_raw || row.phone || 'Unknown';
        insert.run(
          row.id,
          row.date,
          contactName,
          row.phone,
          row.direction,
          row.duration_seconds,
          row.answered,
          row.iso,
        );
        imported++;
      },
    });
    return { total: res.total, imported };
  } finally {
    db.close();
  }
}

async function collect(date, { onProgress } = {}) {
  const emit = onProgress || (() => {});
  const db   = openDb();

  db.prepare('DELETE FROM runs WHERE date = ?').run(date);
  const runId = crypto.randomUUID();
  db.prepare(`INSERT INTO runs (id, date, collected_at, status) VALUES (?, ?, ?, 'running')`)
    .run(runId, date, new Date().toISOString());

  let messages = [], emails = [], callsImported = 0;
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
          INSERT INTO emails (id, run_id, date, direction, contact, email_address, subject, snippet, account, thread_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(crypto.randomUUID(), runId, date, e.direction, e.contact, e.emailAddress || null, e.subject || null, e.snippet || null, e.account || null, e.threadId || null);
      }
      db.prepare(`UPDATE runs SET status='done', messages_count=?, emails_count=? WHERE id=?`)
        .run(messages.length, emails.length, runId);
    })();

    // Calls — run after messages/emails so the address-book resolver can pick
    // up any handles picked up in this run. Failures here are warnings, not
    // fatal: the main run is already marked 'done'.
    emit({ step: 'calls', status: 'running' });
    try {
      const res = collectCalls(date);
      callsImported = res.imported;
      db.prepare('UPDATE runs SET calls_count = ? WHERE id = ?').run(callsImported, runId);
      emit({ step: 'calls', status: 'done', count: callsImported });
    } catch (err) {
      warnings.push(err.fullDiskAccessRequired
        ? `Calls: ${err.message}`
        : `Calls: ${err.message}`);
      emit({
        step: 'calls', status: 'error', error: err.message,
        fullDiskAccessRequired: !!err.fullDiskAccessRequired,
      });
    }

    emit({ step: 'done', messages: messages.length, emails: emails.length, calls: callsImported, warnings });
    return { ok: true, runId, date, messages, emails, calls: callsImported, warnings };

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

// Internal variant — includes token_json for code that actually needs to
// authenticate against Google APIs. Callers must NEVER return this shape
// to clients. Use getGmailAccounts() for any /api/* response.
function getGmailAccountsWithTokens() {
  const db = openDb();
  try { return db.prepare('SELECT id, email, token_json, added_at FROM gmail_accounts ORDER BY added_at').all(); }
  finally { db.close(); }
}

function getGmailAccounts() {
  const db = openDb();
  // NEVER expose token_json in list results — OAuth tokens are secrets.
  // Callers that need tokens should use getGmailTokens(id) explicitly.
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
    const info = db.prepare('UPDATE gmail_accounts SET token_json = ? WHERE id = ?')
      .run(JSON.stringify(tokens), id);
    if (info.changes === 0) {
      throw new Error(`saveGmailTokens: no gmail_accounts row matched id=${id}`);
    }
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

// ---------------------------------------------------------------------------
// gloss_notes — notes about a contact pushed from Gloss
// ---------------------------------------------------------------------------

function upsertGlossNote(n) {
  if (!n || !n.id || !n.contact || !n.date || !n.note) {
    throw new Error('upsertGlossNote: id, contact, date, and note are required');
  }
  const db = openDb();
  try {
    db.prepare(`
      INSERT INTO gloss_notes (id, contact, date, note, collection, gloss_url, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        contact    = excluded.contact,
        date       = excluded.date,
        note       = excluded.note,
        collection = excluded.collection,
        gloss_url  = excluded.gloss_url,
        synced_at  = excluded.synced_at
    `).run(
      n.id, n.contact, n.date, n.note,
      n.collection || null, n.gloss_url || null,
      new Date().toISOString(),
    );
  } finally { db.close(); }
}

// Aggregated contact list: everyone we've ever messaged/emailed, plus any
// gloss profile we have. Rows returned sorted by priority DESC, then last
// contact date DESC. Each row: { contact, message_count, email_count,
// last_contact_date, gloss: {...}|null }.
function listContacts({ q = '', limit = 500 } = {}) {
  const db = openDb();
  try {
    const pattern = q ? `%${q}%` : null;
    // Gather per-contact stats from messages + emails, unioned. Raw keys are
    // name strings as stored in those tables; we roll them up to people below.
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

    // Look up the person_id for every comms name in one shot, so we can roll
    // multiple name variants up into a single row.
    const nameToPerson = new Map();
    if (rows.length || glossRows.length) {
      const allNames = new Set([
        ...rows.map(r => r.contact),
        ...glossRows.map(g => g.contact),
      ]);
      const nameArr = [...allNames];
      if (nameArr.length) {
        const ph = nameArr.map(() => '?').join(',');
        const hits = db.prepare(`
          SELECT name, person_id FROM people_names WHERE name IN (${ph}) COLLATE NOCASE
        `).all(...nameArr);
        // A name might resolve to multiple people (rare — usually ambiguous
        // given names). Prefer a unique match; otherwise treat as unresolved.
        const byName = new Map();
        for (const h of hits) {
          if (!byName.has(h.name.toLowerCase())) byName.set(h.name.toLowerCase(), new Set());
          byName.get(h.name.toLowerCase()).add(h.person_id);
        }
        for (const [n, set] of byName.entries()) {
          if (set.size === 1) nameToPerson.set(n, [...set][0]);
        }
      }
    }

    // Keyed rollup: person_id if resolved, else 'name:<raw>' so unresolved
    // comms names still surface under their own row.
    const map = new Map();
    const keyFor = rawName => {
      const pid = nameToPerson.get(rawName.toLowerCase());
      return pid ? `p:${pid}` : `name:${rawName.toLowerCase()}`;
    };
    const ensure = (key, seedContact) => {
      if (!map.has(key)) {
        map.set(key, {
          contact: seedContact,
          person_id: key.startsWith('p:') ? Number(key.slice(2)) : null,
          message_count: 0,
          email_count: 0,
          last_contact_date: null,
          ab_count: 0,
          ab_sources: [],
        });
      }
      return map.get(key);
    };
    for (const r of rows) {
      const row = ensure(keyFor(r.contact), r.contact);
      row.message_count += r.message_count || 0;
      row.email_count   += r.email_count   || 0;
      if (r.last_contact_date && (!row.last_contact_date || r.last_contact_date > row.last_contact_date)) {
        row.last_contact_date = r.last_contact_date;
      }
    }
    for (const g of glossRows) ensure(keyFor(g.contact), g.contact);

    // Union in address-book-linked people (including those with zero comms so
    // imported-only contacts now surface in the main list — this is the
    // "fold AB into Contacts" change the UI relies on).
    const abPeople = db.prepare(`
      SELECT p.id AS person_id, p.display_name,
             COUNT(ab.id) AS ab_count,
             GROUP_CONCAT(DISTINCT ab.source) AS sources
      FROM people p
      LEFT JOIN address_book ab ON ab.person_id = p.id
      ${pattern ? 'WHERE p.display_name LIKE ? COLLATE NOCASE' : ''}
      GROUP BY p.id
    `).all(...(pattern ? [pattern] : []));
    for (const ap of abPeople) {
      const key = `p:${ap.person_id}`;
      const row = ensure(key, ap.display_name);
      row.person_id = ap.person_id;
      row.ab_count = ap.ab_count || 0;
      row.ab_sources = ap.sources ? ap.sources.split(',') : [];
      // If comms rolled this person up under a variant like "Abi", keep the
      // canonical display_name from people for a cleaner list label.
      if (ap.display_name) row.contact = ap.display_name;
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
//
// Name variants: we resolve the input name to a person (when unambiguous) and
// expand every name-keyed query to `contact IN (…all variants…)`. That's how
// "Abigail Colestock" surfaces gloss notes written under "Abi" — without
// rewriting message ingestion. If no person resolves (new contact, ambiguous
// name), we fall back to the single-name query so nothing regresses.
function getContactDetail(name, { recentLimit = 50 } = {}) {
  const db = openDb();
  try {
    const person = _resolvePersonRaw(db, name);
    const names = person ? person.names : [name];
    // Ensure the requested name is always in the set even if it's case-shifted.
    if (!names.some(n => n.toLowerCase() === name.toLowerCase())) names.push(name);
    const ph = names.map(() => '?').join(',');
    const nameArgs = names;

    const stats = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM messages WHERE contact IN (${ph}) COLLATE NOCASE) AS message_count,
        (SELECT COUNT(*) FROM emails   WHERE contact IN (${ph}) COLLATE NOCASE) AS email_count,
        (SELECT COUNT(*) FROM calls    WHERE contact IN (${ph}) COLLATE NOCASE) AS call_count,
        (SELECT MIN(date) FROM (
           SELECT MIN(date) date FROM messages WHERE contact IN (${ph}) COLLATE NOCASE
           UNION ALL
           SELECT MIN(date) date FROM emails   WHERE contact IN (${ph}) COLLATE NOCASE
           UNION ALL
           SELECT MIN(date) date FROM calls    WHERE contact IN (${ph}) COLLATE NOCASE
         )) AS first_contact_date,
        (SELECT MAX(date) FROM (
           SELECT MAX(date) date FROM messages WHERE contact IN (${ph}) COLLATE NOCASE
           UNION ALL
           SELECT MAX(date) date FROM emails   WHERE contact IN (${ph}) COLLATE NOCASE
           UNION ALL
           SELECT MAX(date) date FROM calls    WHERE contact IN (${ph}) COLLATE NOCASE
         )) AS last_contact_date
    `).get(...nameArgs, ...nameArgs, ...nameArgs, ...nameArgs, ...nameArgs, ...nameArgs, ...nameArgs, ...nameArgs, ...nameArgs);

    const messages = db.prepare(`
      SELECT id, date, direction, sender, text, sent_at, handle_id
      FROM messages WHERE contact IN (${ph}) COLLATE NOCASE
      ORDER BY sent_at DESC LIMIT ?
    `).all(...nameArgs, recentLimit);

    const emails = db.prepare(`
      SELECT id, date, direction, contact, email_address, subject, snippet, account, thread_id
      FROM emails WHERE contact IN (${ph}) COLLATE NOCASE
      ORDER BY rowid DESC LIMIT ?
    `).all(...nameArgs, recentLimit);

    const calls = db.prepare(`
      SELECT id, date, direction, duration_seconds, answered, started_at, phone, contact
      FROM calls WHERE contact IN (${ph}) COLLATE NOCASE
      ORDER BY started_at DESC LIMIT ?
    `).all(...nameArgs, recentLimit);

    const handles = new Set();
    for (const m of messages) if (m.handle_id) handles.add(m.handle_id);

    // Pull ALL distinct addresses this contact has ever emailed from/to — the
    // recent-N slice would miss older aliases, and calendar matching needs
    // every address to find past meetings (e.g. personal gmail vs work domain).
    const emailAddrs = new Set(
      db.prepare(`SELECT DISTINCT email_address FROM emails WHERE contact IN (${ph}) COLLATE NOCASE AND email_address IS NOT NULL`)
        .all(...nameArgs).map(r => r.email_address)
    );

    // Gloss profile: prefer the person's own gloss_contact row(s); fall back
    // to name-based lookup for pre-link data.
    let gloss = null;
    if (person) {
      const gr = db.prepare('SELECT * FROM gloss_contacts WHERE person_id = ?').get(person.person_id);
      if (gr) gloss = hydrateGloss(gr);
    }
    if (!gloss) gloss = getGlossContact(name);

    // Insight is still single-name-keyed; try each variant for a hit.
    let insight = null;
    for (const n of names) {
      insight = db.prepare('SELECT insight, generated_at FROM contact_insights WHERE contact = ? COLLATE NOCASE').get(n);
      if (insight) break;
    }

    // Calendar events where this contact appears as an attendee. Match by any
    // known name variant OR any known email address for the contact.
    // SQL LIKE is a broad pre-filter; JS post-filter requires an exact attendee
    // name or email match to prevent false positives (e.g. "Tom Dodds" matching
    // the "Dodds" name variant of "Elianna Dodds").
    const calLikes = names.map(n => `%${n.toLowerCase()}%`);
    for (const addr of emailAddrs) {
      if (addr) calLikes.push(`%${addr.toLowerCase()}%`);
    }
    const nameLower = new Set(names.map(n => n.toLowerCase()));
    const addrLower = new Set([...emailAddrs].filter(Boolean).map(a => a.toLowerCase()));
    const calWhere = calLikes.map(() => 'lower(attendees) LIKE ?').join(' OR ');
    const calendarEvents = db.prepare(`
      SELECT id, date, start_time, end_time, title, attendees, html_link
      FROM calendar_events
      WHERE ${calWhere}
      ORDER BY date DESC, start_time DESC
      LIMIT 100
    `).all(...calLikes).map(hydrateEvent).filter(ev => {
      return ev.attendees.some(a => {
        if (a.email && addrLower.has(a.email.toLowerCase())) return true;
        if (a.name && nameLower.has(a.name.toLowerCase())) return true;
        return false;
      });
    }).slice(0, 30);

    const glossNotes = db.prepare(`
      SELECT id, date, note, collection, gloss_url
      FROM gloss_notes
      WHERE contact IN (${ph}) COLLATE NOCASE
      ORDER BY date DESC
      LIMIT 50
    `).all(...nameArgs);

    // Profile: try each variant, return the first hit.
    let profile = null;
    for (const n of names) {
      profile = db.prepare(`
        SELECT contact, relationship_type, personality_notes, practical_notes,
               relationship_goals, followup_days, updated_at
        FROM contact_profiles WHERE contact = ? COLLATE NOCASE
      `).get(n);
      if (profile) break;
    }

    // Special dates — birthdays, anniversaries, etc. Dedup by (type, month, day)
    // because Apple + Google sync the same birthday twice (one row per source).
    const rawSpecialDates = db.prepare(`
      SELECT * FROM special_dates
      WHERE contact IN (${ph}) COLLATE NOCASE
      ORDER BY month, day
    `).all(...nameArgs);
    const specialDates = [];
    const sdSeen = new Set();
    for (const r of rawSpecialDates) {
      const k = `${r.type}:${r.month}:${r.day}:${r.year || ''}`;
      if (sdSeen.has(k)) continue;
      sdSeen.add(k);
      specialDates.push(r);
    }

    // Unified chronological timeline — messages + emails + calls + gloss
    // notes + calendar events. Each row tagged with a `kind` so the UI can
    // pick a badge/renderer; `ts` is the sort key (ISO datetime or date).
    const timeline = [];
    for (const m of messages) {
      timeline.push({ kind: 'message', ts: m.sent_at || m.date, date: m.date, data: m });
    }
    for (const e of emails) {
      timeline.push({ kind: 'email', ts: e.date, date: e.date, data: e });
    }
    for (const c of calls) {
      timeline.push({ kind: 'call', ts: c.started_at || c.date, date: c.date, data: c });
    }
    timeline.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));

    return {
      contact: name,
      person_id: person ? person.person_id : null,
      name_variants: names,
      stats,
      handles: [...handles],
      emails_addrs: [...emailAddrs],
      gloss,
      insight: insight || null,
      messages,
      emails,
      calls,
      calendar_events: calendarEvents,
      gloss_notes: glossNotes,
      profile: profile || null,
      special_dates: specialDates,
      timeline,
    };
  } finally { db.close(); }
}

function _resolvePersonRaw(db, name) {
  if (!name) return null;
  const hits = db.prepare('SELECT person_id FROM people_names WHERE name = ? COLLATE NOCASE').all(name);
  const unique = new Set(hits.map(h => h.person_id));
  if (unique.size !== 1) return null;
  const person_id = [...unique][0];
  const names = db.prepare('SELECT DISTINCT name FROM people_names WHERE person_id = ?').all(person_id).map(r => r.name);
  return { person_id, names };
}

// ---------------------------------------------------------------------------
// contact_profiles — user-authored profile + followup cadence
// ---------------------------------------------------------------------------

function getContactProfile(name) {
  const db = openDb();
  try {
    return db.prepare(`
      SELECT contact, relationship_type, personality_notes, practical_notes,
             relationship_goals, followup_days, updated_at
      FROM contact_profiles WHERE contact = ? COLLATE NOCASE
    `).get(name) || null;
  } finally { db.close(); }
}

// Patch semantics: only keys present in `patch` are updated; missing keys
// are untouched. Empty string clears a text field; null clears followup_days.
function saveContactProfile(name, patch = {}) {
  if (!name) throw new Error('saveContactProfile: name is required');
  const db = openDb();
  try {
    const now = new Date().toISOString();
    const existing = db.prepare('SELECT * FROM contact_profiles WHERE contact = ? COLLATE NOCASE').get(name);
    const row = existing || { contact: name };
    const textFields = ['relationship_type', 'personality_notes', 'practical_notes', 'relationship_goals'];
    for (const k of textFields) {
      if (k in patch) row[k] = (patch[k] === '' || patch[k] == null) ? null : String(patch[k]);
    }
    if ('followup_days' in patch) {
      const v = patch.followup_days;
      if (v === null || v === '' || v === undefined) row.followup_days = null;
      else {
        const n = Number(v);
        row.followup_days = (Number.isFinite(n) && n > 0) ? Math.round(n) : null;
      }
    }
    db.prepare(`
      INSERT INTO contact_profiles
        (contact, relationship_type, personality_notes, practical_notes,
         relationship_goals, followup_days, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(contact) DO UPDATE SET
        relationship_type  = excluded.relationship_type,
        personality_notes  = excluded.personality_notes,
        practical_notes    = excluded.practical_notes,
        relationship_goals = excluded.relationship_goals,
        followup_days      = excluded.followup_days,
        updated_at         = excluded.updated_at
    `).run(
      name,
      row.relationship_type ?? null,
      row.personality_notes ?? null,
      row.practical_notes ?? null,
      row.relationship_goals ?? null,
      row.followup_days ?? null,
      now,
    );
    return getContactProfile(name);
  } finally { db.close(); }
}

// Rename a contact across all tables that key by contact name. The people
// table display_name is updated only when it matches oldName exactly
// (case-insensitive) so a manually-set display_name isn't clobbered.
// The new name is added to people_names so search and de-dup still work.
function renameContact(oldName, newName) {
  if (!oldName || !newName) throw new Error('renameContact: both names required');
  const trimmed = String(newName).trim();
  if (!trimmed) throw new Error('renameContact: newName cannot be blank');
  if (trimmed.toLowerCase() === String(oldName).trim().toLowerCase()) return { ok: true, noChange: true };

  const db = openDb();
  try {
    const txn = db.transaction(() => {
      const now = new Date().toISOString();

      // Raw comms — simple column renames
      db.prepare('UPDATE messages      SET contact  = ? WHERE contact  = ? COLLATE NOCASE').run(trimmed, oldName);
      db.prepare('UPDATE emails        SET contact  = ? WHERE contact  = ? COLLATE NOCASE').run(trimmed, oldName);
      db.prepare('UPDATE contacts      SET contact  = ? WHERE contact  = ? COLLATE NOCASE').run(trimmed, oldName);

      // Agenda items (person-scoped)
      db.prepare("UPDATE agenda_items SET scope_id = ? WHERE scope_type = 'person' AND scope_id = ? COLLATE NOCASE").run(trimmed, oldName);

      // Special dates
      db.prepare('UPDATE special_dates SET contact = ? WHERE contact = ? COLLATE NOCASE').run(trimmed, oldName);

      // Nudge dismissals (composite PK — move rows rather than UPDATE)
      const nudgeWeeks = db.prepare('SELECT week FROM nudge_dismissals WHERE contact = ? COLLATE NOCASE').all(oldName).map(r => r.week);
      for (const week of nudgeWeeks) {
        db.prepare('INSERT OR IGNORE INTO nudge_dismissals (contact, week) VALUES (?, ?)').run(trimmed, week);
      }
      db.prepare('DELETE FROM nudge_dismissals WHERE contact = ? COLLATE NOCASE').run(oldName);

      // contact_aliases: rename alias rows; update canonical references
      const aliasRow = db.prepare('SELECT canonical, reason, created_at FROM contact_aliases WHERE alias = ? COLLATE NOCASE').get(oldName);
      if (aliasRow) {
        db.prepare('INSERT OR REPLACE INTO contact_aliases (alias, canonical, reason, created_at) VALUES (?, ?, ?, ?)').run(trimmed, aliasRow.canonical, aliasRow.reason, aliasRow.created_at);
        db.prepare('DELETE FROM contact_aliases WHERE alias = ? COLLATE NOCASE').run(oldName);
      }
      db.prepare('UPDATE contact_aliases SET canonical = ? WHERE canonical = ? COLLATE NOCASE').run(trimmed, oldName);

      // contact_profiles (PK): if newName profile doesn't exist yet, rename; otherwise drop oldName copy
      const hasOldProfile = !!db.prepare('SELECT 1 FROM contact_profiles WHERE contact = ? COLLATE NOCASE').get(oldName);
      const hasNewProfile = !!db.prepare('SELECT 1 FROM contact_profiles WHERE contact = ? COLLATE NOCASE').get(trimmed);
      if (hasOldProfile) {
        if (!hasNewProfile) {
          db.prepare('UPDATE contact_profiles SET contact = ?, updated_at = ? WHERE contact = ? COLLATE NOCASE').run(trimmed, now, oldName);
        } else {
          db.prepare('DELETE FROM contact_profiles WHERE contact = ? COLLATE NOCASE').run(oldName);
        }
      }

      // contact_insights (PK): same PK-rename pattern
      const hasOldInsight = !!db.prepare('SELECT 1 FROM contact_insights WHERE contact = ? COLLATE NOCASE').get(oldName);
      const hasNewInsight = !!db.prepare('SELECT 1 FROM contact_insights WHERE contact = ? COLLATE NOCASE').get(trimmed);
      if (hasOldInsight) {
        if (!hasNewInsight) {
          db.prepare('UPDATE contact_insights SET contact = ? WHERE contact = ? COLLATE NOCASE').run(trimmed, oldName);
        } else {
          db.prepare('DELETE FROM contact_insights WHERE contact = ? COLLATE NOCASE').run(oldName);
        }
      }

      // people: update display_name only when it still matches oldName (case-insensitive)
      const person = _resolvePersonRaw(db, oldName);
      if (person) {
        db.prepare('UPDATE people SET display_name = ?, updated_at = ? WHERE id = ? AND display_name = ? COLLATE NOCASE')
          .run(trimmed, now, person.person_id, oldName);
        db.prepare('INSERT OR IGNORE INTO people_names (person_id, name, source) VALUES (?, ?, ?)').run(person.person_id, trimmed, 'manual');
      }
    });
    txn();
    return { ok: true, oldName, newName: trimmed };
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
    const glossRows = db.prepare(`
      SELECT * FROM gloss_contacts WHERE priority > 0 ORDER BY priority DESC
    `).all().map(hydrateGloss);
    const profileRows = db.prepare(`
      SELECT contact, relationship_type, followup_days
      FROM contact_profiles WHERE followup_days IS NOT NULL AND followup_days > 0
    `).all();

    const dismissed = new Set(
      db.prepare('SELECT contact FROM nudge_dismissals WHERE week = ?').all(week).map(r => r.contact.toLowerCase())
    );

    const today = new Date();
    const seen = new Set(); // lowercased canonical — one nudge per person even if both sources match
    const out = [];

    const lastContactFor = (names) => {
      const placeholders = names.map(() => '? COLLATE NOCASE').join(',');
      return db.prepare(`
        SELECT MAX(date) d FROM (
          SELECT MAX(date) date FROM messages WHERE contact IN (${placeholders})
          UNION ALL
          SELECT MAX(date) date FROM emails   WHERE contact IN (${placeholders})
        )
      `).get(...names, ...names)?.d || null;
    };
    const daysSinceOf = (lastDate) => {
      if (!lastDate) return 999;
      return Math.floor((today - new Date(lastDate + 'T12:00:00')) / 86400000);
    };

    // Profile-driven nudges take precedence — the user set an explicit cadence.
    for (const p of profileRows) {
      const key = p.contact.toLowerCase();
      if (dismissed.has(key) || seen.has(key)) continue;
      const lastDate = lastContactFor([p.contact]);
      const daysSince = daysSinceOf(lastDate);
      if (daysSince < p.followup_days) continue;
      seen.add(key);
      out.push({
        contact: p.contact,
        source: 'profile',
        followup_days: p.followup_days,
        relationship_type: p.relationship_type || null,
        days_since_contact: daysSince,
        last_contact_date: lastDate,
      });
    }

    // Gloss-priority nudges fill in for people the user hasn't explicitly
    // scheduled but who are tagged priority>=1 in the notebook.
    for (const g of glossRows) {
      const key = g.contact.toLowerCase();
      if (dismissed.has(key) || seen.has(key)) continue;
      const names = [g.contact, ...(g.aliases || [])];
      const lastDate = lastContactFor(names);
      const daysSince = daysSinceOf(lastDate);
      const threshold = g.priority >= 3 ? 7 : 14;
      if (daysSince < threshold) continue;
      seen.add(key);
      out.push({
        contact: g.contact,
        source: 'gloss',
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

// ---------------------------------------------------------------------------
// agenda_items — person- and event-scoped reminders the user leaves for
// themselves. Read by the meeting-prep synthesizer; never AI-generated.
// ---------------------------------------------------------------------------

function listAgendaItems(scopeType, scopeId, { includeDone = true } = {}) {
  if (!scopeType || !scopeId) throw new Error('listAgendaItems: scope required');
  const db = openDb();
  try {
    const where = includeDone ? '' : 'AND done_at IS NULL';
    return db.prepare(`
      SELECT id, scope_type, scope_id, content, done_at, created_at, updated_at, sort_index
      FROM agenda_items
      WHERE scope_type = ? AND scope_id = ? COLLATE NOCASE ${where}
      ORDER BY done_at IS NOT NULL, sort_index, created_at
    `).all(scopeType, scopeId);
  } finally { db.close(); }
}

function addAgendaItem(scopeType, scopeId, content) {
  if (!scopeType || !scopeId) throw new Error('addAgendaItem: scope required');
  if (!content || !String(content).trim()) throw new Error('addAgendaItem: content required');
  const db = openDb();
  try {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const maxIdx = db.prepare('SELECT COALESCE(MAX(sort_index), 0) mx FROM agenda_items WHERE scope_type = ? AND scope_id = ? COLLATE NOCASE').get(scopeType, scopeId)?.mx ?? 0;
    db.prepare(`
      INSERT INTO agenda_items (id, scope_type, scope_id, content, done_at, created_at, updated_at, sort_index)
      VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
    `).run(id, scopeType, scopeId, String(content).trim(), now, now, maxIdx + 1);
    return db.prepare('SELECT * FROM agenda_items WHERE id = ?').get(id);
  } finally { db.close(); }
}

function updateAgendaItem(id, patch = {}) {
  const db = openDb();
  try {
    const row = db.prepare('SELECT * FROM agenda_items WHERE id = ?').get(id);
    if (!row) throw new Error('agenda item not found');
    const now = new Date().toISOString();
    if ('content' in patch) row.content = String(patch.content).trim();
    if ('done' in patch) row.done_at = patch.done ? (row.done_at || now) : null;
    if ('sort_index' in patch) row.sort_index = Number(patch.sort_index) || 0;
    db.prepare(`UPDATE agenda_items SET content = ?, done_at = ?, sort_index = ?, updated_at = ? WHERE id = ?`)
      .run(row.content, row.done_at, row.sort_index, now, id);
    return db.prepare('SELECT * FROM agenda_items WHERE id = ?').get(id);
  } finally { db.close(); }
}

function deleteAgendaItem(id) {
  const db = openDb();
  try { db.prepare('DELETE FROM agenda_items WHERE id = ?').run(id); }
  finally { db.close(); }
}

// ---------------------------------------------------------------------------
// Custom playbook models — user-defined conversation frameworks that extend
// the built-in catalog in ai.js. Key format: lowercase slug.
// ---------------------------------------------------------------------------

function listCustomPlaybookModels() {
  const db = openDb();
  try {
    return db.prepare('SELECT key, label, blurb, created_at, updated_at FROM playbook_models ORDER BY label').all();
  } finally { db.close(); }
}

function getCustomPlaybookModel(key) {
  if (!key) return null;
  const db = openDb();
  try {
    return db.prepare('SELECT key, label, blurb, created_at, updated_at FROM playbook_models WHERE key = ?').get(key) || null;
  } finally { db.close(); }
}

function saveCustomPlaybookModel({ key, label, blurb, originalKey }) {
  const k = String(key || '').trim().toLowerCase();
  const l = String(label || '').trim();
  const b = String(blurb || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(k)) {
    throw new Error('key must be a lowercase slug (letters, digits, dashes), 2-64 chars');
  }
  if (!l) throw new Error('label is required');
  if (!b) throw new Error('blurb is required');

  const db = openDb();
  const now = new Date().toISOString();
  try {
    const renaming = originalKey && originalKey !== k;
    if (renaming) {
      const exists = db.prepare('SELECT key FROM playbook_models WHERE key = ?').get(k);
      if (exists) throw new Error(`key "${k}" already exists`);
      db.prepare('UPDATE playbook_models SET key = ?, label = ?, blurb = ?, updated_at = ? WHERE key = ?')
        .run(k, l, b, now, originalKey);
    } else {
      db.prepare(`
        INSERT INTO playbook_models (key, label, blurb, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET label = excluded.label, blurb = excluded.blurb, updated_at = excluded.updated_at
      `).run(k, l, b, now, now);
    }
    return db.prepare('SELECT key, label, blurb, created_at, updated_at FROM playbook_models WHERE key = ?').get(k);
  } finally { db.close(); }
}

function deleteCustomPlaybookModel(key) {
  const db = openDb();
  try { db.prepare('DELETE FROM playbook_models WHERE key = ?').run(key); }
  finally { db.close(); }
}

// ---------------------------------------------------------------------------
// Address book — imported contacts from Apple Contacts + Google Contacts.
// Identifiers (emails / phones) get their own table for fast reverse-lookup.
// Phone normalization uses the same `normalizePhone` rule as iMessage
// ingestion (US country code dropped, bare digits) so lookups join cleanly.
// ---------------------------------------------------------------------------

function _normalizeEmailForIndex(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  return s && s.includes('@') ? s : null;
}

function _normalizePhoneForIndex(raw) {
  return normalizePhone(raw);
}

function upsertAddressBookContact(rec) {
  if (!rec || !rec.source || !rec.source_account || !rec.source_id) {
    throw new Error('upsertAddressBookContact: source, source_account, source_id required');
  }
  const id = `${rec.source}:${rec.source_account}:${rec.source_id}`;
  const now = new Date().toISOString();

  const emails = Array.isArray(rec.emails) ? rec.emails : [];
  const phones = Array.isArray(rec.phones) ? rec.phones : [];

  const displayName = (rec.display_name ||
    [rec.given_name, rec.family_name].filter(Boolean).join(' ') ||
    rec.nickname || rec.organization || emails[0]?.value || phones[0]?.value || '(unnamed)').trim();

  const db = openDb();
  try {
    const txn = db.transaction(() => {
      const existing = db.prepare('SELECT id FROM address_book WHERE id = ?').get(id);
      if (existing) {
        db.prepare(`
          UPDATE address_book SET
            display_name=?, given_name=?, family_name=?, nickname=?,
            organization=?, job_title=?, emails_json=?, phones_json=?,
            photo_url=?, notes=?, source_modified_at=?, link_id=?, updated_at=?
          WHERE id = ?
        `).run(
          displayName, rec.given_name || null, rec.family_name || null, rec.nickname || null,
          rec.organization || null, rec.job_title || null,
          JSON.stringify(emails), JSON.stringify(phones),
          rec.photo_url || null, rec.notes || null,
          rec.source_modified_at || null, rec.link_id || null, now, id
        );
      } else {
        db.prepare(`
          INSERT INTO address_book
            (id, source, source_account, source_id, display_name, given_name, family_name,
             nickname, organization, job_title, emails_json, phones_json, photo_url, notes,
             source_modified_at, link_id, imported_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id, rec.source, rec.source_account, rec.source_id, displayName,
          rec.given_name || null, rec.family_name || null, rec.nickname || null,
          rec.organization || null, rec.job_title || null,
          JSON.stringify(emails), JSON.stringify(phones),
          rec.photo_url || null, rec.notes || null,
          rec.source_modified_at || null, rec.link_id || null, now, now
        );
      }

      db.prepare('DELETE FROM address_book_identifiers WHERE address_book_id = ?').run(id);
      const ins = db.prepare('INSERT OR IGNORE INTO address_book_identifiers (address_book_id, kind, value, label) VALUES (?, ?, ?, ?)');
      for (const e of emails) {
        const v = _normalizeEmailForIndex(e.value);
        if (v) ins.run(id, 'email', v, e.label || null);
      }
      for (const p of phones) {
        const v = _normalizePhoneForIndex(p.value);
        if (v) ins.run(id, 'phone', v, p.label || null);
      }
    });
    txn();
    return id;
  } finally { db.close(); }
}

// Remove rows for a given (source, account) that weren't seen in the latest
// sync. Caller passes the set of source_ids present upstream.
function pruneAddressBookAccount(source, source_account, keepSourceIds) {
  const db = openDb();
  const keep = new Set(keepSourceIds || []);
  try {
    const rows = db.prepare('SELECT id, source_id FROM address_book WHERE source = ? AND source_account = ?')
      .all(source, source_account);
    let removed = 0;
    const txn = db.transaction(() => {
      for (const r of rows) {
        if (!keep.has(r.source_id)) {
          db.prepare('DELETE FROM address_book_identifiers WHERE address_book_id = ?').run(r.id);
          db.prepare('DELETE FROM address_book WHERE id = ?').run(r.id);
          removed++;
        }
      }
    });
    txn();
    return removed;
  } finally { db.close(); }
}

function recordAddressBookSync({ source, source_account, total = 0, upserted = 0, removed = 0, error = null }) {
  const db = openDb();
  try {
    db.prepare(`
      INSERT INTO address_book_sync_log (source, source_account, ran_at, total, upserted, removed, error)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(source, source_account, new Date().toISOString(), total, upserted, removed, error);
  } finally { db.close(); }
}

function listAddressBook({ q = '', source = null, limit = 500, offset = 0 } = {}) {
  const db = openDb();
  try {
    const where = [];
    const args = [];
    if (source) { where.push('source = ?'); args.push(source); }
    if (q) {
      const like = `%${q.toLowerCase()}%`;
      where.push(`(
        lower(display_name) LIKE ? OR
        lower(organization) LIKE ? OR
        lower(emails_json) LIKE ? OR
        lower(phones_json) LIKE ?
      )`);
      args.push(like, like, like, like);
    }
    const sql = `
      SELECT id, source, source_account, source_id, display_name, given_name, family_name,
             nickname, organization, job_title, emails_json, phones_json, photo_url, updated_at
      FROM address_book
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY display_name COLLATE NOCASE ASC
      LIMIT ? OFFSET ?
    `;
    args.push(limit, offset);
    return db.prepare(sql).all(...args).map(r => ({
      ...r,
      emails: JSON.parse(r.emails_json || '[]'),
      phones: JSON.parse(r.phones_json || '[]'),
    }));
  } finally { db.close(); }
}

function getAddressBookContact(id) {
  const db = openDb();
  try {
    const r = db.prepare('SELECT * FROM address_book WHERE id = ?').get(id);
    if (!r) return null;
    return {
      ...r,
      emails: JSON.parse(r.emails_json || '[]'),
      phones: JSON.parse(r.phones_json || '[]'),
    };
  } finally { db.close(); }
}

// Find address-book rows that match any of the given emails/phones. Returns
// a deduped array of rows. Used to enrich contact detail views.
//
// Two sources of noise we filter out:
//   1. Shared identifiers (group addresses like `pastors@…`, or a family
//      landline) match every member — skip values resolving to more than
//      `maxFanout` distinct entries; those are roles, not personal ids.
//   2. The caller's `phones` list often contains group-chat participants'
//      handles (Comms aggregates by display name, so being on a group
//      thread leaks others' numbers into the contact's handle list). When
//      `contactName` is provided, we require each matched address-book
//      row to share a name token with it — unless the identifier is a
//      unique hit (fanout=1), which is strong enough evidence on its own.
function findAddressBookByIdentifiers({ emails = [], phones = [], contactName = null, maxFanout = 3 } = {}) {
  const cleanEmails = [...new Set(emails.map(_normalizeEmailForIndex).filter(Boolean))];
  const cleanPhones = [...new Set(phones.map(_normalizePhoneForIndex).filter(Boolean))];
  if (!cleanEmails.length && !cleanPhones.length) return [];
  const nameTokens = _nameTokens(contactName);
  const requireNameMatch = nameTokens.size > 0;

  const db = openDb();
  try {
    // candidate id -> true if any matching identifier was unique (fanout=1)
    const candidates = new Map();
    const addNonShared = (kind, values) => {
      if (!values.length) return;
      const sql = `
        SELECT address_book_id, value FROM address_book_identifiers
        WHERE kind = ? AND value IN (${values.map(() => '?').join(',')})
      `;
      const rows = db.prepare(sql).all(kind, ...values);
      const byValue = new Map();
      for (const r of rows) {
        if (!byValue.has(r.value)) byValue.set(r.value, new Set());
        byValue.get(r.value).add(r.address_book_id);
      }
      for (const [, set] of byValue) {
        if (set.size > maxFanout) continue; // group address — skip
        const unique = set.size === 1;
        for (const id of set) {
          if (!candidates.has(id)) candidates.set(id, false);
          if (unique) candidates.set(id, true);
        }
      }
    };
    addNonShared('email', cleanEmails);
    addNonShared('phone', cleanPhones);
    if (!candidates.size) return [];

    const sql = `SELECT * FROM address_book WHERE id IN (${[...candidates.keys()].map(() => '?').join(',')})`;
    const rows = db.prepare(sql).all(...candidates.keys()).map(r => ({
      ...r,
      emails: JSON.parse(r.emails_json || '[]'),
      phones: JSON.parse(r.phones_json || '[]'),
    }));
    if (!requireNameMatch) return rows;
    return rows.filter(r => {
      if (candidates.get(r.id)) return true; // unique-identifier hit: trust it
      const rowTokens = _nameTokens([r.display_name, r.given_name, r.family_name, r.nickname].filter(Boolean).join(' '));
      for (const t of rowTokens) if (nameTokens.has(t)) return true;
      return false;
    });
  } finally { db.close(); }
}

function _nameTokens(s) {
  const out = new Set();
  if (!s) return out;
  for (const t of String(s).toLowerCase().split(/[^a-z0-9]+/)) {
    if (t && t.length >= 2) out.add(t);
  }
  return out;
}

function addressBookStats() {
  const db = openDb();
  try {
    const counts = db.prepare(`
      SELECT source, source_account, COUNT(*) AS n FROM address_book
      GROUP BY source, source_account ORDER BY source, source_account
    `).all();
    const lastSync = db.prepare(`
      SELECT source, source_account, MAX(ran_at) AS ran_at, error, total, upserted, removed
      FROM address_book_sync_log
      GROUP BY source, source_account
    `).all();
    const lastMap = new Map(lastSync.map(r => [`${r.source}:${r.source_account}`, r]));
    const total = db.prepare('SELECT COUNT(*) n FROM address_book').get().n;
    return {
      total,
      accounts: counts.map(c => ({
        ...c,
        last_sync: lastMap.get(`${c.source}:${c.source_account}`) || null,
      })),
    };
  } finally { db.close(); }
}

// ---------------------------------------------------------------------------
// people — canonical identity registry.
//
// rebuildPeople() clusters address_book rows into real humans using:
//   1. Apple ZLINKID (same person across Apple sources)
//   2. Shared normalized identifier (email or phone)
//   3. Exact (given+family) name match as a last resort
// Then it attaches gloss_contacts by name/alias.
//
// It's a full rebuild — fast (a few thousand rows) and side-effect-clean.
// merge_lock=1 rows are preserved as-is so manual merges survive rebuilds.
// ---------------------------------------------------------------------------

function rebuildPeople() {
  const db = openDb();
  try {
    db.pragma('foreign_keys = ON');
    db.transaction(() => {
      // Preserve locked people and their names. Everything else gets rebuilt.
      const lockedIds = db.prepare('SELECT id FROM people WHERE merge_lock = 1').all().map(r => r.id);
      if (lockedIds.length) {
        const ph = lockedIds.map(() => '?').join(',');
        db.prepare(`DELETE FROM people_names WHERE person_id NOT IN (${ph})`).run(...lockedIds);
        db.prepare(`DELETE FROM people       WHERE id        NOT IN (${ph})`).run(...lockedIds);
        db.prepare(`UPDATE address_book   SET person_id = NULL WHERE person_id NOT IN (${ph})`).run(...lockedIds);
        db.prepare(`UPDATE gloss_contacts  SET person_id = NULL WHERE person_id NOT IN (${ph})`).run(...lockedIds);
      } else {
        db.exec(`
          DELETE FROM people_names;
          DELETE FROM people;
          UPDATE address_book  SET person_id = NULL;
          UPDATE gloss_contacts SET person_id = NULL;
        `);
      }

      // --- 1. Cluster address_book rows via union-find ------------------------
      const abRows = db.prepare(`
        SELECT id, display_name, given_name, family_name, nickname, link_id, source_modified_at, updated_at
        FROM address_book
        WHERE person_id IS NULL
      `).all();
      const idents = db.prepare(`
        SELECT address_book_id, kind, value FROM address_book_identifiers
      `).all();
      const identsById = new Map();
      for (const i of idents) {
        if (!identsById.has(i.address_book_id)) identsById.set(i.address_book_id, []);
        identsById.get(i.address_book_id).push({ kind: i.kind, value: i.value });
      }

      const parent = new Map();
      const find = (x) => {
        while (parent.get(x) !== x) {
          parent.set(x, parent.get(parent.get(x)));
          x = parent.get(x);
        }
        return x;
      };
      const union = (a, b) => {
        const ra = find(a), rb = find(b);
        if (ra !== rb) parent.set(ra, rb);
      };

      for (const r of abRows) parent.set(r.id, r.id);

      // Union via ZLINKID (strongest signal — Apple already decided).
      const byLink = new Map();
      for (const r of abRows) {
        if (!r.link_id) continue;
        if (!byLink.has(r.link_id)) byLink.set(r.link_id, []);
        byLink.get(r.link_id).push(r.id);
      }
      for (const ids of byLink.values()) {
        for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]);
      }

      // Union via shared identifier (email or phone). We skip shared/role
      // addresses — any identifier value that spans > this many ab rows is
      // treated as a group address (same filter as findAddressBookByIdentifiers).
      const MAX_IDENT_FANOUT = 3;
      const byIdent = new Map();
      for (const i of idents) {
        const k = `${i.kind}:${i.value}`;
        if (!byIdent.has(k)) byIdent.set(k, new Set());
        byIdent.get(k).add(i.address_book_id);
      }
      for (const [, set] of byIdent) {
        if (set.size < 2 || set.size > MAX_IDENT_FANOUT) continue;
        const arr = [...set];
        for (let i = 1; i < arr.length; i++) union(arr[0], arr[i]);
      }

      // Union via exact (given+family) name as last resort. Only links when
      // both given and family are present — "Smith" alone is too ambiguous.
      const byName = new Map();
      for (const r of abRows) {
        if (!r.given_name || !r.family_name) continue;
        const k = (r.given_name + ' ' + r.family_name).toLowerCase().trim();
        if (!byName.has(k)) byName.set(k, []);
        byName.get(k).push(r.id);
      }
      for (const ids of byName.values()) {
        if (ids.length < 2) continue;
        for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]);
      }

      // --- 2. Create a people row per cluster, pick best canonical -----------
      const clusters = new Map(); // root -> [abRow…]
      for (const r of abRows) {
        const root = find(r.id);
        if (!clusters.has(root)) clusters.set(root, []);
        clusters.get(root).push(r);
      }

      const now = new Date().toISOString();
      const insPerson = db.prepare(`
        INSERT INTO people (display_name, given_name, family_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      const insName = db.prepare(`
        INSERT OR IGNORE INTO people_names (person_id, name, source) VALUES (?, ?, ?)
      `);
      const setAbPerson = db.prepare('UPDATE address_book SET person_id = ? WHERE id = ?');

      for (const members of clusters.values()) {
        // Choose the canonical card: most recently modified, with the longest
        // display_name breaks ties (so "Abigail Colestock" beats "Abi").
        members.sort((a, b) => {
          const ma = a.source_modified_at || a.updated_at || '';
          const mb = b.source_modified_at || b.updated_at || '';
          if (mb !== ma) return mb.localeCompare(ma);
          return (b.display_name || '').length - (a.display_name || '').length;
        });
        const best = members[0];
        const result = insPerson.run(
          best.display_name || [best.given_name, best.family_name].filter(Boolean).join(' ') || '(unnamed)',
          best.given_name || null,
          best.family_name || null,
          now, now,
        );
        const personId = result.lastInsertRowid;
        const nameSet = new Set();
        for (const m of members) {
          setAbPerson.run(personId, m.id);
          for (const n of [m.display_name, m.given_name, m.family_name, m.nickname]) {
            if (!n) continue;
            const key = String(n).trim().toLowerCase();
            if (!key || nameSet.has(key)) continue;
            nameSet.add(key);
            insName.run(personId, n.trim(), 'address_book');
          }
        }
      }

      // --- 3. Link gloss_contacts by name or alias ---------------------------
      const glossRows = db.prepare('SELECT contact, aliases, person_id FROM gloss_contacts').all();
      const findPersonByName = db.prepare(`
        SELECT person_id FROM people_names WHERE name = ? COLLATE NOCASE LIMIT 2
      `);
      const setGlossPerson = db.prepare('UPDATE gloss_contacts SET person_id = ? WHERE contact = ? COLLATE NOCASE');
      for (const g of glossRows) {
        if (g.person_id) continue; // already linked (e.g., merge_lock preserved)
        const candidates = [g.contact];
        try {
          const parsed = g.aliases ? JSON.parse(g.aliases) : [];
          if (Array.isArray(parsed)) for (const a of parsed) if (a) candidates.push(a);
        } catch { /* ignore bad JSON */ }

        let personId = null;
        for (const n of candidates) {
          const hits = findPersonByName.all(n);
          if (hits.length === 1) { personId = hits[0].person_id; break; }
          // length 0: keep trying; length 2+: ambiguous, skip
        }

        if (!personId) {
          // No match — create a gloss-only person so queries can still resolve
          // "Abi Colestock" even if she isn't in any address book.
          const result = insPerson.run(g.contact, null, null, now, now);
          personId = result.lastInsertRowid;
        }
        setGlossPerson.run(personId, g.contact);
        insName.run(personId, g.contact, 'gloss');
        try {
          const parsed = g.aliases ? JSON.parse(g.aliases) : [];
          if (Array.isArray(parsed)) for (const a of parsed) if (a) insName.run(personId, a, 'gloss_alias');
        } catch { /* ignore */ }
      }

      // --- 4. Seed contact_aliases-derived names too -------------------------
      const aliasPairs = db.prepare('SELECT alias, canonical FROM contact_aliases').all();
      for (const { alias, canonical } of aliasPairs) {
        const rows = findPersonByName.all(canonical);
        if (rows.length !== 1) continue;
        insName.run(rows[0].person_id, alias, 'contact_alias');
      }
    })();
    const count = db.prepare('SELECT COUNT(*) n FROM people').get().n;
    return { ok: true, people: count };
  } finally { db.close(); }
}

// Resolve a free-text name to a person. Returns { person_id, names[] } if
// unambiguous, or null. The names array is the expanded query set callers
// should use in `contact IN (…)` filters.
function resolvePerson(name) {
  if (!name) return null;
  const db = openDb();
  try {
    const hits = db.prepare(`
      SELECT person_id FROM people_names WHERE name = ? COLLATE NOCASE
    `).all(name);
    const unique = new Set(hits.map(h => h.person_id));
    if (unique.size !== 1) return null;
    const person_id = [...unique][0];
    const names = db.prepare(`
      SELECT DISTINCT name FROM people_names WHERE person_id = ?
    `).all(person_id).map(r => r.name);
    return { person_id, names };
  } finally { db.close(); }
}

function getPerson(person_id) {
  const db = openDb();
  try {
    const p = db.prepare('SELECT * FROM people WHERE id = ?').get(person_id);
    if (!p) return null;
    const names = db.prepare('SELECT name, source FROM people_names WHERE person_id = ? ORDER BY name COLLATE NOCASE').all(person_id);
    const address_book = db.prepare(`
      SELECT id, source, source_account, display_name, organization, job_title, emails_json, phones_json
      FROM address_book WHERE person_id = ?
    `).all(person_id).map(r => ({
      ...r,
      emails: JSON.parse(r.emails_json || '[]'),
      phones: JSON.parse(r.phones_json || '[]'),
    }));
    const gloss = db.prepare(`
      SELECT contact, aliases, gloss_url, priority, mention_count, last_mentioned_at
      FROM gloss_contacts WHERE person_id = ?
    `).all(person_id);
    return { ...p, names, address_book, gloss };
  } finally { db.close(); }
}

// Merge a set of people into target_id. Names + linked rows (address_book,
// gloss_contacts) are reassigned; merged people rows are deleted; target is
// marked merge_lock=1 so a later automatic rebuild won't undo the merge.
function mergePeople(target_id, other_ids) {
  if (!target_id) throw new Error('mergePeople: target_id required');
  const others = (other_ids || []).filter(id => id && id !== target_id);
  if (!others.length) return { ok: true, moved: 0 };
  const db = openDb();
  try {
    const placeholders = others.map(() => '?').join(',');
    const txn = db.transaction(() => {
      db.prepare(`UPDATE address_book   SET person_id = ? WHERE person_id IN (${placeholders})`).run(target_id, ...others);
      db.prepare(`UPDATE gloss_contacts SET person_id = ? WHERE person_id IN (${placeholders})`).run(target_id, ...others);
      db.prepare(`UPDATE OR IGNORE people_names SET person_id = ? WHERE person_id IN (${placeholders})`).run(target_id, ...others);
      db.prepare(`DELETE FROM people_names WHERE person_id IN (${placeholders})`).run(...others);
      db.prepare(`DELETE FROM people      WHERE id        IN (${placeholders})`).run(...others);
      db.prepare(`UPDATE people SET merge_lock = 1, updated_at = ? WHERE id = ?`).run(new Date().toISOString(), target_id);
      // Clear any rejected_merges rows involving the merged ids — they'd be
      // dangling FKs, and the user's verdict has clearly flipped.
      db.prepare(`DELETE FROM rejected_merges WHERE person_a IN (${placeholders}) OR person_b IN (${placeholders})`).run(...others, ...others);
    });
    txn();
    return { ok: true, moved: others.length };
  } finally { db.close(); }
}

// Dismiss a suggested pair so the detector stops surfacing it.
function rejectMergePair(a_id, b_id) {
  const a = Math.min(Number(a_id), Number(b_id));
  const b = Math.max(Number(a_id), Number(b_id));
  if (!a || !b || a === b) throw new Error('rejectMergePair: two distinct person ids required');
  const db = openDb();
  try {
    db.prepare(`
      INSERT INTO rejected_merges (person_a, person_b, rejected_at)
      VALUES (?, ?, ?)
      ON CONFLICT(person_a, person_b) DO UPDATE SET rejected_at = excluded.rejected_at
    `).run(a, b, new Date().toISOString());
    return { ok: true };
  } finally { db.close(); }
}

// Find likely-duplicate person pairs that rebuildPeople didn't auto-cluster.
// Strategies are unioned; each pair accumulates signals so pairs with more
// signals rank higher. Already-rejected pairs are dropped.
//
// Signals:
//   • surname + first-initial match (catches nickname/full-name pairs like
//     Abi ↔ Abigail Colestock when no shared phone/email was present)
//   • one person's display_name equals another's nickname-derived given_name
//   • exact display_name match across two people (rare after rebuildPeople
//     but happens when names are identical and identifiers were too fanned
//     out to cluster).
//
// Returns [{ a: {id,display_name,...}, b: {...}, signals: ['surname+initial', ...] }].
function findDuplicateCandidates({ limit = 50 } = {}) {
  const db = openDb();
  try {
    const pairScores = new Map(); // key 'a:b' (a<b) → { signals: Set }

    const addPair = (x, y, signal) => {
      const [a, b] = x < y ? [x, y] : [y, x];
      if (a === b) return;
      const key = `${a}:${b}`;
      if (!pairScores.has(key)) pairScores.set(key, { a, b, signals: new Set() });
      pairScores.get(key).signals.add(signal);
    };

    // Signal 1: shared normalized (family, first-letter-of-given).
    // Only consider when both names are present and at least one of the given
    // names is shorter than 4 chars — that's the nickname case we care about.
    // We normalize by lowercasing + stripping non-alpha so "McLaughlin" and
    // "mclaughlin" match.
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
    const rows = db.prepare(`
      SELECT id, display_name, given_name, family_name
      FROM people
      WHERE given_name IS NOT NULL AND family_name IS NOT NULL
    `).all();
    const byKey = new Map();
    for (const r of rows) {
      const gn = norm(r.given_name);
      const fn = norm(r.family_name);
      if (!gn || !fn) continue;
      const key = `${fn}|${gn[0]}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({ ...r, _gn: gn });
    }
    for (const bucket of byKey.values()) {
      if (bucket.length < 2) continue;
      for (let i = 0; i < bucket.length; i++) {
        for (let j = i + 1; j < bucket.length; j++) {
          const a = bucket[i], b = bucket[j];
          // Require that the given names differ (otherwise rebuildPeople
          // would have clustered by "given+family" already) AND that one
          // looks like a short-form of the other — either a length gap or
          // a prefix match. This screens out unrelated "John S." ↔ "Jane S."
          if (a._gn === b._gn) continue;
          const short = a._gn.length < b._gn.length ? a._gn : b._gn;
          const long  = a._gn.length < b._gn.length ? b._gn : a._gn;
          if (short.length >= 4 && !long.startsWith(short)) continue;
          if (!long.startsWith(short) && Math.abs(a._gn.length - b._gn.length) < 2) continue;
          addPair(a.id, b.id, 'surname+initial');
        }
      }
    }

    // Signal 2: one person's nickname matches another person's given name.
    // Sourced from address_book (where nickname lives) → person_id.
    const nickRows = db.prepare(`
      SELECT ab.person_id AS pid, ab.nickname AS nick
      FROM address_book ab
      WHERE ab.nickname IS NOT NULL AND ab.person_id IS NOT NULL
    `).all();
    const givenRows = db.prepare(`
      SELECT id AS pid, given_name AS gn
      FROM people
      WHERE given_name IS NOT NULL
    `).all();
    const givenByNorm = new Map();
    for (const g of givenRows) {
      const k = norm(g.gn);
      if (!k) continue;
      if (!givenByNorm.has(k)) givenByNorm.set(k, new Set());
      givenByNorm.get(k).add(g.pid);
    }
    for (const n of nickRows) {
      const k = norm(n.nick);
      if (!k) continue;
      const hits = givenByNorm.get(k);
      if (!hits) continue;
      for (const other of hits) {
        if (other !== n.pid) addPair(n.pid, other, 'nickname↔given');
      }
    }

    // Signal 3: same display_name across different people (rare but happens).
    const sameName = db.prepare(`
      SELECT LOWER(display_name) AS dn, GROUP_CONCAT(id) AS ids
      FROM people
      WHERE display_name IS NOT NULL AND display_name != ''
      GROUP BY LOWER(display_name)
      HAVING COUNT(*) > 1
    `).all();
    for (const s of sameName) {
      const ids = s.ids.split(',').map(Number);
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) addPair(ids[i], ids[j], 'same-display-name');
      }
    }

    // Drop pairs the user has dismissed.
    const rejected = new Set(
      db.prepare("SELECT person_a || ':' || person_b AS k FROM rejected_merges").all().map(r => r.k),
    );
    const candidates = [];
    for (const { a, b, signals } of pairScores.values()) {
      if (rejected.has(`${a}:${b}`)) continue;
      candidates.push({ a, b, signals: [...signals] });
    }
    // Rank by signal count desc, then by person id ascending for stability.
    candidates.sort((x, y) => y.signals.length - x.signals.length || x.a - y.a);

    // Hydrate with person summaries.
    const ids = new Set();
    for (const c of candidates.slice(0, limit)) { ids.add(c.a); ids.add(c.b); }
    if (!ids.size) return [];
    const idList = [...ids];
    const ph = idList.map(() => '?').join(',');
    const peopleRows = db.prepare(`
      SELECT p.id, p.display_name, p.given_name, p.family_name,
             (SELECT COUNT(*) FROM address_book WHERE person_id = p.id) AS ab_count,
             (SELECT COUNT(*) FROM gloss_contacts WHERE person_id = p.id) AS gloss_count,
             (SELECT GROUP_CONCAT(DISTINCT source) FROM address_book WHERE person_id = p.id) AS sources
      FROM people p
      WHERE p.id IN (${ph})
    `).all(...idList);
    const byId = new Map(peopleRows.map(r => [r.id, r]));

    return candidates.slice(0, limit).map(c => ({
      a: byId.get(c.a),
      b: byId.get(c.b),
      signals: c.signals,
    })).filter(x => x.a && x.b);
  } finally { db.close(); }
}


// ---------------------------------------------------------------------------
// app_settings — key/value store for user preferences
// ---------------------------------------------------------------------------

function getSetting(key, defaultValue = null) {
  const db = openDb();
  try {
    const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : defaultValue;
  } finally { db.close(); }
}

function saveSetting(key, value) {
  const db = openDb();
  try {
    db.prepare(`
      INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), new Date().toISOString());
  } finally { db.close(); }
}

// ---------------------------------------------------------------------------
// special_dates — birthdays, anniversaries, deaths, memorials, custom
// ---------------------------------------------------------------------------

function upsertSpecialDate({ id, contact, type, month, day, year, label, notes, source, source_id }) {
  if (!id || !type || !month || !day) throw new Error('upsertSpecialDate: id, type, month, day are required');
  const db = openDb();
  try {
    db.prepare(`
      INSERT INTO special_dates (id, contact, type, month, day, year, label, notes, source, source_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        contact    = excluded.contact,
        type       = excluded.type,
        month      = excluded.month,
        day        = excluded.day,
        year       = excluded.year,
        label      = excluded.label,
        notes      = excluded.notes,
        source     = excluded.source,
        source_id  = excluded.source_id,
        updated_at = excluded.updated_at
    `).run(
      id,
      contact || null,
      type,
      month,
      day,
      year || null,
      label || null,
      notes || null,
      source || 'manual',
      source_id || null,
      new Date().toISOString(),
    );
  } finally { db.close(); }
}

function listUpcomingSpecialDates({ days = 60 } = {}) {
  const db = openDb();
  try {
    const rows = db.prepare('SELECT * FROM special_dates ORDER BY month, day').all();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // Deduplicate by (contact, type, month, day) — multiple Apple/Google source
    // DBs can produce duplicate entries for the same person.
    const seen = new Map();
    const result = [];
    for (const r of rows) {
      const thisYear = today.getFullYear();
      let next = new Date(thisYear, r.month - 1, r.day);
      next.setHours(0, 0, 0, 0);
      if (next < today) next = new Date(thisYear + 1, r.month - 1, r.day);
      const days_until = Math.round((next - today) / 86400000);
      if (days_until > days) continue;
      const dedupeKey = `${(r.contact || '').toLowerCase()}|${r.type}|${r.month}|${r.day}`;
      if (!seen.has(dedupeKey)) {
        seen.set(dedupeKey, true);
        result.push({ ...r, days_until, next_date: next.toISOString().slice(0, 10) });
      }
    }
    result.sort((a, b) => a.days_until - b.days_until);
    return result;
  } finally { db.close(); }
}

function listSpecialDates({ contact } = {}) {
  const db = openDb();
  try {
    if (contact) {
      return db.prepare('SELECT * FROM special_dates WHERE contact = ? COLLATE NOCASE ORDER BY month, day').all(contact);
    }
    return db.prepare('SELECT * FROM special_dates ORDER BY month, day').all();
  } finally { db.close(); }
}

function getSpecialDatesForContact(name) {
  return listSpecialDates({ contact: name });
}

function deleteSpecialDate(id) {
  const db = openDb();
  try { db.prepare('DELETE FROM special_dates WHERE id = ?').run(id); }
  finally { db.close(); }
}

// ---------------------------------------------------------------------------
// Sent message/email samples — for AI writing style inference
// ---------------------------------------------------------------------------

function getRecentSentMessagesForStyle(name, { limit = 20, days = 90 } = {}) {
  const db = openDb();
  try {
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
    const sent_messages = db.prepare(`
      SELECT text, sent_at FROM messages
      WHERE contact = ? COLLATE NOCASE AND direction = 'sent'
        AND text IS NOT NULL AND date >= ?
      ORDER BY sent_at DESC LIMIT ?
    `).all(name, cutoff, limit);
    const sent_emails = db.prepare(`
      SELECT subject, snippet FROM emails
      WHERE contact = ? COLLATE NOCASE AND direction = 'sent' AND date >= ?
      ORDER BY rowid DESC LIMIT ?
    `).all(name, cutoff, limit);
    return { sent_messages, sent_emails };
  } finally { db.close(); }
}

// ---------------------------------------------------------------------------
// People review (flashcard mode) — on-demand, never pushed.
//
// A "reviewable" person is one who matters: either they're a Gloss priority
// contact (priority >= 1) OR they have at least 5 messages/emails on file.
// Priority comes from gloss_contacts which is person-linked; activity is
// name-based and folded in via a LEFT JOIN. Ordering: last_reviewed_at ASC
// (NULL first) so people who have never been reviewed bubble to the top,
// then least-recent-contact first to keep things fresh.
//
// Deliberately SQL-only so the algorithm is testable end-to-end.
// ---------------------------------------------------------------------------

const PEOPLE_REVIEW_ACTIVITY_THRESHOLD = 5;

// Returns an ordered list of { person_id, display_name, last_reviewed_at }.
// The caller (endpoint) walks the list by offset so Skip is O(1): no state
// is persisted beyond last_reviewed_at.
function listPeopleReviewQueue({ limit = 200 } = {}) {
  const db = openDb();
  try {
    return db.prepare(`
      WITH comm_counts AS (
        SELECT contact, COUNT(*) AS n FROM (
          SELECT contact FROM messages
          UNION ALL
          SELECT contact FROM emails
        )
        GROUP BY contact COLLATE NOCASE
      ),
      person_activity AS (
        SELECT pn.person_id, SUM(COALESCE(cc.n, 0)) AS n
        FROM people_names pn
        LEFT JOIN comm_counts cc ON cc.contact = pn.name COLLATE NOCASE
        GROUP BY pn.person_id
      ),
      person_priority AS (
        SELECT person_id, MAX(priority) AS priority
        FROM gloss_contacts
        WHERE person_id IS NOT NULL
        GROUP BY person_id
      )
      SELECT
        p.id AS person_id,
        p.display_name,
        p.last_reviewed_at,
        COALESCE(pp.priority, 0) AS priority,
        COALESCE(pa.n, 0) AS activity_count
      FROM people p
      LEFT JOIN person_priority pp ON pp.person_id = p.id
      LEFT JOIN person_activity pa ON pa.person_id = p.id
      WHERE COALESCE(pp.priority, 0) >= 1
         OR COALESCE(pa.n, 0) >= ?
      ORDER BY
        (p.last_reviewed_at IS NULL) DESC,
        p.last_reviewed_at ASC,
        p.display_name COLLATE NOCASE ASC
      LIMIT ?
    `).all(PEOPLE_REVIEW_ACTIVITY_THRESHOLD, limit);
  } finally { db.close(); }
}

// Returns the next person to review at offset `skip`, with the same shape as
// getContactDetail(name) so the UI can render a single code path. Returns
// null when the queue is exhausted.
function getPeopleReviewNext({ skip = 0 } = {}) {
  const queue = listPeopleReviewQueue({ limit: skip + 1 });
  const row = queue[skip];
  if (!row) return null;
  const detail = getContactDetail(row.display_name);
  return {
    ...detail,
    person_id: row.person_id,
    last_reviewed_at: row.last_reviewed_at,
    queue_position: skip,
    queue_total: queue.length, // capped at skip+1 for speed; callers that
                               // need a total should use countPeopleReview.
  };
}

function markPersonReviewed(person_id) {
  if (!person_id) throw new Error('markPersonReviewed: person_id required');
  const db = openDb();
  try {
    const now = new Date().toISOString();
    const res = db.prepare(
      'UPDATE people SET last_reviewed_at = ?, updated_at = ? WHERE id = ?'
    ).run(now, now, person_id);
    return { ok: res.changes > 0, last_reviewed_at: now };
  } finally { db.close(); }
}

// Count of reviewable people whose last_reviewed_at is older than N days
// (or null). Used by the ambient "N haven't been reviewed in 30+ days" chip.
function countPeopleDueForReview({ days = 30 } = {}) {
  const db = openDb();
  try {
    const row = db.prepare(`
      WITH comm_counts AS (
        SELECT contact, COUNT(*) AS n FROM (
          SELECT contact FROM messages
          UNION ALL
          SELECT contact FROM emails
        )
        GROUP BY contact COLLATE NOCASE
      ),
      person_activity AS (
        SELECT pn.person_id, SUM(COALESCE(cc.n, 0)) AS n
        FROM people_names pn
        LEFT JOIN comm_counts cc ON cc.contact = pn.name COLLATE NOCASE
        GROUP BY pn.person_id
      ),
      person_priority AS (
        SELECT person_id, MAX(priority) AS priority
        FROM gloss_contacts
        WHERE person_id IS NOT NULL
        GROUP BY person_id
      )
      SELECT COUNT(*) AS n
      FROM people p
      LEFT JOIN person_priority pp ON pp.person_id = p.id
      LEFT JOIN person_activity pa ON pa.person_id = p.id
      WHERE (COALESCE(pp.priority, 0) >= 1 OR COALESCE(pa.n, 0) >= ?)
        AND (p.last_reviewed_at IS NULL
             OR p.last_reviewed_at < datetime('now', ?))
    `).get(PEOPLE_REVIEW_ACTIVITY_THRESHOLD, `-${Math.max(1, Number(days) || 30)} days`);
    return row?.n || 0;
  } finally { db.close(); }
}

// ---------------------------------------------------------------------------
// Overview — one snapshot for the "Status" surface
// ---------------------------------------------------------------------------
function getOverview() {
  const db = openDb();
  try {
    const lastRun = db.prepare(`SELECT * FROM runs WHERE status='done' ORDER BY date DESC LIMIT 1`).get() || null;
    const totals = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM messages) AS total_messages,
        (SELECT COUNT(*) FROM emails)   AS total_emails,
        (SELECT COUNT(*) FROM calls)    AS total_calls,
        (SELECT COUNT(*) FROM runs WHERE status='done') AS total_runs
    `).get();
    const calendarInfo = db.prepare(`
      SELECT MAX(synced_at) AS last_synced, COUNT(*) AS upcoming_count
      FROM calendar_events WHERE date >= date('now')
    `).get() || {};
    const glossInfo = db.prepare(`
      SELECT MAX(synced_at) AS last_pushed, COUNT(*) AS total, SUM(CASE WHEN priority >= 1 THEN 1 ELSE 0 END) AS priority
      FROM gloss_contacts
    `).get() || {};
    const glossNotes    = db.prepare(`SELECT COUNT(*) AS n FROM gloss_notes`).get()?.n || 0;
    const gmailAccounts = db.prepare(`SELECT COUNT(*) AS n FROM gmail_accounts`).get()?.n || 0;
    return {
      last_run: lastRun,
      totals,
      calendar: {
        last_synced: calendarInfo.last_synced || null,
        upcoming_count: calendarInfo.upcoming_count || 0,
      },
      gloss: {
        last_pushed: glossInfo.last_pushed || null,
        total: glossInfo.total || 0,
        priority: glossInfo.priority || 0,
        notes: glossNotes,
      },
      gmail_accounts: gmailAccounts,
    };
  } finally { db.close(); }
}

// ---------------------------------------------------------------------------
// Suite status metrics — a table-count rollup used by /api/status. Each count
// is isolated in its own try/catch so a missing/renamed table never 500s the
// health-check surface. Returns numbers (0 on error).
// ---------------------------------------------------------------------------
function getSuiteStatusMetrics() {
  const db = openDb();
  const count = (sql) => {
    try { return db.prepare(sql).get()?.n || 0; }
    catch { return 0; }
  };
  try {
    return {
      total_messages: count('SELECT COUNT(*) AS n FROM messages'),
      total_emails:   count('SELECT COUNT(*) AS n FROM emails'),
      total_calls:    count('SELECT COUNT(*) AS n FROM calls'),
      total_runs:     count('SELECT COUNT(*) AS n FROM runs'),
      gmail_accounts: count('SELECT COUNT(DISTINCT id) AS n FROM gmail_accounts'),
      gloss_contacts: count('SELECT COUNT(*) AS n FROM gloss_contacts'),
    };
  } finally { db.close(); }
}

// ---------------------------------------------------------------------------
// Message / email search across all runs
// ---------------------------------------------------------------------------
function searchAll(query, { limit = 25 } = {}) {
  const q = String(query || '').trim();
  if (!q) return { messages: [], emails: [], contacts: [] };
  const db = openDb();
  try {
    const pattern = `%${q}%`;
    const messages = db.prepare(`
      SELECT id, date, contact, sender, direction, text, sent_at
      FROM messages WHERE text LIKE ? COLLATE NOCASE
      ORDER BY sent_at DESC LIMIT ?
    `).all(pattern, limit);
    const emails = db.prepare(`
      SELECT id, date, contact, email_address, direction, subject, snippet, account
      FROM emails WHERE subject LIKE ? COLLATE NOCASE OR snippet LIKE ? COLLATE NOCASE
      ORDER BY rowid DESC LIMIT ?
    `).all(pattern, pattern, limit);
    // Distinct contacts with at least one message or email.
    const contacts = db.prepare(`
      SELECT contact FROM (
        SELECT contact FROM messages WHERE contact LIKE ? COLLATE NOCASE
        UNION
        SELECT contact FROM emails   WHERE contact LIKE ? COLLATE NOCASE
        UNION
        SELECT contact FROM gloss_contacts WHERE contact LIKE ? COLLATE NOCASE
      )
      LIMIT ?
    `).all(pattern, pattern, pattern, limit).map(r => r.contact);
    return { messages, emails, contacts };
  } finally { db.close(); }
}

module.exports = {
  collect, collectCalls, getRuns, getRunDetail, getMissingDates,
  getGmailAccounts, getGmailAccountsWithTokens, saveGmailAccount, deleteGmailAccount, saveGmailTokens,
  testMessagesAccess,
  // Gloss profiles
  upsertGlossContact, getGlossContact, listContacts, getContactDetail, getRecentCommsForAI,
  saveContactInsight,
  // Gloss notes
  upsertGlossNote,
  // Calendar
  upsertCalendarEvents, pruneOldCalendarEvents, listCalendarEvents, getCalendarEvent,
  getMeetingBrief, saveMeetingBrief,
  // Nudges
  getNudges, dismissNudge, isoWeekOf,
  // User-authored contact profile
  getContactProfile, saveContactProfile, renameContact,
  // Agenda items (person- and event-scoped)
  listAgendaItems, addAgendaItem, updateAgendaItem, deleteAgendaItem,
  // Custom playbook models
  listCustomPlaybookModels, getCustomPlaybookModel, saveCustomPlaybookModel, deleteCustomPlaybookModel,
  // Address book
  upsertAddressBookContact, pruneAddressBookAccount, recordAddressBookSync,
  listAddressBook, getAddressBookContact, findAddressBookByIdentifiers, addressBookStats,
  // People — canonical identity registry
  rebuildPeople, resolvePerson, getPerson, mergePeople, rejectMergePair, findDuplicateCandidates,
  // People review (flashcards, on-demand)
  listPeopleReviewQueue, getPeopleReviewNext, markPersonReviewed, countPeopleDueForReview,
  // App settings
  getSetting, saveSetting,
  // Special dates
  upsertSpecialDate, listUpcomingSpecialDates, listSpecialDates, getSpecialDatesForContact, deleteSpecialDate,
  // Sent message style samples
  getRecentSentMessagesForStyle,
  // Overview + search
  getOverview, getSuiteStatusMetrics, searchAll,
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
