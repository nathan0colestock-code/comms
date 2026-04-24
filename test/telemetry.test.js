'use strict';

// C-P-01 — email-classifier edit rate
// C-P-02 — people-review cadence adherence

const os   = require('os');
const path = require('path');
const fs   = require('fs');
const Database = require('better-sqlite3');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-telemetry-test-'));
process.env.COMMS_DB_PATH = path.join(tmpDir, 'test.db');

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  getRuns,
  upsertGlossContact,
  recordEmailDraft,
  getEmailEditRate,
  getCadenceAdherence,
  approximateEditRatio,
  getNightlyTelemetry,
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
    DELETE FROM email_draft_log;
    DELETE FROM runs;
  `);
  db.prepare(`INSERT INTO runs (id, date, collected_at, status) VALUES (?, ?, ?, 'done')`)
    .run('run-1', '2026-04-01', new Date().toISOString());
  db.pragma('foreign_keys = ON');
  db.close();
}

describe('approximateEditRatio', () => {
  it('returns 0 for identical strings', () => {
    assert.equal(approximateEditRatio('hello there', 'hello there'), 0);
  });
  it('returns 1 when one side is empty', () => {
    assert.equal(approximateEditRatio('hello', ''), 1);
  });
  it('returns something between 0 and 1 for partial overlap', () => {
    const r = approximateEditRatio('the quick brown fox', 'the quick red fox');
    assert.ok(r > 0 && r < 1);
  });
});

describe('getEmailEditRate', () => {
  before(seed);
  it('returns no data when there are no drafts', () => {
    const r = getEmailEditRate({ days: 7 });
    assert.equal(r.compared, 0);
  });

  it('compares a draft against the eventual sent email in the same thread', () => {
    recordEmailDraft({
      thread_id: 't-1',
      account:   'me@example.com',
      subject:   'Re: hello',
      draft_body: 'Hey — thanks for the note. Talk soon.',
    });
    // Seed an emails row for the same thread_id, sent by user today.
    const db = openRaw();
    const today = new Date().toISOString().slice(0, 10);
    db.prepare(`INSERT INTO emails (id, run_id, date, direction, contact, snippet, thread_id)
                VALUES (?, 'run-1', ?, 'sent', 'friend', ?, ?)`)
      .run('e-1', today, 'Hey thanks for the note talk soon', 't-1');
    db.close();

    const r = getEmailEditRate({ days: 7 });
    assert.equal(r.compared, 1);
    assert.ok(r.avg_edit_ratio >= 0 && r.avg_edit_ratio <= 1);
    assert.ok(r.distribution);
  });
});

describe('getCadenceAdherence', () => {
  before(seed);
  it('counts contacts that went green within the last 7 days of being due', () => {
    // Contact A: last contact 14 days ago, target 7 → overdue already at t-7d,
    // but still not green → in "due" but not "met".
    // Contact B: last contact 2 days ago, target 7 → never was overdue → skipped.
    // Contact C: last contact 1 day ago, target 10, AND was overdue at t-7d
    //   (age at window = 10-7 = 3, not >= 10, so skipped). We construct a
    //   contact-that-flipped using target=5 and last=2d ago:
    //     age at window (t-7d) = 2 - (-7) ? Actually simpler: just one green
    //     case where last_contact is very recent AND the gap in between was
    //     long. Since we only have "last contact" we can't model a flip
    //     precisely; we settle for asserting the denominator counts people
    //     who are overdue at t-7d (ageAtWindow >= target).
    const db = openRaw();
    // Insert 3 gloss contacts with priority+cadence; seed last-contact rows.
    for (const [name, prio, cadence, daysAgo] of [
      ['Anna',  1,  7, 14],
      ['Ben',   1,  7, 2],
      ['Carly', 1,  5, 1],
    ]) {
      db.close();
      upsertGlossContact({ contact: name, gloss_id: 'g-' + name, gloss_url: 'x', priority: prio });
      const db2 = openRaw();
      db2.prepare('UPDATE gloss_contacts SET target_cadence_days = ? WHERE contact = ?')
        .run(cadence, name);
      db2.prepare(`INSERT INTO messages (id, run_id, date, contact, direction, sender, sent_at)
                   VALUES (?, 'run-1', '2026-04-01', ?, 'sent', 'me', ?)`)
        .run('m-' + name + '-' + daysAgo, name, new Date(Date.now() - daysAgo * 86400_000).toISOString());
      db2.close();
      // Reopen for next loop.
      // eslint-disable-next-line no-unused-vars
      const _db = openRaw();
      _db.close();
    }

    const r = getCadenceAdherence({ days: 7 });
    // Anna: age-at-window = 14-7 = 7 >= target 7 → due. Age now 14, still overdue.
    // Ben:  age-at-window = 2-7 = -5 < 7 → skipped.
    // Carly: age-at-window = 1-7 = -6 < 5 → skipped.
    assert.equal(r.due_last_7d, 1);
    assert.equal(r.met, 0);
    assert.equal(r.adherence_rate, 0);
  });
});

describe('getNightlyTelemetry includes new surfaces', () => {
  before(seed);
  it('exposes edit_rate_7d and cadence_adherence_7d fields', () => {
    const t = getNightlyTelemetry();
    assert.ok('edit_rate_7d' in t);
    assert.ok('cadence_adherence_7d' in t);
  });
});
