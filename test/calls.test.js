'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const {
  importCalls, readCallRecords,
  coreDataToIso, normalizeToE164, deriveDirection,
} = require('../calls');

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('coreDataToIso', () => {
  it('converts 0 seconds to 2001-01-01T00:00:00Z', () => {
    assert.equal(coreDataToIso(0), '2001-01-01T00:00:00.000Z');
  });

  it('converts a real Core Data timestamp to a correct ISO string', () => {
    // 798558529.025447 is ~2026-04-20T19:08:49 UTC (seconds since 2001-01-01).
    const iso = coreDataToIso(798558529.025447);
    assert.ok(iso.startsWith('2026-04-'), `expected 2026-04-*, got ${iso}`);
  });

  it('returns null for nullish / non-finite inputs', () => {
    assert.equal(coreDataToIso(null), null);
    assert.equal(coreDataToIso(undefined), null);
    assert.equal(coreDataToIso(NaN), null);
  });
});

describe('normalizeToE164', () => {
  it('returns null for empty input', () => {
    assert.equal(normalizeToE164(null), null);
    assert.equal(normalizeToE164(''), null);
  });

  it('prepends +1 for a 10-digit US number', () => {
    assert.equal(normalizeToE164('4155551234'), '+14155551234');
  });

  it('preserves an existing +country prefix', () => {
    assert.equal(normalizeToE164('+447700900123'), '+447700900123');
    assert.equal(normalizeToE164('+1 (415) 555-1234'), '+14155551234');
  });

  it('normalises an 11-digit US number starting with 1', () => {
    assert.equal(normalizeToE164('14155551234'), '+14155551234');
  });
});

describe('deriveDirection', () => {
  it('outgoing when ZORIGINATED=1', () => {
    assert.equal(deriveDirection(1, 1), 'outgoing');
    assert.equal(deriveDirection(1, 0), 'outgoing');
  });

  it('missed when incoming and unanswered', () => {
    assert.equal(deriveDirection(0, 0), 'missed');
  });

  it('incoming when answered', () => {
    assert.equal(deriveDirection(0, 1), 'incoming');
  });
});

// ---------------------------------------------------------------------------
// Fixture-driven readCallRecords / importCalls
// ---------------------------------------------------------------------------

function buildFixtureDb() {
  const file = path.join(os.tmpdir(), `calls-fixture-${process.pid}-${Date.now()}.db`);
  const db = new Database(file);
  // Mimic a subset of the real ZCALLRECORD schema — enough columns that the
  // introspection in readCallRecords finds everything it needs.
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
  // Three call records: one outgoing, one incoming answered, one missed.
  ins.run('UUID-1', 700000000, '+14155551234', 1, 1, 120.5, 'Alice');
  ins.run('UUID-2', 700050000, '4155559999',  0, 1, 45.0,  null);
  ins.run('UUID-3', 700060000, '+12135550000', 0, 0, 0.0,   'Bob');
  db.close();
  return file;
}

describe('readCallRecords', () => {
  it('reads and normalizes every row from a fixture DB', () => {
    const fixture = buildFixtureDb();
    try {
      const rows = readCallRecords({ dbPath: fixture });
      assert.equal(rows.length, 3);
      const byId = Object.fromEntries(rows.map(r => [r.id, r]));

      assert.equal(byId['UUID-1'].direction, 'outgoing');
      assert.equal(byId['UUID-1'].phone, '+14155551234');
      assert.equal(byId['UUID-1'].duration_seconds, 121);
      assert.equal(byId['UUID-1'].answered, 1);
      assert.equal(byId['UUID-1'].name_hint, 'Alice');
      assert.ok(byId['UUID-1'].iso);
      assert.match(byId['UUID-1'].date, /^\d{4}-\d{2}-\d{2}$/);

      assert.equal(byId['UUID-2'].direction, 'incoming');
      assert.equal(byId['UUID-2'].phone, '+14155559999'); // 10-digit → +1
      assert.equal(byId['UUID-2'].answered, 1);

      assert.equal(byId['UUID-3'].direction, 'missed');
      assert.equal(byId['UUID-3'].answered, 0);
      assert.equal(byId['UUID-3'].duration_seconds, 0);
    } finally {
      fs.unlinkSync(fixture);
    }
  });

  it('honors the `since` filter (Core Data seconds → threshold)', () => {
    const fixture = buildFixtureDb();
    try {
      // Threshold between UUID-1 (700000000s) and UUID-2 (700050000s).
      // ISO timestamp corresponding to ~700030000s after 2001-01-01:
      const isoMid = new Date(Date.UTC(2001, 0, 1) + 700030000 * 1000).toISOString();
      const rows = readCallRecords({ dbPath: fixture, since: isoMid });
      const ids = rows.map(r => r.id).sort();
      assert.deepEqual(ids, ['UUID-2', 'UUID-3']);
    } finally {
      fs.unlinkSync(fixture);
    }
  });

  it('throws a tagged permission error when the source file is missing', () => {
    const missing = path.join(os.tmpdir(), `does-not-exist-${Date.now()}.db`);
    try {
      readCallRecords({ dbPath: missing });
      assert.fail('expected throw');
    } catch (err) {
      assert.equal(err.fullDiskAccessRequired, true);
      assert.match(err.message, /Full Disk Access/);
    }
  });
});

describe('importCalls', () => {
  it('invokes upsertCall once per record with normalized fields', () => {
    const fixture = buildFixtureDb();
    try {
      const seen = [];
      const { total, imported } = importCalls({
        dbPath: fixture,
        upsertCall: (row) => seen.push(row.id),
      });
      assert.equal(total, 3);
      assert.equal(imported, 3);
      assert.deepEqual(seen.sort(), ['UUID-1', 'UUID-2', 'UUID-3']);
    } finally {
      fs.unlinkSync(fixture);
    }
  });

  it('counts errors from upsertCall separately (still iterates all rows)', () => {
    const fixture = buildFixtureDb();
    try {
      let calls = 0;
      const { total, imported } = importCalls({
        dbPath: fixture,
        upsertCall: () => {
          calls++;
          throw new Error('boom');
        },
      });
      assert.equal(total, 3);
      assert.equal(imported, 0);
      assert.equal(calls, 3);
    } finally {
      fs.unlinkSync(fixture);
    }
  });

  it('throws when upsertCall is not a function', () => {
    assert.throws(() => importCalls({}), /upsertCall/);
  });
});
