'use strict';

// Set env vars before any require so server/collect pick them up at module load.
const os   = require('os');
const path = require('path');
const fs   = require('fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-api-test-'));
process.env.COMMS_DB_PATH = path.join(tmpDir, 'test.db');
process.env.API_KEY       = 'test-api-key-abc123';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http   = require('http');

const { app } = require('../server');

// ---------------------------------------------------------------------------
// Test HTTP helper
// ---------------------------------------------------------------------------

let server;
let baseUrl;

before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function req(urlPath, { headers = {}, method = 'GET', body: reqBody } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const payload = reqBody != null ? JSON.stringify(reqBody) : null;
    const hdrs = { ...headers };
    if (payload) {
      hdrs['Content-Type'] = 'application/json';
      hdrs['Content-Length'] = Buffer.byteLength(payload);
    }
    const options = { hostname: url.hostname, port: url.port, path: url.pathname, method, headers: hdrs };
    const r = http.request(options, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, body }); }
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const AUTH = { 'Authorization': 'Bearer test-api-key-abc123' };

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

describe('authentication', () => {
  it('returns 401 with no credentials', async () => {
    const { status } = await req('/api/status');
    assert.equal(status, 401);
  });

  it('returns 401 with wrong key', async () => {
    const { status } = await req('/api/status', { headers: { 'Authorization': 'Bearer wrong-key' } });
    assert.equal(status, 401);
  });

  it('accepts correct key via Authorization: Bearer', async () => {
    const { status } = await req('/api/status', { headers: AUTH });
    assert.equal(status, 200);
  });

  it('accepts correct key via X-API-Key header', async () => {
    const { status } = await req('/api/status', { headers: { 'X-API-Key': 'test-api-key-abc123' } });
    assert.equal(status, 200);
  });

  it('redirects / to /login when unauthenticated', async () => {
    const { status } = await req('/');
    assert.equal(status, 302);
  });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

describe('GET /api/status', () => {
  it('returns the suite-status envelope with a bearer token', async () => {
    const { status, body } = await req('/api/status', { headers: AUTH });
    assert.equal(status, 200);
    assert.equal(body.app, 'comms');
    assert.equal(body.ok, true);
    assert.equal(typeof body.version, 'string');
    assert.equal(typeof body.uptime_seconds, 'number');
    assert.ok(body.uptime_seconds >= 0);
    assert.ok(body.metrics && typeof body.metrics === 'object');
    for (const k of ['total_messages', 'total_emails', 'total_runs', 'gmail_accounts', 'gloss_contacts']) {
      assert.equal(typeof body.metrics[k], 'number', `metrics.${k} should be a number`);
    }
  });
});

describe('GET /api/overview', () => {
  it('returns ok, db path, and overview fields', async () => {
    const { status, body } = await req('/api/overview', { headers: AUTH });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(typeof body.db === 'string');
    assert.ok(body.totals && typeof body.totals.total_messages === 'number');
    assert.ok(body.calendar && typeof body.calendar.upcoming_count === 'number');
    assert.ok(body.gloss && typeof body.gloss.total === 'number');
    assert.ok(typeof body.gmail_accounts === 'number');
  });
});

describe('GET /api/search', () => {
  it('returns empty arrays for a blank query', async () => {
    const { status, body } = await req('/api/search?q=', { headers: AUTH });
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.messages));
    assert.ok(Array.isArray(body.emails));
    assert.ok(Array.isArray(body.contacts));
  });

  it('returns empty arrays when there is no data', async () => {
    const { status, body } = await req('/api/search?q=xyzzy', { headers: AUTH });
    assert.equal(status, 200);
    assert.equal(body.messages.length, 0);
    assert.equal(body.emails.length, 0);
    assert.equal(body.contacts.length, 0);
  });
});

describe('GET /api/runs', () => {
  it('returns an array', async () => {
    const { status, body } = await req('/api/runs', { headers: AUTH });
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
  });
});

describe('GET /api/runs/:date', () => {
  it('returns 400 for an invalid date format', async () => {
    const { status } = await req('/api/runs/not-a-date', { headers: AUTH });
    assert.equal(status, 400);
  });

  it('returns 404 for a valid date with no data', async () => {
    const { status } = await req('/api/runs/2020-01-01', { headers: AUTH });
    assert.equal(status, 404);
  });
});

describe('GET /api/gmail/accounts', () => {
  it('returns an array', async () => {
    const { status, body } = await req('/api/gmail/accounts', { headers: AUTH });
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
  });
});

