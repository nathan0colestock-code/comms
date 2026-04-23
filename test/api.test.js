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

function req(urlPath, { headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const options = { hostname: url.hostname, port: url.port, path: url.pathname, method, headers };
    const r = http.request(options, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, body }); }
      });
    });
    r.on('error', reject);
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

  it('serves the dashboard at / without auth', async () => {
    const { status } = await req('/');
    assert.equal(status, 200);
  });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

describe('GET /api/status', () => {
  it('returns ok and db path', async () => {
    const { status, body } = await req('/api/status', { headers: AUTH });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(typeof body.db === 'string');
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
