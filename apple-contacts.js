'use strict';

// Apple Contacts importer — direct SQLite read of the macOS AddressBook store.
//
// The macOS Contacts app writes into ~/Library/Application Support/AddressBook:
//   - AddressBook-v22.abcddb         (aggregated / "local" store)
//   - Sources/<UUID>/AddressBook-v22.abcddb   (one per CardDAV / iCloud / Exchange source)
//
// We open each DB readonly and union all person records (ZUNIQUEID ending in
// ':ABPerson'), deduping across sources. Requires Full Disk Access on the
// host process — same TCC grant iMessage ingestion already uses.

const fs       = require('fs');
const os       = require('os');
const path     = require('path');
const Database = require('better-sqlite3');

const AB_BASE = path.join(os.homedir(), 'Library/Application Support/AddressBook');

function listSourceDbs() {
  const paths = [];
  const main = path.join(AB_BASE, 'AddressBook-v22.abcddb');
  if (fs.existsSync(main)) paths.push(main);
  const srcDir = path.join(AB_BASE, 'Sources');
  if (fs.existsSync(srcDir)) {
    for (const dir of fs.readdirSync(srcDir)) {
      const p = path.join(srcDir, dir, 'AddressBook-v22.abcddb');
      if (fs.existsSync(p)) paths.push(p);
    }
  }
  return paths;
}

