'use strict';

// Gmail API integration — OAuth2 + email fetching (metadata only, no bodies).

const { google } = require('googleapis');

const REDIRECT_URI = `http://localhost:${process.env.PORT || 3748}/api/gmail/callback`;
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];

function makeClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    REDIRECT_URI,
  );
}

function getAuthUrl(loginHint) {
  const client = makeClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    login_hint: loginHint || undefined,
    prompt: 'consent',
  });
}

async function exchangeCode(code) {
  const client = makeClient();
  const { tokens } = await client.getToken(code);
  return tokens;
}

async function getAccountEmail(tokens) {
  const client = makeClient();
  client.setCredentials(tokens);
  const gmail = google.gmail({ version: 'v1', auth: client });
  const { data } = await gmail.users.getProfile({ userId: 'me' });
  return data.emailAddress;
}

// Returns { emails: [{direction, contact, subject}], refreshedTokens }
async function fetchEmailsForDate(tokenJson, date) {
  const client = makeClient();
  client.setCredentials(JSON.parse(tokenJson));

  let refreshedTokens = null;
  client.on('tokens', t => { refreshedTokens = t; });

  const gmail = google.gmail({ version: 'v1', auth: client });

  // Build date range — Gmail uses YYYY/M/D format; use UTC to avoid local-time day shift
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const afterStr  = `${y}/${m}/${d}`;
  const beforeStr = `${next.getUTCFullYear()}/${next.getUTCMonth() + 1}/${next.getUTCDate()}`;

  const emails = [];

  for (const [direction, labelQuery] of [
    ['received', `in:inbox after:${afterStr} before:${beforeStr}`],
    ['sent',     `in:sent  after:${afterStr} before:${beforeStr}`],
  ]) {
    try {
      const list = await gmail.users.messages.list({
        userId: 'me',
        q: labelQuery,
        maxResults: 100,
      });

      for (const msg of list.data.messages || []) {
        try {
          const detail = await gmail.users.messages.get({
            userId: 'me',
            id: msg.id,
            format: 'metadata',
            metadataHeaders: ['From', 'To', 'Subject'],
          });
          const headers = detail.data.payload?.headers || [];
          const h = name => headers.find(x => x.name.toLowerCase() === name)?.value || '';

          const rawContact = direction === 'received' ? h('from') : h('to');
          const contact = parseContact(rawContact);
          const subject = h('subject') || '(no subject)';

          const emailAddress = extractEmail(rawContact);
          if (contact) emails.push({ direction, contact, emailAddress, subject, snippet: detail.data.snippet || null });
        } catch (err) {
          console.warn(`[gmail] message fetch error: ${err.message}`);
        }
      }
    } catch (err) {
      console.warn(`[gmail] list error (${direction}): ${err.message}`);
      throw err; // re-throw so collect() can count it as an error
    }
  }

  return { emails, refreshedTokens };
}

// "Jane Doe <jane@example.com>" → "Jane Doe"
function parseContact(raw) {
  const m = raw.match(/^(.+?)\s*<[^>]+>/);
  return (m ? m[1].replace(/^["']|["']$/g, '') : raw).trim();
}

// Extract bare email address from a header value
function extractEmail(raw) {
  const m = raw.match(/<([^>]+)>/);
  return (m ? m[1] : raw.trim()).toLowerCase();
}

module.exports = { getAuthUrl, exchangeCode, getAccountEmail, fetchEmailsForDate, parseContact, extractEmail };
