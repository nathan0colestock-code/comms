'use strict';

// log.js contract tests: ring buffer cap, level filter, middleware fires
// per request, and /api/logs/recent is bearer-gated.

const os   = require('os');
const path = require('path');
const fs   = require('fs');
const http = require('http');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-log-test-'));
process.env.COMMS_DB_PATH = path.join(tmpDir, 'test.db');
process.env.API_KEY       = 'log-test-key';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  log, getRecent, MAX_BUFFER,
  _clearBufferForTests, _bufferSizeForTests,
} = require('../log');
const { app } = require('../server');

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

let server, baseUrl;
before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});
after(async () => new Promise(resolve => server.close(resolve)));

function req(urlPath, { headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const r = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname + url.search,
      method, headers,
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body), headers: res.headers }); }
        catch { resolve({ status: res.statusCode, body, headers: res.headers }); }
      });
    });
    r.on('error', reject);
    r.end();
  });
}

describe('log()', () => {
  it('emits entries with the requested level and event', () => {
    _clearBufferForTests();
    log('warn', 'test_event', { k: 'v' });
    const entries = getRecent({ level: 'debug', limit: 10 });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].level, 'warn');
    assert.equal(entries[0].event, 'test_event');
  });

  it('ring buffer is bounded at MAX_BUFFER entries', () => {
    _clearBufferForTests();
    for (let i = 0; i < MAX_BUFFER + 50; i++) log('info', 'burst', { i });
    assert.equal(_bufferSizeForTests(), MAX_BUFFER);
  });

  it('level filter drops lower-level entries', () => {
    _clearBufferForTests();
    log('debug', 'a');
    log('info',  'b');
    log('warn',  'c');
    log('error', 'd');
    const onlyWarnPlus = getRecent({ level: 'warn', limit: 10 });
    const events = onlyWarnPlus.map(e => e.event);
    assert.ok(!events.includes('a'));
    assert.ok(!events.includes('b'));
    assert.ok(events.includes('c'));
    assert.ok(events.includes('d'));
  });
});

describe('/api/logs/recent', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await req('/api/logs/recent');
    assert.equal(res.status, 401);
  });

  it('returns entries with a valid bearer', async () => {
    _clearBufferForTests();
    log('info', 'seed_for_endpoint', {});
    const res = await req('/api/logs/recent', {
      headers: { Authorization: 'Bearer log-test-key' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    const events = res.body.entries.map(e => e.event);
    // http-middleware will have logged this request too.
    assert.ok(events.includes('seed_for_endpoint'));
  });

  it('logs every request through the http middleware', async () => {
    _clearBufferForTests();
    await req('/api/health'); // anonymous — auth-bypassed
    const entries = getRecent({ limit: 20 });
    const http_entries = entries.filter(e => e.event === 'http');
    assert.ok(http_entries.length >= 1);
    assert.ok(http_entries.some(e => e.ctx?.path === '/api/health'));
  });

  it('propagates the X-Trace-Id header both ways', async () => {
    const res = await req('/api/health', { headers: { 'X-Trace-Id': 'fixed-trace-id-123' } });
    assert.equal(res.headers['x-trace-id'], 'fixed-trace-id-123');
  });
});
