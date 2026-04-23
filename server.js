#!/usr/bin/env node
/**
 * server.js — Comm's: relationship intelligence
 *
 * Port 3748. Reads/writes SQLite via collect.js. Serves the web UI from
 * public/index.html and a JSON API under /api/*.
 *
 * Auth model:
 *   - /api/gloss/contacts uses the legacy API_KEY bearer token (called from
 *     Gloss; no user session).
 *   - Everything else is protected by a cookie session (POST /api/login with
 *     AUTH_PASSWORD → cookie, checked by requireAuth).
 *   - /login, /api/login, /api/logout, /api/health, /api/gmail/callback are
 *     public.
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const express = require('express');
const helmet  = require('helmet');

// Load .env before requiring modules that read process.env
function loadEnv() {
  const p = path.join(__dirname, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
loadEnv();

const {
  collect, getRuns, getRunDetail, getMissingDates,
  getGmailAccounts, saveGmailAccount, deleteGmailAccount, saveGmailTokens,
  testMessagesAccess,
  upsertGlossContact, upsertGlossNote,
  listContacts, getContactDetail, getRecentCommsForAI,
  getGlossContact, saveContactInsight,
  upsertCalendarEvents, pruneOldCalendarEvents, listCalendarEvents, getCalendarEvent,
  getMeetingBrief, saveMeetingBrief,
  getNudges, dismissNudge,
  getContactProfile, saveContactProfile, renameContact,
  listAgendaItems, addAgendaItem, updateAgendaItem, deleteAgendaItem,
  listCustomPlaybookModels, getCustomPlaybookModel, saveCustomPlaybookModel, deleteCustomPlaybookModel,
  upsertAddressBookContact, pruneAddressBookAccount, recordAddressBookSync,
  listAddressBook, getAddressBookContact, findAddressBookByIdentifiers, addressBookStats,
  rebuildPeople, resolvePerson, getPerson, mergePeople, rejectMergePair, findDuplicateCandidates,
  getOverview, getSuiteStatusMetrics, searchAll,
  getSetting, saveSetting,
  upsertSpecialDate, listUpcomingSpecialDates, listSpecialDates, deleteSpecialDate,
  getRecentSentMessagesForStyle,
  DB_PATH,
} = require('./collect');
const { getAuthUrl, exchangeCode, getAccountEmail, hasScope } = require('./gmail');
const { fetchCalendarEvents, fetchCalendarList } = require('./calendar');

const PORT = parseInt(process.env.PORT || '3748', 10);
const IS_PROD = process.env.NODE_ENV === 'production';

// ─── App / middleware ───────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));

// ─── Auth ───────────────────────────────────────────────────────────────────
let AUTH_PASSWORD  = process.env.AUTH_PASSWORD;
let SESSION_SECRET = process.env.SESSION_SECRET;
if (IS_PROD) {
  if (!AUTH_PASSWORD || !SESSION_SECRET) {
    console.error('[auth] AUTH_PASSWORD and SESSION_SECRET must be set in production.');
    process.exit(1);
  }
} else {
  if (!AUTH_PASSWORD)  { AUTH_PASSWORD  = 'dev'; console.warn('\x1b[33m[auth] AUTH_PASSWORD unset — using dev fallback "dev"\x1b[0m'); }
  if (!SESSION_SECRET) { SESSION_SECRET = 'dev'; console.warn('\x1b[33m[auth] SESSION_SECRET unset — using dev fallback "dev"\x1b[0m'); }
}
const COOKIE_NAME = 'comms_auth';
const COOKIE_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const AUTH_BYPASS = new Set([
  '/login', '/api/login', '/api/logout', '/api/health',
  '/api/gmail/callback',
  '/favicon.ico', '/favicon.svg', '/apple-touch-icon.png', '/manifest.json',
  '/icon-192.png', '/icon-512.png',
]);

function signCookie(payload) {
  const p = Buffer.from(String(payload), 'utf8').toString('base64url');
  const mac = crypto.createHmac('sha256', SESSION_SECRET).update(p).digest('hex');
  return `${p}.${mac}`;
}
function verifyCookie(raw) {
  if (!raw || typeof raw !== 'string') return false;
  const dot = raw.lastIndexOf('.');
  if (dot < 0) return false;
  const p = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(p).digest('hex');
  const a = Buffer.from(mac, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const ts = parseInt(Buffer.from(p, 'base64url').toString('utf8'), 10);
  if (!Number.isFinite(ts)) return false;
  if (Date.now() - ts > COOKIE_MAX_AGE_MS) return false;
  return true;
}
function parseAuthCookie(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === COOKIE_NAME) return rest.join('=');
  }
  return null;
}
function requireAuth(req, res, next) {
  if (AUTH_BYPASS.has(req.path)) return next();
  // Bearer / X-API-Key is accepted on any /api/* route (Gloss push, tests,
  // MCP, curl). Cookie auth is for the browser UI.
  if (req.path.startsWith('/api/') && requireApiKey(req)) return next();
  if (verifyCookie(parseAuthCookie(req))) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'auth required' });
  return res.redirect('/login');
}

function requireApiKey(req) {
  // Accept either the app's own API_KEY or the shared SUITE_API_KEY. This
  // lets suite-wide orchestration (status polling, cross-app calls) use a
  // single credential without the per-app keys sprawling through the caller.
  const appKey   = process.env.API_KEY || null;
  const suiteKey = process.env.SUITE_API_KEY || null;
  if (!appKey && !suiteKey) return false;
  const auth = req.headers['authorization'];
  const provided = (auth?.startsWith('Bearer ') ? auth.slice(7) : null) ?? req.headers['x-api-key'];
  if (!provided) return false;
  const a = Buffer.from(String(provided));
  for (const k of [appKey, suiteKey]) {
    if (!k) continue;
    const b = Buffer.from(k);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

const LOGIN_RATE = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX = 5;
function loginRateLimit(req, res, next) {
  const key = req.ip || 'unknown';
  const now = Date.now();
  const rec = LOGIN_RATE.get(key);
  if (rec && now - rec.firstAttemptAt > LOGIN_WINDOW_MS) LOGIN_RATE.delete(key);
  const cur = LOGIN_RATE.get(key);
  if (cur && cur.count >= LOGIN_MAX) {
    const retry = Math.ceil((cur.firstAttemptAt + LOGIN_WINDOW_MS - now) / 1000);
    res.set('Retry-After', String(Math.max(retry, 1)));
    return res.status(429).json({ error: 'too many attempts' });
  }
  if (LOGIN_RATE.size > 1000) {
    for (const [k, v] of LOGIN_RATE) {
      if (now - v.firstAttemptAt > LOGIN_WINDOW_MS) LOGIN_RATE.delete(k);
    }
  }
  next();
}
function recordLoginAttempt(req) {
  const key = req.ip || 'unknown';
  const cur = LOGIN_RATE.get(key);
  if (cur) cur.count++;
  else LOGIN_RATE.set(key, { count: 1, firstAttemptAt: Date.now() });
}

app.get('/api/health', (req, res) => res.json({ ok: true, now: Date.now() }));

app.get('/login', (req, res) => {
  const err = req.query.error ? '<p style="color:#e05c5c;margin:0">Wrong password.</p>' : '';
  res.type('html').send(`<!doctype html><meta charset=utf-8><title>Comm's · Sign in</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:16px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0f1117;color:#e2e4ec}
form{display:flex;flex-direction:column;gap:.75rem;padding:2rem;border:1px solid #2a2d3a;border-radius:12px;background:#1a1d27;min-width:260px}
h2{margin:0 0 .25rem;font-size:20px;letter-spacing:0.01em}
input,button{font:inherit;padding:.55rem .8rem;border:1px solid #2a2d3a;border-radius:8px;background:#0f1117;color:#e2e4ec}
button{background:#7c9ef8;color:#fff;border-color:#7c9ef8;cursor:pointer;font-weight:500}
button:hover{filter:brightness(1.1)}</style>
<form method="POST" action="/api/login"><h2>Comm's</h2>${err}
<input type="password" name="password" autofocus required placeholder="Password"/>
<button type="submit">Sign in</button></form>`);
});

app.post('/api/login', loginRateLimit, (req, res) => {
  const pw = (req.body && typeof req.body.password === 'string') ? req.body.password : '';
  const a = Buffer.from(pw);
  const b = Buffer.from(AUTH_PASSWORD);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) {
    recordLoginAttempt(req);
    if (req.is('json')) return res.status(401).json({ error: 'wrong password' });
    return res.redirect('/login?error=1');
  }
  const cookie = signCookie(Date.now());
  const secure = IS_PROD ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${cookie}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=${Math.floor(COOKIE_MAX_AGE_MS / 1000)}`);
  if (req.is('json')) return res.json({ ok: true });
  res.redirect('/');
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; Max-Age=0`);
  if (req.is('json')) return res.json({ ok: true });
  res.redirect('/login');
});

app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));

// ─── In-flight ingest jobs ──────────────────────────────────────────────────
const jobs = new Map();

// ─── Collection API (existing) ──────────────────────────────────────────────
// Suite-wide status shape: a compact, stable envelope the orchestrator polls.
// Metrics are best-effort — getSuiteStatusMetrics() already swallows per-table
// errors so a partial schema still produces a 200. The old overview is still
// available via the /api/overview alias below for any in-app consumers.
const PKG_VERSION = (() => {
  try { return require('./package.json').version || '0.0.0'; }
  catch { return '0.0.0'; }
})();

app.get('/api/status', (req, res) => {
  res.json({
    app: 'comms',
    version: PKG_VERSION,
    ok: true,
    uptime_seconds: Math.floor(process.uptime()),
    metrics: getSuiteStatusMetrics(),
  });
});

// Legacy overview surface — used by the in-app UI and older tests.
app.get('/api/overview', (req, res) => {
  try { res.json({ ok: true, db: DB_PATH, ...getOverview() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Unified search across messages, emails, and contacts.
app.get('/api/search', (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    res.json(searchAll(q, { limit: Math.min(parseInt(req.query.limit, 10) || 25, 100) }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/runs', (req, res) => {
  try { res.json(getRuns()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/runs/:date', (req, res) => {
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date' });
  try {
    const detail = getRunDetail(date);
    if (!detail) return res.status(404).json({ error: 'No run for this date' });
    const job = jobs.get(date);
    res.json({ ...detail, job: job ? { running: job.running, log: job.log } : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/collect/catchup', async (req, res) => {
  const dates = getMissingDates(req.body?.from);
  if (!dates.length) return res.json({ ok: true, dates: [], message: 'Already up to date' });
  res.json({ ok: true, dates });
  (async () => {
    for (const date of dates) {
      if (jobs.get(date)?.running) continue;
      const log = [];
      jobs.set(date, { running: true, log, startedAt: new Date().toISOString() });
      try {
        await collect(date, { onProgress: e => log.push({ ...e, at: new Date().toISOString() }) });
      } catch {}
      if (jobs.get(date)) jobs.get(date).running = false;
    }
  })();
});

app.post('/api/collect/:date', async (req, res) => {
  const { date } = req.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date' });
  if (jobs.get(date)?.running) return res.status(409).json({ error: 'Already running' });
  const log = [];
  jobs.set(date, { running: true, log, startedAt: new Date().toISOString() });
  collect(date, { onProgress: e => log.push({ ...e, at: new Date().toISOString() }) })
    .then(() => { jobs.get(date).running = false; })
    .catch(e => { if (jobs.get(date)) { jobs.get(date).running = false; jobs.get(date).error = e.message; } });
  res.json({ ok: true, date });
});

// ─── Gmail account management (existing) ────────────────────────────────────
app.get('/api/gmail/accounts', (req, res) => {
  try { res.json(getGmailAccounts()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/gmail/auth', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(400).send('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env');
  }
  res.redirect(getAuthUrl(req.query.hint));
});

app.get('/api/gmail/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/?gmail_error=' + encodeURIComponent(error));
  if (!code)  return res.redirect('/?gmail_error=no_code');
  try {
    const tokens = await exchangeCode(code);
    const email  = await getAccountEmail(tokens);
    saveGmailAccount(email, tokens);
    console.log('[gmail] connected:', email);
    res.redirect('/?gmail_connected=' + encodeURIComponent(email));
  } catch (e) {
    const data = e.response?.data;
    let detail;
    if (typeof data === 'object' && data !== null) {
      detail = data.error_description || data.error || JSON.stringify(data);
    } else if (typeof data === 'string' && data) {
      detail = data;
    } else {
      detail = e.message || 'unknown error';
    }
    console.error('[gmail callback] error:', detail);
    res.redirect('/?gmail_error=' + encodeURIComponent(detail));
  }
});

app.delete('/api/gmail/accounts/:id', (req, res) => {
  try { deleteGmailAccount(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Debug (existing) ───────────────────────────────────────────────────────
app.get('/api/debug/messages', (req, res) => res.json(testMessagesAccess()));

// ═══════════════════════════════════════════════════════════════════════════
// NEW ENDPOINTS (Comms v2)
// ═══════════════════════════════════════════════════════════════════════════

// ─── Gloss → Comms push (bearer token auth) ─────────────────────────────────
// Body: { contacts: [ {contact, aliases, gloss_id, gloss_url, mention_count,
//   last_mentioned_at, priority, growth_note, recent_context, linked_collections}, ... ] }
app.post('/api/gloss/contacts', (req, res) => {
  const body = req.body || {};
  const list = Array.isArray(body) ? body : Array.isArray(body.contacts) ? body.contacts : null;
  if (!list) return res.status(400).json({ error: 'expected { contacts: [...] } or an array' });
  let saved = 0;
  const errors = [];
  for (const p of list) {
    try { upsertGlossContact(p); saved++; }
    catch (e) { errors.push({ contact: p?.contact, error: e.message }); }
  }
  try { rebuildPeople(); } catch (e) { console.warn('[rebuildPeople after gloss push]', e.message); }
  res.json({ ok: true, saved, errors });
});

// Body: { notes: [ {id, contact, date, note, collection, gloss_url}, ... ] }
app.post('/api/gloss/notes', (req, res) => {
  const body = req.body || {};
  const list = Array.isArray(body) ? body : Array.isArray(body.notes) ? body.notes : null;
  if (!list) return res.status(400).json({ error: 'expected { notes: [...] } or an array' });
  let saved = 0;
  const errors = [];
  for (const n of list) {
    try { upsertGlossNote(n); saved++; }
    catch (e) { errors.push({ id: n?.id, error: e.message }); }
  }
  res.json({ ok: true, saved, errors });
});

// ─── Contacts ───────────────────────────────────────────────────────────────
app.get('/api/contacts', (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    res.json({ contacts: listContacts({ q, limit: 1000 }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/contacts/:name', (req, res) => {
  try {
    const detail = getContactDetail(req.params.name);
    // Enrich with address-book matches. Prefer the canonical person (already
    // deduped across sources); fall back to identifier-based matching when the
    // contact doesn't resolve to a known person yet.
    try {
      if (detail.person_id) {
        const person = getPerson(detail.person_id);
        detail.person = person;
        detail.address_book = person ? person.address_book : [];
      } else {
        detail.address_book = findAddressBookByIdentifiers({
          emails: detail.emails_addrs || [],
          phones: detail.handles || [],
          contactName: req.params.name,
        });
      }
    } catch (e) { /* non-fatal */ }
    res.json(detail);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/contacts/:name/insight', async (req, res) => {
  const { name } = req.params;
  try {
    const gloss = getGlossContact(name);
    const recentComms = getRecentCommsForAI(name);
    const { generateContactInsight } = require('./ai');
    const insight = await generateContactInsight({
      contact: name,
      glossProfile: gloss,
      recentComms,
    });
    saveContactInsight(name, insight);
    res.json({ ok: true, insight, generated_at: new Date().toISOString() });
  } catch (e) {
    console.error('[insight]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Calendar ───────────────────────────────────────────────────────────────
app.get('/api/calendar/events', (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 14, 60);
    res.json({ events: listCalendarEvents({ days }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/calendar/events/:id', (req, res) => {
  const ev = getCalendarEvent(req.params.id);
  if (!ev) return res.status(404).json({ error: 'not found' });
  const brief = getMeetingBrief(req.params.id);
  res.json({ event: ev, brief });
});

app.post('/api/calendar/events/:id/brief', async (req, res) => {
  const ev = getCalendarEvent(req.params.id);
  if (!ev) return res.status(404).json({ error: 'not found' });
  try {
    const attendeeProfiles = [];
    for (const att of (ev.attendees || [])) {
      if (!att.name && !att.email) continue;
      // Resolve by displayName first, then email local-part
      const candidates = [att.name, att.email].filter(Boolean);
      let gloss = null;
      for (const c of candidates) {
        gloss = getGlossContact(c);
        if (gloss) break;
      }
      const displayName = att.name || att.email;
      attendeeProfiles.push({
        contact: displayName,
        glossProfile: gloss,
        recentComms: getRecentCommsForAI(displayName),
      });
    }
    const { generateMeetingBrief } = require('./ai');
    const brief = await generateMeetingBrief({ event: ev, attendeeProfiles });
    saveMeetingBrief(ev.id, brief);
    res.json({ ok: true, brief, generated_at: new Date().toISOString() });
  } catch (e) {
    console.error('[brief]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/calendar/poll', async (req, res) => {
  try { const n = await pollCalendar(); res.json({ ok: true, events: n }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── App settings ────────────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  try { res.json({ settings: getSetting('enabled_calendars', {}) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/settings', (req, res) => {
  try {
    const { key, value } = req.body || {};
    if (!key) return res.status(400).json({ error: 'key required' });
    saveSetting(key, value);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Calendar list (all calendars per account) ───────────────────────────────
app.get('/api/calendar/list', async (req, res) => {
  try {
    const accounts = getGmailAccounts().filter(a =>
      hasScope(a.token_json, 'https://www.googleapis.com/auth/calendar.readonly'));
    const result = [];
    for (const acct of accounts) {
      try {
        const { calendars, refreshedTokens } = await fetchCalendarList(acct.token_json);
        if (refreshedTokens) {
          const merged = { ...JSON.parse(acct.token_json), ...refreshedTokens };
          saveGmailTokens(acct.id, merged);
        }
        result.push({ email: acct.email, calendars });
      } catch (e) {
        result.push({ email: acct.email, calendars: [], error: e.message });
      }
    }
    res.json({ accounts: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Special dates ───────────────────────────────────────────────────────────
app.get('/api/upcoming-special-dates', (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days, 10) || 60, 365);
    res.json({ dates: listUpcomingSpecialDates({ days }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/special-dates', (req, res) => {
  try {
    const contact = req.query.contact ? String(req.query.contact) : undefined;
    res.json({ dates: listSpecialDates({ contact }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/special-dates', (req, res) => {
  try {
    const { contact, type, month, day, year, label, notes } = req.body || {};
    if (!type || !month || !day) return res.status(400).json({ error: 'type, month, day required' });
    const { randomUUID } = require('crypto');
    const id = `manual:${randomUUID()}`;
    upsertSpecialDate({ id, contact: contact || null, type, month: Number(month), day: Number(day), year: year ? Number(year) : null, label: label || null, notes: notes || null, source: 'manual', source_id: null });
    res.json({ ok: true, id });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/special-dates/:id', (req, res) => {
  try { deleteSpecialDate(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Message template ────────────────────────────────────────────────────────
app.post('/api/contacts/:name/message-template', async (req, res) => {
  const { name } = req.params;
  const occasion = String(req.body?.occasion || 'check-in').slice(0, 100);
  try {
    const profile = getContactProfile(name);
    const recentComms = getRecentCommsForAI(name);
    const sentSamples = getRecentSentMessagesForStyle(name);
    const { generateMessageTemplate } = require('./ai');
    const template = await generateMessageTemplate({ contact: name, profile, recentComms, sentSamples, occasion });
    res.json({ ok: true, template, generated_at: new Date().toISOString() });
  } catch (e) {
    console.error('[message-template]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Contact profile (user-authored) ────────────────────────────────────────
app.get('/api/contacts/:name/profile', (req, res) => {
  try { res.json({ profile: getContactProfile(req.params.name) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/contacts/:name/profile', (req, res) => {
  try {
    const profile = saveContactProfile(req.params.name, req.body || {});
    res.json({ ok: true, profile });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/contacts/:name/rename', (req, res) => {
  const newName = (req.body?.newName || '').trim();
  if (!newName) return res.status(400).json({ error: 'newName is required' });
  try {
    const result = renameContact(req.params.name, newName);
    res.json({ ok: true, ...result });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── Agenda items ───────────────────────────────────────────────────────────
// scope_type is 'person' | 'event'; scope_id is the contact name or event id.
app.get('/api/agenda/:scope_type/:scope_id', (req, res) => {
  try {
    const items = listAgendaItems(req.params.scope_type, req.params.scope_id);
    res.json({ items });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/agenda', (req, res) => {
  try {
    const { scope_type, scope_id, content } = req.body || {};
    const item = addAgendaItem(scope_type, scope_id, content);
    res.json({ ok: true, item });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.patch('/api/agenda/:id', (req, res) => {
  try { res.json({ ok: true, item: updateAgendaItem(req.params.id, req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/agenda/:id', (req, res) => {
  try { deleteAgendaItem(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// ─── Meeting prep (reminder-only synthesis) ─────────────────────────────────
// Distinct from /brief: prep ONLY surfaces user-authored content (agenda items,
// profiles, etc). The AI is told not to invent advice.
app.post('/api/calendar/events/:id/prep', async (req, res) => {
  const ev = getCalendarEvent(req.params.id);
  if (!ev) return res.status(404).json({ error: 'not found' });
  try {
    const eventAgenda = listAgendaItems('event', ev.id, { includeDone: false });

    const attendeeProfiles = [];
    for (const att of (ev.attendees || [])) {
      if (!att.name && !att.email) continue;
      if (att.self) continue; // skip the user themselves
      const displayName = att.name || att.email;
      const candidates = [att.name, att.email].filter(Boolean);
      let gloss = null;
      for (const c of candidates) { gloss = getGlossContact(c); if (gloss) break; }
      let userProfile = null;
      for (const c of candidates) { userProfile = getContactProfile(c); if (userProfile) break; }
      const personAgenda = listAgendaItems('person', displayName, { includeDone: false })
        .map(i => ({ content: i.content, created_at: i.created_at }));
      attendeeProfiles.push({
        contact: displayName,
        userProfile,
        personAgenda,
        glossProfile: gloss,
        recentComms: getRecentCommsForAI(displayName),
      });
    }

    const { generateMeetingPrep } = require('./ai');
    const prep = await generateMeetingPrep({ event: ev, attendeeProfiles, eventAgenda });
    res.json({ ok: true, prep, generated_at: new Date().toISOString() });
  } catch (e) {
    console.error('[prep]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Meeting playbook (framework-based walk-through) ───────────────────────
app.get('/api/playbook/models', (req, res) => {
  try {
    const { playbookModelList } = require('./ai');
    const builtins = playbookModelList();
    const custom = listCustomPlaybookModels().map(m => ({
      key: m.key, label: m.label, builtin: false,
    }));
    res.json({ models: [...builtins, ...custom] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Custom playbook model CRUD. Only user-defined models live in the DB — the
// built-in catalog is in ai.js and cannot be edited or deleted.
app.get('/api/playbook/custom', (req, res) => {
  try { res.json({ models: listCustomPlaybookModels() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/playbook/custom', (req, res) => {
  try {
    const { isBuiltinPlaybookKey } = require('./ai');
    const { key, label, blurb } = req.body || {};
    if (isBuiltinPlaybookKey((key || '').toLowerCase())) {
      return res.status(400).json({ error: `key "${key}" collides with a built-in model` });
    }
    const model = saveCustomPlaybookModel({ key, label, blurb });
    res.json({ ok: true, model });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/playbook/custom/:key', (req, res) => {
  try {
    const { isBuiltinPlaybookKey } = require('./ai');
    const originalKey = req.params.key;
    const { key, label, blurb } = req.body || {};
    const nextKey = (key || originalKey).toLowerCase();
    if (nextKey !== originalKey && isBuiltinPlaybookKey(nextKey)) {
      return res.status(400).json({ error: `key "${nextKey}" collides with a built-in model` });
    }
    const model = saveCustomPlaybookModel({ key: nextKey, label, blurb, originalKey });
    res.json({ ok: true, model });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete('/api/playbook/custom/:key', (req, res) => {
  try { deleteCustomPlaybookModel(req.params.key); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/calendar/events/:id/playbook', async (req, res) => {
  const ev = getCalendarEvent(req.params.id);
  if (!ev) return res.status(404).json({ error: 'not found' });
  const model = (req.body && req.body.model) || 'auto';
  try {
    const { isBuiltinPlaybookKey } = require('./ai');
    let customModel = null;
    if (model && model !== 'auto' && !isBuiltinPlaybookKey(model)) {
      customModel = getCustomPlaybookModel(model);
      if (!customModel) return res.status(400).json({ error: `unknown playbook model: ${model}` });
    }

    const eventAgenda = listAgendaItems('event', ev.id, { includeDone: false });
    const attendeeProfiles = [];
    for (const att of (ev.attendees || [])) {
      if (!att.name && !att.email) continue;
      if (att.self) continue;
      const displayName = att.name || att.email;
      const candidates = [att.name, att.email].filter(Boolean);
      let gloss = null;
      for (const c of candidates) { gloss = getGlossContact(c); if (gloss) break; }
      let userProfile = null;
      for (const c of candidates) { userProfile = getContactProfile(c); if (userProfile) break; }
      const personAgenda = listAgendaItems('person', displayName, { includeDone: false })
        .map(i => ({ content: i.content, created_at: i.created_at }));
      attendeeProfiles.push({
        contact: displayName,
        userProfile,
        personAgenda,
        glossProfile: gloss,
        recentComms: getRecentCommsForAI(displayName),
      });
    }

    const { generateMeetingPlaybook } = require('./ai');
    const playbook = await generateMeetingPlaybook({
      event: ev, attendeeProfiles, eventAgenda, model, customModel,
    });
    res.json({ ok: true, model, playbook, generated_at: new Date().toISOString() });
  } catch (e) {
    console.error('[playbook]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Nudges ─────────────────────────────────────────────────────────────────
app.get('/api/nudges', (req, res) => {
  try { res.json({ nudges: getNudges() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/nudges/:contact/dismiss', (req, res) => {
  try { dismissNudge(req.params.contact); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Address book (Apple Contacts + Google People) ────────────────────────
app.get('/api/address-book', (req, res) => {
  try {
    const q = (req.query.q || '').toString();
    const source = req.query.source ? req.query.source.toString() : null;
    const limit = Math.min(parseInt(req.query.limit || '500', 10) || 500, 2000);
    const offset = parseInt(req.query.offset || '0', 10) || 0;
    res.json({
      stats: addressBookStats(),
      contacts: listAddressBook({ q, source, limit, offset }),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/address-book/stats', (req, res) => {
  try { res.json(addressBookStats()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/address-book/:id', (req, res) => {
  try {
    const contact = getAddressBookContact(req.params.id);
    if (!contact) return res.status(404).json({ error: 'not found' });
    res.json({ contact });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── People (canonical identity) ────────────────────────────────────────────
app.get('/api/people/resolve', (req, res) => {
  try {
    const name = String(req.query.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name required' });
    const hit = resolvePerson(name);
    if (!hit) return res.json({ ok: true, person: null });
    const person = getPerson(hit.person_id);
    res.json({ ok: true, person, names: hit.names });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/people/duplicates', (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    res.json({ candidates: findDuplicateCandidates({ limit }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Body: { a_id, b_id } — dismiss a suggested duplicate pair.
app.post('/api/people/reject-merge', (req, res) => {
  try {
    const body = req.body || {};
    const a = Number(body.a_id);
    const b = Number(body.b_id);
    if (!a || !b) return res.status(400).json({ error: 'a_id and b_id required' });
    res.json(rejectMergePair(a, b));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/people/:id', (req, res) => {
  try {
    const person = getPerson(Number(req.params.id));
    if (!person) return res.status(404).json({ error: 'not found' });
    res.json({ person });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Merge: POST { target_id, other_ids: [id, id, ...] }
app.post('/api/people/merge', (req, res) => {
  try {
    const body = req.body || {};
    const target_id = Number(body.target_id);
    const other_ids = Array.isArray(body.other_ids) ? body.other_ids.map(Number) : [];
    if (!target_id || !other_ids.length) {
      return res.status(400).json({ error: 'target_id and non-empty other_ids required' });
    }
    const out = mergePeople(target_id, other_ids);
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Force a full rebuild (useful after manual data edits).
app.post('/api/people/rebuild', (req, res) => {
  try { res.json(rebuildPeople()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/address-book/sync/apple', async (req, res) => {
  try {
    const { importAppleContacts } = require('./apple-contacts');
    const out = await importAppleContacts({
      upsertAddressBookContact,
      pruneAddressBookAccount,
      recordAddressBookSync,
      upsertSpecialDate,
    });
    try { rebuildPeople(); } catch (e) { console.warn('[rebuildPeople after apple sync]', e.message); }
    res.json(out);
  } catch (e) {
    console.error('[address-book apple]', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/address-book/sync/google', async (req, res) => {
  try {
    const accounts = getGmailAccounts().filter(a =>
      hasScope(a.token_json, 'https://www.googleapis.com/auth/contacts.readonly'));
    if (!accounts.length) {
      return res.json({
        ok: false,
        needs_reauth: getGmailAccounts().map(a => a.email),
        error: 'No Google accounts have contacts.readonly scope. Reconnect each account from Settings.',
      });
    }
    const { importGoogleContactsForAccount } = require('./google-contacts');
    const results = [];
    for (const acct of accounts) {
      const r = await importGoogleContactsForAccount({
        account: acct.email,
        tokenJson: acct.token_json,
        upsertAddressBookContact,
        pruneAddressBookAccount,
        recordAddressBookSync,
        upsertSpecialDate,
        saveRefreshedTokens: (refreshed) => {
          const merged = { ...JSON.parse(acct.token_json), ...refreshed };
          saveGmailTokens(acct.id, merged);
        },
      });
      results.push(r);
    }
    try { rebuildPeople(); } catch (e) { console.warn('[rebuildPeople after google sync]', e.message); }
    res.json({ ok: true, results });
  } catch (e) {
    console.error('[address-book google]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Convenience: run Apple + Google in one shot.
app.post('/api/address-book/sync', async (req, res) => {
  try {
    const { importAppleContacts } = require('./apple-contacts');
    const apple = await importAppleContacts({
      upsertAddressBookContact, pruneAddressBookAccount, recordAddressBookSync, upsertSpecialDate,
    });

    const googleAccounts = getGmailAccounts().filter(a =>
      hasScope(a.token_json, 'https://www.googleapis.com/auth/contacts.readonly'));
    const { importGoogleContactsForAccount } = require('./google-contacts');
    const google = [];
    for (const acct of googleAccounts) {
      google.push(await importGoogleContactsForAccount({
        account: acct.email,
        tokenJson: acct.token_json,
        upsertAddressBookContact, pruneAddressBookAccount, recordAddressBookSync, upsertSpecialDate,
        saveRefreshedTokens: (refreshed) => {
          const merged = { ...JSON.parse(acct.token_json), ...refreshed };
          saveGmailTokens(acct.id, merged);
        },
      }));
    }
    const needs_reauth = getGmailAccounts()
      .filter(a => !hasScope(a.token_json, 'https://www.googleapis.com/auth/contacts.readonly'))
      .map(a => a.email);
    try { rebuildPeople(); } catch (e) { console.warn('[rebuildPeople after full sync]', e.message); }
    res.json({ ok: true, apple, google, needs_reauth });
  } catch (e) {
    console.error('[address-book sync]', e.message);
    res.status(500).json({ error: e.message });
  }
});

async function pollAddressBook() {
  let summary = { apple: null, google: [] };
  try {
    const { importAppleContacts } = require('./apple-contacts');
    summary.apple = await importAppleContacts({
      upsertAddressBookContact, pruneAddressBookAccount, recordAddressBookSync, upsertSpecialDate,
    });
  } catch (e) { console.warn('[address-book/apple poll]', e.message); }

  try {
    const accounts = getGmailAccounts().filter(a =>
      hasScope(a.token_json, 'https://www.googleapis.com/auth/contacts.readonly'));
    if (accounts.length) {
      const { importGoogleContactsForAccount } = require('./google-contacts');
      for (const acct of accounts) {
        try {
          summary.google.push(await importGoogleContactsForAccount({
            account: acct.email,
            tokenJson: acct.token_json,
            upsertAddressBookContact, pruneAddressBookAccount, recordAddressBookSync, upsertSpecialDate,
            saveRefreshedTokens: (refreshed) => {
              const merged = { ...JSON.parse(acct.token_json), ...refreshed };
              saveGmailTokens(acct.id, merged);
            },
          }));
        } catch (e) { console.warn(`[address-book/google poll ${acct.email}]`, e.message); }
      }
    }
  } catch (e) { console.warn('[address-book/google poll]', e.message); }

  try { rebuildPeople(); } catch (e) { console.warn('[rebuildPeople after poll]', e.message); }
  return summary;
}

// ─── Calendar polling ───────────────────────────────────────────────────────
async function pollCalendar() {
  const accounts = getGmailAccounts();
  const enabledCalendars = getSetting('enabled_calendars', {});
  let total = 0;
  for (const acct of accounts) {
    if (!hasScope(acct.token_json, 'https://www.googleapis.com/auth/calendar.readonly')) continue;
    try {
      const calendarIds = enabledCalendars[acct.email] || ['primary'];
      const { events, refreshedTokens } = await fetchCalendarEvents(acct.token_json, { pastDays: 180, futureDays: 30, calendarIds });
      upsertCalendarEvents(acct.email, events);
      total += events.length;
      if (refreshedTokens) {
        const merged = { ...JSON.parse(acct.token_json), ...refreshedTokens };
        saveGmailTokens(acct.id, merged);
      }
    } catch (e) {
      console.warn(`[calendar poll] ${acct.email}:`, e.message);
    }
  }
  pruneOldCalendarEvents(365);
  return total;
}

// ─── Boot ───────────────────────────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Comm's  →  http://localhost:${PORT}`);
    console.log(`DB      →  ${DB_PATH}`);
    // Kick off calendar polling on boot and every 30 min thereafter.
    setImmediate(() => pollCalendar().then(n => n && console.log(`[calendar] synced ${n} events`)).catch(() => {}));
    setInterval(() => { pollCalendar().catch(() => {}); }, 30 * 60 * 1000);

    // Address book: sync on boot + every 6 hours. Apple is near-instant (local
    // SQLite). Google depends on each account having contacts.readonly scope —
    // accounts without it are skipped silently until the user reconnects.
    setImmediate(() => pollAddressBook().then(s => {
      if (s.apple?.upserted) console.log(`[address-book] apple: ${s.apple.upserted} upserted, ${s.apple.removed} removed`);
      for (const g of s.google || []) {
        if (g.ok) console.log(`[address-book] google ${g.account}: ${g.upserted} upserted, ${g.removed} removed`);
      }
    }).catch(() => {}));
    setInterval(() => { pollAddressBook().catch(() => {}); }, 6 * 60 * 60 * 1000);
  });
}

module.exports = { app, pollCalendar, pollAddressBook };
