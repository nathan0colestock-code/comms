'use strict';

/**
 * calls.js — read-only ingest of macOS phone/FaceTime call history.
 *
 * Source: Core Data SQLite backing store at
 *   ~/Library/Application Support/CallHistoryDB/CallHistory.storedata
 *
 * Requires Full Disk Access for the process reading the file (same as
 * iMessage chat.db). We never write to the source DB — always open readonly.
 *
 * ZCALLRECORD (columns of interest, present on macOS 12+ per manual inspection):
 *   ZADDRESS    VARCHAR  — phone number or FaceTime address
 *   ZDATE       TIMESTAMP — Core Data epoch: seconds since 2001-01-01 00:00 UTC
 *   ZDURATION   FLOAT    — seconds; 0 for missed/unanswered
 *   ZORIGINATED INTEGER  — 0 = incoming, 1 = outgoing
 *   ZANSWERED   INTEGER  — 0 = not answered, 1 = answered
 *   ZUNIQUE_ID  VARCHAR  — stable UUID per call record
 *   ZNAME       VARCHAR  — address book display name at time of call (if known)
 *
 * Column presence varies across macOS versions — we introspect the schema via
 * PRAGMA table_info and gracefully skip columns that don't exist.
 */

const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const Database = require('better-sqlite3');

const CALL_DB_PATH = path.join(
  os.homedir(), 'Library', 'Application Support', 'CallHistoryDB', 'CallHistory.storedata'
);

// Core Data epoch: 2001-01-01T00:00:00Z in ms since UNIX epoch.
const CORE_DATA_EPOCH_MS = Date.UTC(2001, 0, 1);

function coreDataToIso(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return null;
  const ms = CORE_DATA_EPOCH_MS + Math.round(seconds * 1000);
  return new Date(ms).toISOString();
}

function isoToLocalDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

// Normalize phone to E.164-ish. US 10/11-digit → '+1XXXXXXXXXX'.
// Already-leading-+ numbers pass through with non-digits stripped after the +.
function normalizeToE164(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (s.startsWith('+')) {
    const digits = s.slice(1).replace(/\D/g, '');
    return digits ? '+' + digits : null;
  }
  const digits = s.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return '+' + digits;
}

// direction for our DB: missed if incoming + not answered, else incoming/outgoing.
function deriveDirection(originated, answered) {
  if (originated === 1) return 'outgoing';
  if (originated === 0 && answered === 0) return 'missed';
  return 'incoming';
}

/**
 * Read call records from the source DB. Read-only. Throws a tagged error if
 * the file is unreadable so callers can surface a Full Disk Access prompt.
 *
 * @param {object} opts
 * @param {string} [opts.since] — ISO date or datetime; only records at or after
 *                                this instant are returned.
 * @param {string} [opts.dbPath] — override path (used by tests).
 * @returns {Array<{id,iso,date,phone_raw,phone,direction,duration_seconds,answered,name_hint}>}
 */
function readCallRecords({ since = null, dbPath = CALL_DB_PATH } = {}) {
  if (!fs.existsSync(dbPath)) {
    const err = new Error(
      `Call history DB not found at ${dbPath}. Grant Full Disk Access to this app in System Settings → Privacy & Security → Full Disk Access.`
    );
    err.fullDiskAccessRequired = true;
    throw err;
  }

  let db;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 5000 });
  } catch (err) {
    if (/authorization|permission|denied|unable to open/i.test(err.message)) {
      const e = new Error(
        `Cannot read ${dbPath} (${err.message}). Grant Full Disk Access in System Settings → Privacy & Security → Full Disk Access.`
      );
      e.fullDiskAccessRequired = true;
      throw e;
    }
    throw err;
  }

  try {
    // Introspect schema — some columns (e.g. ZNAME) may be absent on older macOS.
    const cols = new Set(db.pragma('table_info(ZCALLRECORD)').map(c => c.name));
    const required = ['ZUNIQUE_ID', 'ZDATE', 'ZADDRESS', 'ZORIGINATED', 'ZANSWERED'];
    for (const c of required) {
      if (!cols.has(c)) {
        throw new Error(`ZCALLRECORD is missing expected column ${c}; CallHistoryDB schema may have changed.`);
      }
    }
    const select = [
      'ZUNIQUE_ID AS id',
      'ZDATE AS zdate',
      'ZADDRESS AS address',
      'ZORIGINATED AS originated',
      'ZANSWERED AS answered',
      cols.has('ZDURATION') ? 'ZDURATION AS duration' : '0 AS duration',
      cols.has('ZNAME') ? 'ZNAME AS name_hint' : 'NULL AS name_hint',
    ].join(', ');

    let sql = `SELECT ${select} FROM ZCALLRECORD`;
    const params = [];
    if (since) {
      // Convert ISO to Core Data seconds for comparison on ZDATE.
      const sinceMs = new Date(since).getTime();
      if (!isNaN(sinceMs)) {
        const zthreshold = (sinceMs - CORE_DATA_EPOCH_MS) / 1000;
        sql += ' WHERE ZDATE >= ?';
        params.push(zthreshold);
      }
    }
    sql += ' ORDER BY ZDATE ASC';

    const out = [];
    for (const row of db.prepare(sql).all(...params)) {
      const iso = coreDataToIso(row.zdate);
      if (!iso) continue;
      const phone = normalizeToE164(row.address);
      out.push({
        id: row.id,
        iso,
        date: isoToLocalDate(iso),
        phone_raw: row.address || null,
        phone,
        direction: deriveDirection(row.originated, row.answered),
        duration_seconds: row.duration != null ? Math.round(row.duration) : 0,
        answered: row.answered === 1 ? 1 : 0,
        name_hint: row.name_hint || null,
      });
    }
    return out;
  } finally {
    db.close();
  }
}

/**
 * Import calls via an upsert callback. Keeps this module decoupled from the
 * main DB schema — callers pass in an upsertCall function that writes to the
 * comms DB however they prefer.
 *
 * @param {object} opts
 * @param {string} [opts.since]
 * @param {(call) => void} opts.upsertCall — invoked for each normalized row.
 * @param {string} [opts.dbPath]
 * @returns {{ total: number, imported: number }}
 */
function importCalls({ since = null, upsertCall, dbPath } = {}) {
  if (typeof upsertCall !== 'function') {
    throw new Error('importCalls: upsertCall callback is required');
  }
  const rows = readCallRecords({ since, dbPath });
  let imported = 0;
  for (const r of rows) {
    try {
      upsertCall(r);
      imported++;
    } catch (err) {
      // Surface the error but keep going — a single bad row shouldn't abort.
      if (process.env.COMMS_DEBUG_CALLS) {
        // eslint-disable-next-line no-console
        console.warn('[calls] upsert failed for', r.id, err.message);
      }
    }
  }
  return { total: rows.length, imported };
}

module.exports = {
  importCalls,
  readCallRecords,
  // exported for tests
  coreDataToIso,
  isoToLocalDate,
  normalizeToE164,
  deriveDirection,
  CALL_DB_PATH,
};
