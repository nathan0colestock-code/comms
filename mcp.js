#!/usr/bin/env node
'use strict';

const { McpServer }         = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z }                 = require('zod');
const Database              = require('better-sqlite3');
const { DB_PATH, getNudges, getContactDetail } = require('./collect');

const server = new McpServer({ name: 'comms', version: '0.1.0' });

function openReadOnly() {
  return new Database(DB_PATH, { readonly: true });
}

function handleSearchByContact({ name }) {
  const db = openReadOnly();
  try {
    const pattern = `%${name}%`;
    const messages = db.prepare(`
      SELECT date, contact, sender, direction, text, sent_at
      FROM messages
      WHERE contact LIKE ? OR sender LIKE ?
      ORDER BY sent_at DESC
      LIMIT 50
    `).all(pattern, pattern);

    const emails = db.prepare(`
      SELECT date, contact, email_address, direction, subject, snippet
      FROM emails
      WHERE contact LIKE ? OR email_address LIKE ?
      ORDER BY rowid DESC
      LIMIT 50
    `).all(pattern, pattern);

    return { content: [{ type: 'text', text: JSON.stringify({ messages, emails }, null, 2) }] };
  } finally {
    db.close();
  }
}

function handleSearchByTopic({ query }) {
  const db = openReadOnly();
  try {
    const pattern = `%${query}%`;
    const messages = db.prepare(`
      SELECT date, contact, sender, direction, text, sent_at
      FROM messages
      WHERE text LIKE ?
      ORDER BY sent_at DESC
      LIMIT 50
    `).all(pattern);

    const emails = db.prepare(`
      SELECT date, contact, email_address, direction, subject, snippet
      FROM emails
      WHERE subject LIKE ? OR snippet LIKE ?
      ORDER BY rowid DESC
      LIMIT 50
    `).all(pattern, pattern);

    return { content: [{ type: 'text', text: JSON.stringify({ messages, emails }, null, 2) }] };
  } finally {
    db.close();
  }
}

server.tool(
  'search_by_contact',
  'Find the most recent iMessages and emails with a specific person.',
  { name: z.string().min(1).describe('Name or email address of the person') },
  handleSearchByContact,
);

server.tool(
  'search_by_topic',
  'Find iMessages and emails about a specific topic or keyword.',
  { query: z.string().min(1).describe('Word or phrase to search for') },
  handleSearchByTopic,
);

// Nudges — relationships the user should reach out to soon. Wraps the same
// helper that feeds the contact-list sidebar; read-only.
function handleGetNudges() {
  return { content: [{ type: 'text', text: JSON.stringify(getNudges(), null, 2) }] };
}

server.tool(
  'get_nudges',
  "Get the suggested outreach nudges (contacts to reach out to, with reasons).",
  {},
  handleGetNudges,
);

// Contact detail — everything comms knows about one person: recent
// messages + emails, calendar events, gloss profile, special dates.
function handleGetContactDetail({ name }) {
  const detail = getContactDetail(name);
  return { content: [{ type: 'text', text: JSON.stringify(detail, null, 2) }] };
}

server.tool(
  'get_contact_detail',
  'Get the full comms profile for one contact: recent messages, emails, calendar events, gloss profile, special dates.',
  { name: z.string().min(1).describe('Contact display name or identifier') },
  handleGetContactDetail,
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('Comms MCP server running\n');
}

if (require.main === module) {
  main().catch(e => {
    process.stderr.write(`Fatal: ${e.message}\n`);
    process.exit(1);
  });
} else {
  module.exports = { handleSearchByContact, handleSearchByTopic, handleGetNudges, handleGetContactDetail };
}
