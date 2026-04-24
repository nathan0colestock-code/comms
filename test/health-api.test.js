'use strict';

// Integration test for SPEC 3 HTTP endpoints:
//   GET /api/people/review
//   PATCH /api/contacts/:name
//   GET /api/contacts/:name/health

const os   = require('os');
const path = require('path');
const fs   = require('fs');
const http = require('http');
const Database = require('better-sqlite3');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-health-api-test-'));
process.env.COMMS_DB_PATH = path.join(tmpDir, 'test.db');
process.env.API_KEY       = 'health-api-key';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { getRuns, upsertGlossContact } = require('../collect');
const { app } = require('../server');

let server, baseUrl;

before(async () => {
  // Seed some data *before* the server does anything.
  getRuns();
  const db = new Database(process.env.COMMS_DB_PATH);
  db.pragma('foreign_keys = OFF');
  db.exec(`DELETE FROM messages; DELETE FROM emails; DELETE FROM gloss_contacts; DELETE FROM runs;`);
  db.prepare(`INSERT INTO runs (id, date, collected_at, status) VALUES ('run-1', '2026-04-01', ?, 'done')`)
    .run(new Date().toISOString());
  const ins = db.prepare(
    `INSERT INTO messages (id, run_id, date, contact, direction, sender, sent_at)
     VALUES (?, 'run-1', '2026-04-01', ?, 'sent', 'me', ?)`
  );
  ins.run('m-a', 'Alice API', new Date(Date.now() - 3 * 86400_000).toISOString());
  ins.run('m-c', 'Carol API', new Date(Date.now() - 30 * 86400_000).toISOString());
  db.pragma('foreign_keys = ON');
  db.close();

  upsertGlossContact({ contact: 'Alice API', gloss_id: 'g-a', gloss_url: 'x', priority: 1 });
  upsertGlossContact({ contact: 'Carol API', gloss_id: 'g-c', gloss_url: 'x', priority: 1 });

  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function req(urlPath, { headers = {}, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const payload = body != null ? JSON.stringify(body) : null;
    const hdrs = { ...headers };
    if (payload) {
      hdrs['Content-Type'] = 'application/json';
      hdrs['Content-Length'] = Buffer.byteLength(payload);
    }
    const r = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname + url.search,
      method, headers: hdrs,
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

const AUTH = { Authorization: 'Bearer health-api-key' };

describe('GET /api/people/review', () => {
  it('returns contacts sorted by health DESC by default', async () => {
    const r = await req('/api/people/review', { headers: AUTH });
    assert.equal(r.status, 200);
    assert.equal(r.body.sort, 'health');
    const names = r.body.people.map(p => p.contact);
    // Carol (30d overdue) should come before Alice (fresh).
    assert.ok(names.indexOf('Carol API') < names.indexOf('Alice API'));
  });

  it('accepts ?sort=alpha for the legacy order', async () => {
    const r = await req('/api/people/review?sort=alpha', { headers: AUTH });
    assert.equal(r.status, 200);
    assert.equal(r.body.sort, 'alpha');
    const names = r.body.people.map(p => p.contact);
    assert.deepEqual(names, names.slice().sort((a, b) => a.localeCompare(b)));
  });
});

describe('PATCH /api/contacts/:name', () => {
  it('persists target_cadence_days and reflects in the health score', async () => {
    const r = await req('/api/contacts/Carol%20API', {
      method: 'PATCH', headers: AUTH, body: { target_cadence_days: 180 },
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.health.target, 180);
    // 30 days vs 180 target = healthy.
    assert.equal(r.body.health.band, 'healthy');

    const again = await req('/api/contacts/Carol%20API/health', { headers: AUTH });
    assert.equal(again.body.health.target, 180);
  });

  it('rejects missing target_cadence_days', async () => {
    const r = await req('/api/contacts/Carol%20API', {
      method: 'PATCH', headers: AUTH, body: {},
    });
    assert.equal(r.status, 400);
  });

  it('returns 404 on unknown contact', async () => {
    const r = await req('/api/contacts/Does%20Not%20Exist', {
      method: 'PATCH', headers: AUTH, body: { target_cadence_days: 30 },
    });
    assert.equal(r.status, 404);
  });
});
