'use strict';

// Integration test: mock the Core Data source file and verify that the
// comms calls table, getContactDetail timeline, and suite status metrics
// all reflect the ingested rows.

const os   = require('os');
const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-calls-it-'));
process.env.COMMS_DB_PATH = path.join(tmpDir, 'test.db');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  getContactDetail, getSuiteStatusMetrics, getOverview,
} = require('../collect');

// We need openDb + the findAddressBookByIdentifiers scaffolding. Rather than
// exercising the real importer (which reads from the user's home dir), we
// feed rows directly through calls.js's importCalls with an upsertCall that
// mirrors what collectCalls does.
const { importCalls } = require('../calls');

// ---------------------------------------------------------------------------

function buildSourceFixture() {
  const file = path.join(tmpDir, 'CallHistory.storedata');
  const db = new Database(file);
  db.exec(`
    CREATE TABLE ZCALLRECORD (
      Z_PK INTEGER PRIMARY KEY,
      ZUNIQUE_ID VARCHAR,
      ZDATE FLOAT,
      ZADDRESS VARCHAR,
      ZORIGINATED INTEGER,
      ZANSWERED INTEGER,
      ZDURATION FLOAT,
      ZNAME VARCHAR
    );
  `);
  const ins = db.prepare(`
    INSERT INTO ZCALLRECORD
      (ZUNIQUE_ID, ZDATE, ZADDRESS, ZORIGINATED, ZANSWERED, ZDURATION, ZNAME)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  // Two calls for Alice, one missed call from an unknown number.
  ins.run('C1', 800000000, '+14155551234', 1, 1, 300, 'Alice Example');
  ins.run('C2', 800100000, '+14155551234', 0, 1, 60,  null);
  ins.run('C3', 800200000, '+12135550000', 0, 0, 0,   null);
  db.close();
  return file;
}

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------

describe('calls integration', () => {
  let sourceDb;
  before(() => {
    sourceDb = buildSourceFixture();

    // Seed a messages row so the contact exists before calls are attached.
    const commsDb = new Database(process.env.COMMS_DB_PATH);
    // Force schema initialization by requiring collect through a side effect.
    require('../collect'); // triggers openDb when any exported fn is called
    commsDb.close();

    // Insert calls directly through importCalls + a local upsert.
    const commsDb2 = new Database(process.env.COMMS_DB_PATH);
    // Ensure the calls table exists (schema was created when collect.js loaded
    // and any function called openDb; call it here to be safe):
    require('../collect').getRuns();
    const insert = commsDb2.prepare(`
      INSERT OR IGNORE INTO calls
        (id, date, contact, phone, direction, duration_seconds, answered, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    importCalls({
      dbPath: sourceDb,
      upsertCall: (r) => {
        insert.run(
          r.id, r.date,
          r.name_hint || r.phone_raw || r.phone || 'Unknown',
          r.phone, r.direction, r.duration_seconds, r.answered, r.iso,
        );
      },
    });
    commsDb2.close();
  });

  it('populates the calls table with every record', () => {
    const db = new Database(process.env.COMMS_DB_PATH, { readonly: true });
    const n = db.prepare('SELECT COUNT(*) AS n FROM calls').get().n;
    db.close();
    assert.equal(n, 3);
  });

  it('exposes call_count + timeline entries via getContactDetail', () => {
    // Only C1 has a name_hint that matches "Alice Example"; C2 & C3 fall
    // back to the phone-number-as-contact path because the test harness
    // skips the address-book resolver.
    const detail = getContactDetail('Alice Example');
    assert.equal(detail.stats.call_count, 1);
    assert.ok(Array.isArray(detail.calls));
    assert.equal(detail.calls.length, 1);
    assert.ok(Array.isArray(detail.timeline));
    const callEntries = detail.timeline.filter(t => t.kind === 'call');
    assert.equal(callEntries.length, 1);
    assert.equal(callEntries[0].data.direction, 'outgoing');
    assert.equal(callEntries[0].data.phone, '+14155551234');

    // Unknown-caller lookup still returns a timeline entry.
    const unknown = getContactDetail('+12135550000');
    assert.equal(unknown.stats.call_count, 1);
    assert.equal(unknown.calls[0].direction, 'missed');
  });

  it('includes total_calls in suite status metrics', () => {
    const m = getSuiteStatusMetrics();
    assert.equal(m.total_calls, 3);
  });

  it('includes total_calls in overview totals', () => {
    const ov = getOverview();
    assert.equal(ov.totals.total_calls, 3);
  });
});
