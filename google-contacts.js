'use strict';

// Google Contacts importer — uses the People API (not the deprecated v3
// Contacts API) to pull all connections for a user. Requires OAuth scope
// 'https://www.googleapis.com/auth/contacts.readonly' — accounts that
// predate the scope must be reconnected from the settings UI.

const { google } = require('googleapis');

const PERSON_FIELDS = [
  'names',
  'nicknames',
  'emailAddresses',
  'phoneNumbers',
  'organizations',
  'photos',
  'biographies',
  'metadata',
  'birthdays',
].join(',');

function makeAuthClient() {
  const origin = process.env.PUBLIC_ORIGIN || `http://localhost:${process.env.PORT || 3748}`;
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `${origin.replace(/\/+$/, '')}/api/gmail/callback`,
  );
}

// Map a People API "Person" payload to our address_book record shape.
function mapPerson(p, account) {
  if (!p || !p.resourceName) return null;
  const primary = (arr) => {
    if (!Array.isArray(arr) || !arr.length) return null;
    return arr.find(x => x.metadata?.primary) || arr[0];
  };

  const nm = primary(p.names);
  const given_name  = nm?.givenName || null;
  const family_name = nm?.familyName || null;
  const display_name =
    (nm?.displayName || [given_name, family_name].filter(Boolean).join(' ')).trim() ||
    null;

  const nickname = primary(p.nicknames)?.value || null;

  const org  = primary(p.organizations);
  const organization = org?.name || null;
  const job_title    = org?.title || null;

  const emails = Array.isArray(p.emailAddresses)
    ? p.emailAddresses
        .filter(e => e.value)
        .map(e => ({ value: String(e.value).trim().toLowerCase(), label: e.type || e.formattedType || null }))
    : [];

  const phones = Array.isArray(p.phoneNumbers)
    ? p.phoneNumbers
        .filter(ph => ph.value || ph.canonicalForm)
        .map(ph => ({ value: ph.canonicalForm || ph.value, label: ph.type || ph.formattedType || null }))
    : [];

  const photo_url = primary(p.photos)?.url || null;
  const notes = primary(p.biographies)?.value || null;

  // sources[] on metadata has updateTime for the primary source.
  const src = Array.isArray(p.metadata?.sources)
    ? p.metadata.sources.find(s => s.updateTime) || p.metadata.sources[0]
    : null;
  const source_modified_at = src?.updateTime || null;

  const bday = primary(p.birthdays);
  const birthday = (bday?.date?.month && bday?.date?.day)
    ? { year: bday.date.year || null, month: bday.date.month, day: bday.date.day }
    : null;

  return {
    source: 'google',
    source_account: account,
    source_id: p.resourceName, // 'people/c1234567890'
    display_name,
    given_name,
    family_name,
    nickname,
    organization,
    job_title,
    emails,
    phones,
    photo_url,
    notes,
    source_modified_at,
    birthday,
  };
}

async function fetchGoogleContacts(tokenJson, account) {
  const client = makeAuthClient();
  client.setCredentials(typeof tokenJson === 'string' ? JSON.parse(tokenJson) : tokenJson);

  let refreshedTokens = null;
  client.on('tokens', t => { refreshedTokens = t; });

  const people = google.people({ version: 'v1', auth: client });
  const contacts = [];
  let pageToken;
  // People API hard-limits pageSize to 1000.
  do {
    const { data } = await people.people.connections.list({
      resourceName: 'people/me',
      personFields: PERSON_FIELDS,
      pageSize: 1000,
      pageToken,
      sortOrder: 'LAST_MODIFIED_DESCENDING',
    });
    for (const p of data.connections || []) {
      const mapped = mapPerson(p, account);
      if (mapped) contacts.push(mapped);
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return { contacts, refreshedTokens };
}

// Orchestrator: imports contacts for a single Google account and writes to DB.
async function importGoogleContactsForAccount({
  account,
  tokenJson,
  upsertAddressBookContact,
  pruneAddressBookAccount,
  recordAddressBookSync,
  saveRefreshedTokens,
  upsertSpecialDate,
}) {
  const errors = [];
  let contacts = [];
  let refreshed = null;
  try {
    const res = await fetchGoogleContacts(tokenJson, account);
    contacts = res.contacts;
    refreshed = res.refreshedTokens;
  } catch (e) {
    const msg = e.message || String(e);
    recordAddressBookSync({ source: 'google', source_account: account, total: 0, upserted: 0, removed: 0, error: msg });
    return { ok: false, account, error: msg, total: 0, upserted: 0, removed: 0 };
  }

  if (refreshed && saveRefreshedTokens) {
    try { saveRefreshedTokens(refreshed); } catch (e) { errors.push(`tokens: ${e.message}`); }
  }

  let upserted = 0;
  for (const c of contacts) {
    try { upsertAddressBookContact(c); upserted++; }
    catch (e) { errors.push(`${c.source_id}: ${e.message}`); }
    if (upsertSpecialDate && c.birthday?.month && c.birthday?.day && c.display_name) {
      try {
        upsertSpecialDate({
          id: `google:${c.source_id}:birthday`,
          contact: c.display_name,
          type: 'birthday',
          month: c.birthday.month,
          day: c.birthday.day,
          year: c.birthday.year || null,
          label: null,
          notes: null,
          source: 'google',
          source_id: c.source_id,
        });
      } catch (e) { errors.push(`birthday ${c.source_id}: ${e.message}`); }
    }
  }
  const removed = pruneAddressBookAccount('google', account, contacts.map(c => c.source_id));
  const error = errors.length ? errors.slice(0, 5).join(' | ') : null;
  recordAddressBookSync({ source: 'google', source_account: account, total: contacts.length, upserted, removed, error });
  return { ok: true, account, total: contacts.length, upserted, removed, error };
}

module.exports = { fetchGoogleContacts, importGoogleContactsForAccount, mapPerson };
