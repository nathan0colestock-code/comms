'use strict';

const os   = require('os');
const path = require('path');
const fs   = require('fs');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-mcp-test-'));
process.env.COMMS_DB_PATH = path.join(tmpDir, 'test.db');

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

// Seed the DB via collect's openDb path, then test the MCP handlers directly
const Database = require('better-sqlite3');
const { DB_PATH } = require('../collect');
const { handleSearchByContact, handleSearchByTopic } = require('../mcp');

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function seedDb() {
  // Initialise schema by calling getRuns (triggers openDb)
  require('../collect').getRuns();

  const db = new Database(DB_PATH);
  const runId = 'test-run-1';
  db.prepare(`INSERT OR IGNORE INTO runs (id, date, collected_at, status) VALUES (?, ?, ?, 'done')`)
    .run(runId, '2026-01-15', new Date().toISOString());

  db.prepare(`INSERT INTO messages (id, run_id, date, contact, handle_id, direction, sender, text, sent_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('msg-1', runId, '2026-01-15', 'Alice Smith', '+15555550100', 'received', 'Alice Smith', 'Hey, lunch tomorrow?', '2026-01-15T12:00:00.000Z');

  db.prepare(`INSERT INTO messages (id, run_id, date, contact, handle_id, direction, sender, text, sent_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('msg-2', runId, '2026-01-15', 'Alice Smith', '+15555550100', 'sent', 'Me', 'Sounds great!', '2026-01-15T12:05:00.000Z');

  db.prepare(`INSERT INTO emails (id, run_id, date, direction, contact, email_address, subject, snippet, account)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('email-1', runId, '2026-01-15', 'received', 'Bob Jones', 'bob@example.com', 'Project update', 'Here is the latest status on the project', 'me@example.com');

  db.close();
}

seedDb();

describe('search_by_contact', () => {
  it('finds messages and emails matching a name', () => {
    const result = handleSearchByContact({ name: 'Alice' });
    assert.ok(result.content);
    const data = JSON.parse(result.content[0].text);
    assert.ok(data.messages.length >= 2);
    assert.ok(data.messages.every(m => /alice/i.test(m.contact) || /alice/i.test(m.sender)));
    assert.equal(data.emails.length, 0);
  });

  it('finds emails matching an email address', () => {
    const result = handleSearchByContact({ name: 'bob@example.com' });
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.emails.length, 1);
    assert.equal(data.emails[0].contact, 'Bob Jones');
  });

  it('returns empty arrays when no match', () => {
    const result = handleSearchByContact({ name: 'Zzz No Match' });
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.messages.length, 0);
    assert.equal(data.emails.length, 0);
  });
});

describe('search_by_topic', () => {
  it('finds messages containing the query word', () => {
    const result = handleSearchByTopic({ query: 'lunch' });
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.messages.length, 1);
    assert.ok(data.messages[0].text.includes('lunch'));
  });

  it('finds emails by subject', () => {
    const result = handleSearchByTopic({ query: 'Project update' });
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.emails.length, 1);
    assert.equal(data.emails[0].subject, 'Project update');
  });

  it('finds emails by snippet', () => {
    const result = handleSearchByTopic({ query: 'latest status' });
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.emails.length, 1);
  });

  it('returns empty arrays when no match', () => {
    const result = handleSearchByTopic({ query: 'zzz-no-match' });
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.messages.length, 0);
    assert.equal(data.emails.length, 0);
  });
});
