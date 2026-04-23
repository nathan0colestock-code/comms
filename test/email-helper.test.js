// Unit tests for email-helper — classifier is pure, so we test it directly.
// Draft generation + context build are integration concerns that need a DB;
// they're covered by the manual /api/email-helper/run trigger in production.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// Mock ./gmail before requiring email-helper so runForAccount picks up stubs.
// Must use absolute path to match email-helper's require('./gmail') resolution.
const gmailPath = require.resolve('../gmail');
require.cache[gmailPath] = {
  id: gmailPath,
  filename: gmailPath,
  loaded: true,
  exports: {
    gmailClientFor: (_tokenJson) => ({
      gmail: {},
      refreshed: { value: { access_token: 'new-access-token' } },
    }),
    listUnreadInboxThreads: async () => [], // no threads → skip the loop
    getMessageFull: async () => ({}),
    createDraftReply: async () => ({}),
    archiveThread: async () => ({}),
    extractEmail: (s) => (String(s).match(/[^\s<>]+@[^\s<>]+/) || [''])[0],
    hasScope: () => true,
  },
};

const { classifyEmail, runEmailHelper } = require('../email-helper');

describe('classifyEmail', () => {
  test('flags transactional: no-reply senders', () => {
    const r = classifyEmail({ from: 'no-reply@example.com', subject: 'anything', listUnsubscribe: '' });
    assert.equal(r.kind, 'transactional');
  });

  test('flags transactional: receipt subjects', () => {
    const r = classifyEmail({ from: 'friend@gmail.com', subject: 'Your Amazon order has shipped', listUnsubscribe: '' });
    assert.equal(r.kind, 'transactional');
  });

  test('flags transactional: 2fa verification', () => {
    const r = classifyEmail({ from: 'security@bank.com', subject: 'Your verification code', listUnsubscribe: '' });
    assert.equal(r.kind, 'transactional');
  });

  test('flags newsletter when List-Unsubscribe present', () => {
    const r = classifyEmail({
      from: 'Substack <posts@substack.com>', subject: 'Weekly digest',
      listUnsubscribe: '<mailto:unsubscribe@substack.com>',
    });
    assert.equal(r.kind, 'newsletter');
  });

  test('flags spam: lottery subjects', () => {
    const r = classifyEmail({ from: 'random@x.com', subject: 'You are a lottery winner!!', listUnsubscribe: '' });
    assert.equal(r.kind, 'spam');
  });

  test('defaults to real person: plain human email', () => {
    const r = classifyEmail({ from: 'Alice <alice@gmail.com>', subject: 'lunch tomorrow?', listUnsubscribe: '' });
    assert.equal(r.kind, 'real');
  });

  test('List-Unsubscribe + real-looking sender still flags as newsletter', () => {
    // Conservative: List-Unsub header is the signal. False-classify-as-newsletter
    // only costs an auto-archive (if enabled) — user still sees it archived.
    const r = classifyEmail({
      from: 'Someone <someone@acme.com>', subject: 'Our quarterly roundup',
      listUnsubscribe: '<mailto:u@acme.com>',
    });
    assert.equal(r.kind, 'newsletter');
  });
});

describe('runEmailHelper: token persistence', () => {
  test('saveGmailTokens is called with acct.id (not acct.email)', async () => {
    // Regression: UPDATE gmail_accounts ... WHERE id = ? is keyed on the
    // numeric id, but email-helper was passing acct.email. Silent no-op
    // meant every Google refresh on the 8am/noon run was discarded and
    // eventually tokens hit invalid_grant. Assert the id is what's saved.
    const calls = [];
    const acct = {
      id: 42,
      email: 'nathan@example.com',
      token_json: JSON.stringify({ access_token: 'old', refresh_token: 'r' }),
    };
    // Minimal fake db — prepare() only needs to no-op for the
    // email_helper_runs insert at the end of runEmailHelper.
    const fakeDb = {
      prepare: () => ({ run: () => {}, all: () => [], get: () => null }),
    };
    const result = await runEmailHelper({
      db: fakeDb,
      getGmailAccountsWithTokens: () => [acct],
      saveGmailTokens: (id, tokens) => { calls.push({ id, tokens }); },
    });
    assert.equal(calls.length, 1, 'saveGmailTokens should be called once');
    assert.equal(calls[0].id, 42, 'must be called with acct.id, not acct.email');
    assert.equal(calls[0].tokens.access_token, 'new-access-token');
    assert.equal(calls[0].tokens.refresh_token, 'r', 'prior refresh_token preserved');
    assert.ok(result, 'runEmailHelper returned a result');
  });
});
