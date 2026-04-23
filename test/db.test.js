'use strict';

// Must set COMMS_DB_PATH before requiring collect so DB_PATH is evaluated correctly.
const os   = require('os');
const path = require('path');
const fs   = require('fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-db-test-'));
process.env.COMMS_DB_PATH = path.join(tmpDir, 'test.db');

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  getRuns, getRunDetail, getMissingDates,
  getGmailAccounts, saveGmailAccount, deleteGmailAccount,
} = require('../collect');

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------

describe('getRuns', () => {
  it('returns an empty array on a fresh database', () => {
    const runs = getRuns();
    assert.deepEqual(runs, []);
  });

  it('accepts a limit argument', () => {
    const runs = getRuns(5);
    assert.ok(Array.isArray(runs));
  });
});

describe('getRunDetail', () => {
  it('returns null for a date with no data', () => {
    assert.equal(getRunDetail('2020-01-01'), null);
  });
});

describe('getMissingDates', () => {
  it('returns today when no runs exist', () => {
    const today = new Date();
    const expected = [
      today.getFullYear() + '-' +
      String(today.getMonth() + 1).padStart(2, '0') + '-' +
      String(today.getDate()).padStart(2, '0'),
    ];
    assert.deepEqual(getMissingDates(), expected);
  });

  it('respects an explicit from date', () => {
    const dates = getMissingDates('2026-01-01');
    assert.ok(dates.length > 0);
    assert.equal(dates[0], '2026-01-01');
    // Dates must be ascending and contiguous
    for (let i = 1; i < dates.length; i++) {
      const prev = new Date(dates[i - 1] + 'T12:00:00Z');
      const curr = new Date(dates[i]     + 'T12:00:00Z');
      assert.equal(curr - prev, 86400_000);
    }
  });
});

describe('Gmail accounts', () => {
  const testEmail  = 'test@example.com';
  const testTokens = { access_token: 'tok', refresh_token: 'ref' };

  it('starts with no accounts', () => {
    assert.deepEqual(getGmailAccounts(), []);
  });

  it('saves and retrieves an account', () => {
    saveGmailAccount(testEmail, testTokens);
    const accounts = getGmailAccounts();
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0].email, testEmail);
    assert.ok(accounts[0].id);
    assert.ok(accounts[0].added_at);
    // token_json is not exposed by getGmailAccounts (security)
    assert.equal(accounts[0].token_json, undefined);
  });

  it('upserts on duplicate email', () => {
    const updated = { access_token: 'tok2', refresh_token: 'ref2' };
    saveGmailAccount(testEmail, updated);
    assert.equal(getGmailAccounts().length, 1);
  });

  it('deletes an account by id', () => {
    const [account] = getGmailAccounts();
    deleteGmailAccount(account.id);
    assert.deepEqual(getGmailAccounts(), []);
  });
});
