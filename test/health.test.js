'use strict';

// SPEC 3 — Relational health score tests.
// Covers: band cutoffs, default cadence from priority, Gloss-push dedup hash,
// listPeopleForReview sort, setContactCadence persistence.

const os   = require('os');
const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-health-test-'));
process.env.COMMS_DB_PATH = path.join(tmpDir, 'test.db');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  getRuns,
  upsertGlossContact,
  getContactHealth,
  listPeopleForReview,
  setContactCadence,
  defaultCadenceForPriority,
  computeGlossPushHash,
  canonicalJsonStringify,
} = require('../collect');

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function openRaw() { return new Database(process.env.COMMS_DB_PATH); }

function seed() {
  getRuns();
  const db = openRaw();
  db.pragma('foreign_keys = OFF');
  db.exec(`
    DELETE FROM messages;
    DELETE FROM emails;
    DELETE FROM gloss_contacts;
    DELETE FROM people_names;
    DELETE FROM people;
    DELETE FROM runs;
  `);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO runs (id, date, collected_at, status) VALUES (?, ?, ?, 'done')`)
    .run('run-1', '2026-04-01', now);

  // Healthy: last message 3 days ago, target 7 days (score ~0.43)
  const insMsg = db.prepare(
    `INSERT INTO messages (id, run_id, date, contact, direction, sender, sent_at)
     VALUES (?, 'run-1', '2026-04-01', ?, 'sent', 'me', ?)`
  );
  insMsg.run('m-alice', 'Alice Healthy', new Date(Date.now() - 3 * 86400_000).toISOString());
  insMsg.run('m-bob',   'Bob Overdue',   new Date(Date.now() - 10 * 86400_000).toISOString());
  insMsg.run('m-carol', 'Carol Red',     new Date(Date.now() - 20 * 86400_000).toISOString());

  db.pragma('foreign_keys = ON');
  db.close();

  // Prime gloss_contacts via upsert so hash + default cadence fire.
  upsertGlossContact({ contact: 'Alice Healthy', gloss_id: 'g-a', gloss_url: 'x', priority: 1 }); // default 7
  upsertGlossContact({ contact: 'Bob Overdue',   gloss_id: 'g-b', gloss_url: 'x', priority: 1 }); // default 7
  upsertGlossContact({ contact: 'Carol Red',     gloss_id: 'g-c', gloss_url: 'x', priority: 1 }); // default 7
}

describe('defaultCadenceForPriority', () => {
  it('maps priorities 1/2/3 to 7/30/90 and others to 90', () => {
    assert.equal(defaultCadenceForPriority(1), 7);
    assert.equal(defaultCadenceForPriority(2), 30);
    assert.equal(defaultCadenceForPriority(3), 90);
    assert.equal(defaultCadenceForPriority(null), 90);
    assert.equal(defaultCadenceForPriority(0), 90);
  });
});

describe('canonicalJsonStringify', () => {
  it('produces the same output regardless of key order', () => {
    const a = { b: 1, a: [3, 2, 1], c: { y: 1, x: 2 } };
    const b = { c: { x: 2, y: 1 }, a: [3, 2, 1], b: 1 };
    assert.equal(canonicalJsonStringify(a), canonicalJsonStringify(b));
  });
});

describe('computeGlossPushHash', () => {
  it('returns identical hashes for payloads that differ only in key order', () => {
    const p1 = { gloss_id: 'g', gloss_url: 'u', priority: 1, aliases: ['B', 'A'] };
    const p2 = { aliases: ['B', 'A'], priority: 1, gloss_url: 'u', gloss_id: 'g' };
    assert.equal(computeGlossPushHash(p1), computeGlossPushHash(p2));
  });
  it('changes when the payload meaningfully changes', () => {
    const p1 = { gloss_id: 'g', gloss_url: 'u', priority: 1 };
    const p2 = { gloss_id: 'g', gloss_url: 'u', priority: 2 };
    assert.notEqual(computeGlossPushHash(p1), computeGlossPushHash(p2));
  });
});

describe('upsertGlossContact dedup', () => {
  before(seed);
  it('skips the heavy upsert when the canonical payload is unchanged', () => {
    const first  = upsertGlossContact({ contact: 'Alice Healthy', gloss_id: 'g-a', gloss_url: 'x', priority: 1 });
    const second = upsertGlossContact({ contact: 'Alice Healthy', gloss_id: 'g-a', gloss_url: 'x', priority: 1 });
    assert.equal(second.skipped, true);
    assert.equal(first.hash, second.hash);
  });
  it('does not skip when the payload changes', () => {
    const next = upsertGlossContact({ contact: 'Alice Healthy', gloss_id: 'g-a', gloss_url: 'x', priority: 2 });
    assert.equal(next.skipped, false);
  });
});

describe('getContactHealth — band cutoffs', () => {
  before(seed);
  it('healthy band when score < 1.0', () => {
    const h = getContactHealth('Alice Healthy');
    assert.equal(h.band, 'healthy');
    assert.ok(h.score < 1.0);
    assert.equal(h.target, 7);
  });
  it('overdue band when 1.0 <= score < 2.0', () => {
    const h = getContactHealth('Bob Overdue');
    assert.equal(h.band, 'overdue');
    assert.ok(h.score >= 1.0 && h.score < 2.0);
  });
  it('red band when score >= 2.0', () => {
    const h = getContactHealth('Carol Red');
    assert.equal(h.band, 'red');
    assert.ok(h.score >= 2.0);
  });
  it('treats a contact with no comms on file as red (maximally overdue)', () => {
    upsertGlossContact({ contact: 'Ghost Person', gloss_id: 'g-x', gloss_url: 'x', priority: 1 });
    const h = getContactHealth('Ghost Person');
    assert.equal(h.band, 'red');
    assert.equal(h.score, null);
    assert.equal(h.last_contact_at, null);
  });
});

describe('listPeopleForReview', () => {
  before(seed);
  it('sorts by health DESC by default (most overdue first)', () => {
    const out = listPeopleForReview({ sort: 'health' });
    const names = out.map(r => r.contact);
    // Carol (red) should come before Bob (overdue), which comes before Alice.
    assert.ok(names.indexOf('Carol Red')     < names.indexOf('Bob Overdue'));
    assert.ok(names.indexOf('Bob Overdue')   < names.indexOf('Alice Healthy'));
  });
  it('sorts alphabetically when sort=alpha', () => {
    const out = listPeopleForReview({ sort: 'alpha' });
    const names = out.map(r => r.contact);
    const sorted = names.slice().sort((a, b) => a.localeCompare(b));
    assert.deepEqual(names, sorted);
  });
});

describe('setContactCadence', () => {
  before(seed);
  it('persists and changes the score on the next health read', () => {
    const before = getContactHealth('Bob Overdue');
    // Widen Bob's target to 100 days — 10 days since contact should now be healthy.
    const updated = setContactCadence('Bob Overdue', 100);
    assert.equal(updated.target, 100);
    assert.equal(updated.band, 'healthy');
    const reread = getContactHealth('Bob Overdue');
    assert.equal(reread.target, 100);
    assert.notEqual(reread.score, before.score);
  });
  it('rejects invalid values', () => {
    assert.throws(() => setContactCadence('Bob Overdue', -1), /positive integer/);
    assert.throws(() => setContactCadence('Bob Overdue', 'abc'), /positive integer/);
  });
  it('throws when the contact is unknown', () => {
    assert.throws(() => setContactCadence('Does Not Exist', 30), /not found/);
  });
});