// Core Data stores timestamps as seconds since 2001-01-01T00:00:00Z.
function coreDataToIso(n) {
  if (n == null || Number.isNaN(Number(n))) return null;
  const ms = (Number(n) + 978307200) * 1000;
  const d = new Date(ms);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function buildDisplayName(r) {
  const parts = [r.ZFIRSTNAME, r.ZMIDDLENAME, r.ZLASTNAME].filter(Boolean);
  if (parts.length) return parts.join(' ').trim();
  return (r.ZNICKNAME || r.ZORGANIZATION || '').trim();
}

function parseCoreDataBirthday(n) {
  const iso = coreDataToIso(n);
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return { year: d.getUTCFullYear() || null, month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function readDbContacts(dbPath) {
  const out = [];
  let db;
  try {
    db = new Database(dbPath, { readonly: true, timeout: 3000 });
  } catch (e) {
    return { contacts: [], error: e.message };
  }

  try {
    const people = db.prepare(`
      SELECT Z_PK, ZUNIQUEID, ZLINKID, ZFIRSTNAME, ZMIDDLENAME, ZLASTNAME, ZNICKNAME,
             ZORGANIZATION, ZJOBTITLE, ZMODIFICATIONDATE, ZBIRTHDAY
      FROM ZABCDRECORD
      WHERE ZUNIQUEID LIKE '%:ABPerson'
        AND (ZFIRSTNAME IS NOT NULL OR ZLASTNAME IS NOT NULL OR ZORGANIZATION IS NOT NULL OR ZNICKNAME IS NOT NULL)
    `).all();

    const emailsByOwner = new Map();
    for (const e of db.prepare(`
      SELECT ZOWNER, ZADDRESS, ZADDRESSNORMALIZED, ZLABEL
      FROM ZABCDEMAILADDRESS
      WHERE ZADDRESS IS NOT NULL
      ORDER BY ZORDERINGINDEX ASC
    `).all()) {
      if (!emailsByOwner.has(e.ZOWNER)) emailsByOwner.set(e.ZOWNER, []);
      emailsByOwner.get(e.ZOWNER).push({
        value: (e.ZADDRESSNORMALIZED || e.ZADDRESS).toLowerCase(),
        label: cleanLabel(e.ZLABEL),
      });
    }

    const phonesByOwner = new Map();
    for (const p of db.prepare(`
      SELECT ZOWNER, ZFULLNUMBER, ZLABEL
      FROM ZABCDPHONENUMBER
      WHERE ZFULLNUMBER IS NOT NULL
      ORDER BY ZORDERINGINDEX ASC
    `).all()) {
      if (!phonesByOwner.has(p.ZOWNER)) phonesByOwner.set(p.ZOWNER, []);
      phonesByOwner.get(p.ZOWNER).push({
        value: p.ZFULLNUMBER,
        label: cleanLabel(p.ZLABEL),
      });
    }

    // Notes are stored in the ZABCDNOTE table linked via ZCONTACT (varies by
    // macOS version). If the table shape has shifted we just skip — we don't
    // want to block the whole import on one optional field.
    let notesByOwner = new Map();
    try {
      const noteRows = db.prepare(`
        SELECT ZCONTACT AS owner, ZTEXT AS text
        FROM ZABCDNOTE
        WHERE ZTEXT IS NOT NULL AND ZCONTACT IS NOT NULL
      `).all();
      for (const n of noteRows) notesByOwner.set(n.owner, n.text);
    } catch { /* column differs or table missing — skip notes */ }

    for (const r of people) {
      const source_id = r.ZUNIQUEID; // includes ':ABPerson' suffix → globally unique
      if (!source_id) continue;
      out.push({
        source: 'apple',
        source_account: 'local',
        source_id,
        link_id:      r.ZLINKID || null, // Apple's "unified contact" anchor — same across sources
        display_name: buildDisplayName(r) || null,
        given_name:   r.ZFIRSTNAME || null,
        family_name:  r.ZLASTNAME || null,
        nickname:     r.ZNICKNAME || null,
        organization: r.ZORGANIZATION || null,
        job_title:    r.ZJOBTITLE || null,
        emails:       emailsByOwner.get(r.Z_PK) || [],
        phones:       phonesByOwner.get(r.Z_PK) || [],
        photo_url:    null,
        notes:        notesByOwner.get(r.Z_PK) || null,
        source_modified_at: coreDataToIso(r.ZMODIFICATIONDATE),
        birthday:     r.ZBIRTHDAY != null ? parseCoreDataBirthday(r.ZBIRTHDAY) : null,
      });
    }
    return { contacts: out };
  } finally {
    db.close();
  }
}

// Apple labels come wrapped in CoreData tags like "_$!<Mobile>!$_" — strip.
function cleanLabel(raw) {
  if (!raw) return null;
  const m = String(raw).match(/<([^>]+)>/);
  return (m ? m[1] : raw).trim() || null;
}

// Merge contacts across source DBs. ZUNIQUEID is globally unique across iOS/
// macOS sync, so keying on source_id dedupes cleanly. When the same person
// appears in multiple sources we keep the one with the latest
// source_modified_at and union the identifiers.
function mergeAcrossSources(arraysOfContacts) {
  const map = new Map();
  for (const arr of arraysOfContacts) {
    for (const c of arr) {
      const existing = map.get(c.source_id);
      if (!existing) { map.set(c.source_id, c); continue; }
      // Pick the newer record for scalar fields.
      const pick =
        (c.source_modified_at && (!existing.source_modified_at ||
         c.source_modified_at > existing.source_modified_at)) ? c : existing;
      const other = pick === c ? existing : c;
      // Union identifiers by value.
      const mergedEmails = unionBy([...pick.emails, ...other.emails], x => x.value);
      const mergedPhones = unionBy([...pick.phones, ...other.phones], x => x.value);
      map.set(c.source_id, { ...pick, emails: mergedEmails, phones: mergedPhones });
    }
  }
  return [...map.values()];
}

function unionBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (k == null || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

async function importAppleContacts({
  upsertAddressBookContact,
  pruneAddressBookAccount,
  recordAddressBookSync,
  upsertSpecialDate,
}) {
  const dbPaths = listSourceDbs();
  if (!dbPaths.length) {
    return { ok: false, error: 'No AddressBook DBs found. Grant Full Disk Access?', total: 0, upserted: 0, removed: 0 };
  }

  const perDb = [];
  const errors = [];
  for (const p of dbPaths) {
    const { contacts, error } = readDbContacts(p);
    if (error) errors.push(`${path.basename(path.dirname(p))}: ${error}`);
    perDb.push(contacts);
  }
  const contacts = mergeAcrossSources(perDb);

  let upserted = 0;
  for (const c of contacts) {
    try { upsertAddressBookContact(c); upserted++; }
    catch (e) { errors.push(`${c.source_id}: ${e.message}`); }
    if (upsertSpecialDate && c.birthday?.month && c.birthday?.day && c.display_name) {
      try {
        upsertSpecialDate({
          id: `apple:${c.link_id || c.source_id}:birthday`,
          contact: c.display_name,
          type: 'birthday',
          month: c.birthday.month,
          day: c.birthday.day,
          year: c.birthday.year || null,
          label: null,
          notes: null,
          source: 'apple',
          source_id: c.source_id,
        });
      } catch (e) { errors.push(`birthday ${c.source_id}: ${e.message}`); }
    }
  }
  const removed = pruneAddressBookAccount('apple', 'local', contacts.map(c => c.source_id));
  const error = errors.length ? errors.slice(0, 5).join(' | ') : null;
  recordAddressBookSync({ source: 'apple', source_account: 'local', total: contacts.length, upserted, removed, error });
  return { ok: true, total: contacts.length, upserted, removed, error };
}

module.exports = { importAppleContacts, listSourceDbs };
