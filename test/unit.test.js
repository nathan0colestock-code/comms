'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { extractTextFromAttributedBody, normalizePhone, isRealPersonEmail } = require('../collect');
const { parseContact, extractEmail } = require('../gmail');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Build a minimal valid NSTypedStream buffer containing the given text.
// form: 'direct' (len < 128, no flag byte) | 'extended' (len 128-255, 0x81 prefix + flag byte)
function makeAttributedBodyBuffer(text, form = 'direct') {
  const header  = Buffer.concat([Buffer.from([0x04, 0x0b]), Buffer.from('streamtyped')]);
  const textBuf = Buffer.from(text, 'utf8');
  const len     = textBuf.length;
  let stringPart;
  if (form === 'direct') {
    stringPart = Buffer.concat([Buffer.from([0x2b, len]), textBuf]);
  } else {
    stringPart = Buffer.concat([Buffer.from([0x2b, 0x81, len, 0x00]), textBuf]);
  }
  return Buffer.concat([header, Buffer.from([0x00, 0x00]), stringPart]);
}

// ---------------------------------------------------------------------------
// normalizePhone
// ---------------------------------------------------------------------------

describe('normalizePhone', () => {
  it('returns null for null/empty', () => {
    assert.equal(normalizePhone(null), null);
    assert.equal(normalizePhone(''), null);
  });

  it('strips formatting from a 10-digit number', () => {
    assert.equal(normalizePhone('(415) 555-1234'), '4155551234');
  });

  it('normalises 11-digit US number by dropping leading 1', () => {
    assert.equal(normalizePhone('+14155551234'), '4155551234');
    assert.equal(normalizePhone('14155551234'), '4155551234');
  });

  it('leaves non-US numbers untouched', () => {
    assert.equal(normalizePhone('+447700900123'), '447700900123');
  });
});

// ---------------------------------------------------------------------------
// isRealPersonEmail
// ---------------------------------------------------------------------------

describe('isRealPersonEmail', () => {
  const emptyMap = new Map();
  const contactMap = new Map([['alice@example.com', 'Alice']]);

  it('returns false for null address', () => {
    assert.equal(isRealPersonEmail(null, emptyMap), false);
  });

  it('returns false for noreply addresses', () => {
    assert.equal(isRealPersonEmail('noreply@example.com', emptyMap), false);
    assert.equal(isRealPersonEmail('no-reply@service.io', emptyMap), false);
  });

  it('returns false for automated patterns', () => {
    assert.equal(isRealPersonEmail('newsletter@company.com', emptyMap), false);
    assert.equal(isRealPersonEmail('billing@stripe.com', emptyMap), false);
  });

  it('returns true for known contact regardless of pattern', () => {
    assert.equal(isRealPersonEmail('alice@example.com', contactMap), true);
  });

  it('returns true for unknown address that looks like a person', () => {
    assert.equal(isRealPersonEmail('bob@example.com', emptyMap), true);
  });
});

// ---------------------------------------------------------------------------
// parseContact / extractEmail  (gmail.js)
// ---------------------------------------------------------------------------

describe('parseContact', () => {
  it('extracts name from "Name <email>" format', () => {
    assert.equal(parseContact('Jane Doe <jane@example.com>'), 'Jane Doe');
  });

  it('strips surrounding quotes from the name', () => {
    assert.equal(parseContact('"Acme Corp" <info@acme.com>'), 'Acme Corp');
  });

  it('returns raw string when there are no angle brackets', () => {
    assert.equal(parseContact('jane@example.com'), 'jane@example.com');
  });

  it('trims whitespace', () => {
    assert.equal(parseContact('  Jane  <jane@example.com>'), 'Jane');
  });
});

describe('extractEmail', () => {
  it('extracts address from angle brackets', () => {
    assert.equal(extractEmail('Jane Doe <Jane@Example.COM>'), 'jane@example.com');
  });

  it('lowercases a plain address', () => {
    assert.equal(extractEmail('JANE@EXAMPLE.COM'), 'jane@example.com');
  });

  it('trims whitespace from plain address', () => {
    assert.equal(extractEmail('  jane@example.com  '), 'jane@example.com');
  });
});

// ---------------------------------------------------------------------------
// extractTextFromAttributedBody
// ---------------------------------------------------------------------------

describe('extractTextFromAttributedBody', () => {
  it('returns null for null input', () => {
    assert.equal(extractTextFromAttributedBody(null), null);
  });

  it('returns null for a buffer that is too short', () => {
    assert.equal(extractTextFromAttributedBody(Buffer.alloc(5)), null);
  });

  it('returns null when magic bytes are wrong', () => {
    const buf = Buffer.alloc(20);
    buf[0] = 0x00; buf[1] = 0x00;
    assert.equal(extractTextFromAttributedBody(buf), null);
  });

  it('returns null when "streamtyped" string is absent', () => {
    const buf = Buffer.concat([Buffer.from([0x04, 0x0b]), Buffer.from('notstreamtype')]);
    assert.equal(extractTextFromAttributedBody(buf), null);
  });

  it('extracts text from direct-length encoding (len < 128)', () => {
    const buf = makeAttributedBodyBuffer('hello world', 'direct');
    assert.equal(extractTextFromAttributedBody(buf), 'hello world');
  });

  it('extracts text from extended-length encoding (0x81 prefix)', () => {
    const longText = 'a'.repeat(150);
    const buf = makeAttributedBodyBuffer(longText, 'extended');
    assert.equal(extractTextFromAttributedBody(buf), longText);
  });

  it('ignores class-name-like strings (NS prefix)', () => {
    const buf = makeAttributedBodyBuffer('NSString class data', 'direct');
    assert.equal(extractTextFromAttributedBody(buf), null);
  });
});
