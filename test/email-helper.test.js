// Unit tests for email-helper — classifier is pure, so we test it directly.
// Draft generation + context build are integration concerns that need a DB;
// they're covered by the manual /api/email-helper/run trigger in production.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { classifyEmail } = require('../email-helper');

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