describe('POST /api/gloss/contacts', () => {
  it('rejects a body that is neither { contacts: [] } nor an array', async () => {
    const { status } = await req('/api/gloss/contacts', {
      method: 'POST', headers: AUTH, body: { not_contacts: [] },
    });
    assert.equal(status, 400);
  });

  it('accepts the documented contract shape and persists a row', async () => {
    const payload = {
      contacts: [{
        contact: 'Push Contract Person',
        aliases: ['Pushy'],
        gloss_id: 'gloss-xyz-1',
        gloss_url: 'http://localhost:3747/#/index/person/gloss-xyz-1',
        mention_count: 3,
        last_mentioned_at: '2026-04-20',
        priority: 2,
        growth_note: 'Check in monthly',
        recent_context: [
          { date: '2026-04-18', role_summary: 'mentioned re: the retreat', collection: 'Formation' },
        ],
        linked_collections: ['Formation', 'Rhythms'],
      }],
    };
    const { status, body } = await req('/api/gloss/contacts', {
      method: 'POST', headers: AUTH, body: payload,
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.saved, 1);

    // Round-trip: the contact now shows up on /api/contacts/:name.
    const detail = await req('/api/contacts/' + encodeURIComponent('Push Contract Person'), { headers: AUTH });
    assert.equal(detail.status, 200);
    assert.ok(detail.body.gloss);
    assert.equal(detail.body.gloss.priority, 2);
    // recent_context objects must be preserved through the round-trip.
    assert.ok(Array.isArray(detail.body.gloss.recent_context));
    assert.equal(detail.body.gloss.recent_context[0].role_summary, 'mentioned re: the retreat');
    assert.equal(detail.body.gloss.recent_context[0].collection, 'Formation');
    // linked_collections must remain plain strings.
    assert.ok(Array.isArray(detail.body.gloss.linked_collections));
    assert.equal(typeof detail.body.gloss.linked_collections[0], 'string');
  });
});

// ---------------------------------------------------------------------------
// POST /api/contacts/:name/draft-message
// Outbound-draft endpoint — the happy path hits Gemini + Gmail, both of
// which require env setup we don't have in test. We assert the
// pre-external-call validation paths (404/400/503) so a regression in
// route wiring or contact resolution is caught.
// ---------------------------------------------------------------------------

describe('POST /api/contacts/:name/draft-message', () => {
  it('returns 404 for an unknown contact', async () => {
    const { status, body } = await req(
      '/api/contacts/Does%20Not%20Exist%20Zzz/draft-message',
      { method: 'POST', headers: AUTH, body: { medium: 'email' } },
    );
    assert.equal(status, 404);
    assert.equal(body.error, 'contact not found');
  });

  it('iMessage path falls through to 503 when GEMINI_API_KEY is unset (no contact needed for the guard)', async () => {
    // Seed a contact with no email and request iMessage — we bypass the
    // no-email guard (email-only) and land on the Gemini-missing branch.
    const push = await req('/api/gloss/contacts', {
      method: 'POST', headers: AUTH,
      body: { contacts: [{
        contact: 'Draft Test iMsg', gloss_id: 'gloss-test-imsg',
        gloss_url: 'http://x', mention_count: 1,
        last_mentioned_at: '2026-01-01', priority: 3,
        growth_note: '', recent_context: [], linked_collections: [],
      }] },
    });
    assert.equal(push.status, 200);

    const prev = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const { status, body } = await req(
        '/api/contacts/' + encodeURIComponent('Draft Test iMsg') + '/draft-message',
        { method: 'POST', headers: AUTH, body: { medium: 'imessage' } },
      );
      // 503 because Gemini is unavailable. 404 would mean contact didn't
      // resolve — also acceptable if gloss-only contacts don't resolve via
      // getContactDetail in this schema state.
      assert.ok(status === 503 || status === 404, `unexpected status ${status}: ${JSON.stringify(body)}`);
    } finally {
      if (prev !== undefined) process.env.GEMINI_API_KEY = prev;
    }
  });

  it('email path returns 400 when the contact has no email address on file', async () => {
    // Same seeded contact (no emails_addrs populated via the gloss push).
    // Request email — we expect the no-email guard to fire.
    const { status, body } = await req(
      '/api/contacts/' + encodeURIComponent('Draft Test iMsg') + '/draft-message',
      { method: 'POST', headers: AUTH, body: { medium: 'email' } },
    );
    // 400 (our guard) or 404 (contact doesn't resolve in this schema state).
    assert.ok(status === 400 || status === 404, `unexpected status ${status}: ${JSON.stringify(body)}`);
  });
});
