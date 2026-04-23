'use strict';

// Must set COMMS_DB_PATH before requiring collect so DB_PATH is evaluated.
const os   = require('os');
const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-review-test-'));
process.env.COMMS_DB_PATH = path.join(tmpDir, 'test.db');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  listPeopleReviewQueue, getPeopleReviewNext, markPersonReviewed,
  countPeopleDueForReview, getRuns,
} = require('../collect');

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function openRaw() {
  return new Database(process.env.COMMS_DB_PATH);
}

function seed() {
  // Trigger schema init first.
  getRuns();

  const db = openRaw();
  // Temporarily drop FKs so we can wipe in any order; reenable after seed.
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

  // Need a run to satisfy the FK on messages.run_id.
  db.prepare(`INSERT INTO runs (id, date, collected_at, status) VALUES (?, ?, ?, 'done')`)
    .run('run-1', '2026-04-01', now);

  // Four people:
  //  1. Priority-1 (gloss), never reviewed           → should appear first
  //  2. No priority, 6 messages, never reviewed      → appears second
  //  3. Priority-2 (gloss), reviewed 40 days ago     → appears third
  //  4. Nothing → excluded from the queue
  const insertPerson = db.prepare(
    `INSERT INTO people (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)`
  );
  const insertName = db.prepare(
    `INSERT INTO people_names (person_id, name, source) VALUES (?, ?, 'seed')`
  );
  for (const [id, name] of [[1, 'Alice One'], [2, 'Bob Two'], [3, 'Carol Three'], [4, 'Dave Four']]) {
    insertPerson.run(id, name, now, now);
    insertName.run(id, name);
  }

  // Priority signals for people 1 and 3
  db.prepare(`
    INSERT INTO gloss_contacts
      (contact, aliases, gloss_id, gloss_url, priority, synced_at, person_id)
    VALUES (?, '[]', ?, ?, ?, ?, ?)
  `).run('Alice One', 'g-a', 'http://x/a', 1, now, 1);
  db.prepare(`
    INSERT INTO gloss_contacts
      (contact, aliases, gloss_id, gloss_url, priority, synced_at, person_id)
    VALUES (?, '[]', ?, ?, ?, ?, ?)
  `).run('Carol Three', 'g-c', 'http://x/c', 2, now, 3);

  // Carol was reviewed 40 days ago
  const forty = new Date(Date.now() - 40 * 86400_000).toISOString();
  db.prepare('UPDATE people SET last_reviewed_at = ? WHERE id = 3').run(forty);

  // Activity for person 2 (6 messages — crosses the ≥5 threshold)
  const ins = db.prepare(
    `INSERT INTO messages (id, run_id, date, contact, direction, sender) VALUES (?, 'run-1', '2026-04-01', 'Bob Two', 'sent', 'me')`
  );
  for (let i = 0; i < 6; i++) ins.run('m-' + i);

  db.pragma('foreign_keys = ON');
  db.close();
}

// ---------------------------------------------------------------------------

describe('listPeopleReviewQueue', () => {
  before(seed);

  it('includes people with priority OR ≥5 msgs/emails, excludes the rest', () => {
    const queue = listPeopleReviewQueue();
    const names = queue.map(q => q.display_name);
    assert.ok(names.includes('Alice One'));
    assert.ok(names.includes('Bob Two'));
    assert.ok(names.includes('Carol Three'));
    assert.ok(!names.includes('Dave Four')); // no signals → excluded
  });

  it('orders never-reviewed first, then by last_reviewed_at ascending', () => {
    const queue = listPeopleReviewQueue();
    const reviewed = queue.map(q => q.last_reviewed_at);
    // All NULLs come before any non-null
    const firstNonNullIdx = reviewed.findIndex(r => r != null);
    assert.ok(firstNonNullIdx === -1 || reviewed.slice(0, firstNonNullIdx).every(r => r == null));
    // Carol (reviewed) comes after Alice & Bob (never reviewed)
    const carolIdx = queue.findIndex(q => q.display_name === 'Carol Three');
    const aliceIdx = queue.findIndex(q => q.display_name === 'Alice One');
    const bobIdx   = queue.findIndex(q => q.display_name === 'Bob Two');
    assert.ok(carolIdx > aliceIdx);
    assert.ok(carolIdx > bobIdx);
  });
});

describe('getPeopleReviewNext', () => {
  before(seed);

  it('returns the first person at skip=0, including getContactDetail shape', () => {
    const first = getPeopleReviewNext({ skip: 0 });
    assert.ok(first);
    assert.ok(first.contact);
    assert.ok(first.stats);
    assert.ok(Array.isArray(first.timeline));
    assert.equal(first.queue_position, 0);
    assert.ok(first.person_id);
  });

  it('advances by skip', () => {
    const a = getPeopleReviewNext({ skip: 0 });
    const b = getPeopleReviewNext({ skip: 1 });
    assert.ok(a && b);
    assert.notEqual(a.contact, b.contact);
  });

  it('returns null past the end of the queue', () => {
    assert.equal(getPeopleReviewNext({ skip: 100 }), null);
  });
});

describe('markPersonReviewed', () => {
  before(seed);

  it('sets last_reviewed_at on the person row', () => {
    const before = getPeopleReviewNext({ skip: 0 });
    const result = markPersonReviewed(before.person_id);
    assert.equal(result.ok, true);
    assert.ok(result.last_reviewed_at);

    // Reviewing bumps the person to the back of the queue.
    const afterFirst = getPeopleReviewNext({ skip: 0 });
    assert.notEqual(afterFirst.person_id, before.person_id);
  });

  it('throws without a person_id', () => {
    assert.throws(() => markPersonReviewed(null), /person_id/);
  });
});

describe('countPeopleDueForReview', () => {
  before(seed);

  it('counts never-reviewed + stale-reviewed people over N days', () => {
    // Fresh seed: Alice (never), Bob (never), Carol (40d ago) → 3 due at 30d.
    const n30 = countPeopleDueForReview({ days: 30 });
    assert.equal(n30, 3);
    // Bump days past Carol's threshold — she drops off the due list.
    const n60 = countPeopleDueForReview({ days: 60 });
    assert.equal(n60, 2);
  });
});
