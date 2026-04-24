'use strict';

// C-I-01 — INSIGHTS_MODEL selection + retry logic.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveInsightsModel,
  isRetryableGeminiError,
  INSIGHT_MODEL_MAP,
  INSIGHT_FALLBACK_MODEL,
} = require('../ai');

describe('resolveInsightsModel', () => {
  const original = process.env.INSIGHTS_MODEL;
  after(() => { process.env.INSIGHTS_MODEL = original; });

  it('defaults to the claude-alias Gemini model when env is unset', () => {
    delete process.env.INSIGHTS_MODEL;
    assert.equal(resolveInsightsModel(), INSIGHT_MODEL_MAP['claude']);
  });

  it('selects the explicit gemini-2.0-flash variant', () => {
    process.env.INSIGHTS_MODEL = 'gemini-2.0-flash';
    assert.equal(resolveInsightsModel(), 'gemini-2.0-flash');
  });

  it('selects the gemini-2.5-pro variant', () => {
    process.env.INSIGHTS_MODEL = 'gemini-2.5-pro';
    assert.equal(resolveInsightsModel(), 'gemini-2.5-pro');
  });

  it('falls back to a safe default on unknown values', () => {
    process.env.INSIGHTS_MODEL = 'mystery-model';
    assert.equal(resolveInsightsModel(), 'gemini-2.5-flash');
  });
});

describe('isRetryableGeminiError', () => {
  it('retries on explicit 5xx status', () => {
    assert.equal(isRetryableGeminiError({ status: 503, message: 'down' }), true);
    assert.equal(isRetryableGeminiError({ cause: { status: 500 }, message: '' }), true);
  });
  it('retries when the message embeds a 5xx code', () => {
    assert.equal(isRetryableGeminiError({ message: 'Gemini returned 502 bad gateway' }), true);
  });
  it('does not retry on 4xx or generic failures', () => {
    assert.equal(isRetryableGeminiError({ status: 400, message: 'bad req' }), false);
    assert.equal(isRetryableGeminiError({ message: 'bad JSON' }), false);
  });
  it('asserts fallback model is one of the mapped variants', () => {
    assert.ok(Object.values(INSIGHT_MODEL_MAP).includes(INSIGHT_FALLBACK_MODEL));
  });
});
