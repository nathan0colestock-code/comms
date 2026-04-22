#!/usr/bin/env node
/**
 * server.js — Comm's dashboard + integration API
 *
 * Port 3748. Reads/writes the SQLite DB via collect.js.
 * Exposes a REST API for Gloss and other integrations.
 *
 * Usage: node server.js
 *
 * Integration API:
 *   GET  /api/runs                    — list recent runs
 *   GET  /api/runs/:date              — detail for a date (YYYY-MM-DD)
 *   POST /api/collect/:date           — trigger collection
 *   GET  /api/gmail/accounts          — list connected Gmail accounts
 *   GET  /api/gmail/auth              — start OAuth flow
 *   GET  /api/gmail/callback          — OAuth callback (Google redirects here)
 *   DELETE /api/gmail/accounts/:id    — remove an account
 *   GET  /api/debug/messages          — test Messages.app access
 */

'use strict';

const fs      = require('fs');
const path    = require('path');
const express = require('express');

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
  collect, getRuns, getRunDetail,
  getGmailAccounts, saveGmailAccount, deleteGmailAccount,
  testMessagesAccess, DB_PATH,
} = require('./collect');
const { getAuthUrl, exchangeCode, getAccountEmail } = require('./gmail');

const PORT = parseInt(process.env.PORT || '3748', 10);
const app  = express();
app.use(express.json());

// In-flight jobs: date → { running, log[], error }
const jobs = new Map();

// ---------------------------------------------------------------------------
// Collection API
// ---------------------------------------------------------------------------

app.get('/api/status', (req, res) => {
  const runs = getRuns(1);
  res.json({ ok: true, db: DB_PATH, last_run: runs[0] || null });
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

// ---------------------------------------------------------------------------
// Gmail account management
// ---------------------------------------------------------------------------

app.get('/api/gmail/accounts', (req, res) => {
  try { res.json(getGmailAccounts()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/gmail/auth', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(400).send('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env');
  }
  const url = getAuthUrl(req.query.hint);
  res.redirect(url);
});

app.get('/api/gmail/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/?gmail_error=' + encodeURIComponent(error));
  if (!code) return res.redirect('/?gmail_error=no_code');
  try {
    const tokens = await exchangeCode(code);
    const email  = await getAccountEmail(tokens);
    saveGmailAccount(email, tokens);
    res.redirect('/?gmail_connected=' + encodeURIComponent(email));
  } catch (e) {
    res.redirect('/?gmail_error=' + encodeURIComponent(e.message));
  }
});

app.delete('/api/gmail/accounts/:id', (req, res) => {
  try {
    deleteGmailAccount(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// Debug
// ---------------------------------------------------------------------------

app.get('/api/debug/messages', (req, res) => {
  res.json(testMessagesAccess());
});

// ---------------------------------------------------------------------------
// Dashboard HTML
// ---------------------------------------------------------------------------

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Comm's</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #0f1117; --surface: #1a1d27; --border: #2a2d3a;
  --text: #e2e4ec; --muted: #6b7080; --accent: #7c9ef8;
  --green: #4caf7d; --red: #e05c5c; --yellow: #d4a84b;
  font-size: 14px;
}
body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; display: flex; flex-direction: column; height: 100dvh; }

header { display: flex; align-items: center; gap: 12px; padding: 10px 20px; border-bottom: 1px solid var(--border); flex-shrink: 0; flex-wrap: wrap; }
header h1 { font-size: 15px; font-weight: 700; letter-spacing: 0.01em; margin-right: 4px; }
.account-chip { display: flex; align-items: center; gap: 6px; background: var(--surface); border: 1px solid var(--border); border-radius: 999px; padding: 3px 10px 3px 8px; font-size: 12px; }
.account-chip .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); flex-shrink: 0; }
.account-chip button { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 14px; line-height: 1; padding: 0 0 0 2px; }
.account-chip button:hover { color: var(--red); }
.add-gmail-btn { display: flex; align-items: center; gap: 5px; background: none; border: 1px dashed var(--border); border-radius: 999px; padding: 3px 10px; font-size: 12px; color: var(--muted); cursor: pointer; }
.add-gmail-btn:hover { border-color: var(--accent); color: var(--accent); }
header .spacer { flex: 1; }
.debug-link { font-size: 11px; color: var(--muted); text-decoration: none; }
.debug-link:hover { color: var(--accent); }

.layout { display: flex; flex: 1; overflow: hidden; }

.runs-panel { width: 220px; flex-shrink: 0; border-right: 1px solid var(--border); display: flex; flex-direction: column; }
.runs-toolbar { padding: 10px 16px 8px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 8px; }
.runs-toolbar .label { font-size: 11px; color: var(--muted); font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; flex: 1; }
.btn { display: flex; align-items: center; gap: 5px; background: var(--accent); color: #fff; border: none; padding: 5px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; font-weight: 500; }
.btn:disabled { opacity: 0.45; cursor: not-allowed; }
.btn:not(:disabled):hover { filter: brightness(1.12); }
.btn.ghost { background: var(--surface); color: var(--text); border: 1px solid var(--border); }
.btn.ghost:hover { border-color: var(--accent); color: var(--accent); }

.runs-list { flex: 1; overflow-y: auto; padding: 8px 0; }
.run-row { display: flex; align-items: center; gap: 8px; padding: 8px 16px; cursor: pointer; border-left: 3px solid transparent; }
.run-row:hover { background: var(--surface); }
.run-row.active { background: var(--surface); border-left-color: var(--accent); }
.run-row .date { font-size: 13px; font-weight: 500; flex: 1; }
.run-row .dow  { font-size: 11px; color: var(--muted); min-width: 26px; }
.badge { font-size: 10px; padding: 2px 6px; border-radius: 999px; font-weight: 600; }
.badge.done    { background: #1e3d2a; color: var(--green); }
.badge.running { background: #2a2a1e; color: var(--yellow); animation: pulse 1.2s infinite; }
.badge.error   { background: #3d1e1e; color: var(--red); }
.badge.empty   { background: var(--border); color: var(--muted); }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.5; } }

.detail-panel { flex: 1; overflow-y: auto; padding: 24px; }
.empty-state { color: var(--muted); font-size: 13px; padding-top: 60px; text-align: center; }

.detail-header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 20px; }
.detail-date { font-size: 20px; font-weight: 700; }
.detail-meta { font-size: 12px; color: var(--muted); margin-top: 3px; }

.warning-box { background: #1e1a0e; border: 1px solid #3d3418; border-radius: 8px; padding: 13px 16px; margin-bottom: 18px; font-size: 13px; color: var(--yellow); line-height: 1.6; }
.warning-box strong { color: #e8c97a; }
.summary-box { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; margin-bottom: 20px; font-size: 13px; line-height: 1.6; }

.section-title { font-size: 11px; font-weight: 600; color: var(--muted); letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 10px; }
.contact-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 8px; margin-bottom: 20px; }
.contact-card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; }
.contact-name { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.contact-counts { font-size: 11px; color: var(--muted); margin-top: 3px; }
.contact-counts span { color: var(--text); font-weight: 600; }

.email-list { display: flex; flex-direction: column; gap: 5px; margin-bottom: 20px; }
.email-row { display: flex; align-items: baseline; gap: 8px; padding: 7px 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; font-size: 13px; min-width: 0; }
.email-dir { font-size: 11px; font-weight: 700; flex-shrink: 0; }
.email-dir.received { color: var(--green); }
.email-dir.sent { color: var(--accent); }
.email-acct { font-size: 10px; color: var(--muted); flex-shrink: 0; max-width: 120px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.email-from { color: var(--muted); flex-shrink: 0; min-width: 100px; max-width: 160px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.email-subject { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.items-list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 20px; }
.item-row { font-size: 13px; color: var(--muted); padding: 5px 0; border-bottom: 1px solid var(--border); }
.item-row::before { content: "·"; margin-right: 8px; color: var(--accent); }

.debug-box { font-family: monospace; font-size: 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 12px; color: var(--muted); margin-top: 8px; }

.toast { position: fixed; bottom: 20px; right: 20px; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 10px 16px; font-size: 13px; z-index: 999; opacity: 0; transition: opacity 0.2s; pointer-events: none; }
.toast.show { opacity: 1; }
.toast.ok { border-color: var(--green); color: var(--green); }
.toast.err { border-color: var(--red); color: var(--red); }
</style>
</head>
<body>
<header>
  <h1>Comm's</h1>
  <div id="account-chips"></div>
  <button class="add-gmail-btn" onclick="addGmail()">+ Gmail</button>
  <div class="spacer"></div>
  <a class="debug-link" href="/api/debug/messages" target="_blank">test messages</a>
</header>

<div class="layout">
  <div class="runs-panel">
    <div class="runs-toolbar">
      <span class="label">Runs</span>
      <button class="btn" id="collect-today-btn" onclick="collectToday()">Collect today</button>
    </div>
    <div class="runs-list" id="runs-list"></div>
  </div>
  <div class="detail-panel" id="detail-panel">
    <div class="empty-state">Select a day to view details</div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
let currentDate = null;
let pollTimer   = null;

// ---------------------------------------------------------------------------
async function api(url, opts) {
  const r = await fetch(url, opts);
  return r.json();
}

function toast(msg, kind = 'ok') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show ' + kind;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = 'toast'; }, 3000);
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ---------------------------------------------------------------------------
// Gmail account chips
// ---------------------------------------------------------------------------
async function loadAccounts() {
  const accounts = await api('/api/gmail/accounts').catch(() => []);
  const el = document.getElementById('account-chips');
  el.innerHTML = accounts.map(a =>
    \`<div class="account-chip">
      <span class="dot"></span>
      <span title="\${esc(a.email)}">\${esc(a.email)}</span>
      <button onclick="removeAccount('\${esc(a.id)}', '\${esc(a.email)}')" title="Remove">×</button>
    </div>\`
  ).join('');
}

function addGmail() {
  window.location.href = '/api/gmail/auth';
}

async function removeAccount(id, email) {
  if (!confirm(\`Remove \${email}?\`)) return;
  await api(\`/api/gmail/accounts/\${id}\`, { method: 'DELETE' });
  await loadAccounts();
  toast(\`Removed \${email}\`);
}

// ---------------------------------------------------------------------------
// Run list
// ---------------------------------------------------------------------------
async function loadRuns() {
  const runs = await api('/api/runs').catch(() => []);
  const el = document.getElementById('runs-list');
  if (!runs.length) {
    el.innerHTML = '<div style="padding:16px;color:var(--muted);font-size:12px">No runs yet</div>';
    return;
  }
  el.innerHTML = runs.map(r => {
    const d = new Date(r.date + 'T12:00:00');
    const dow = DAYS[d.getDay()];
    const active = r.date === currentDate ? 'active' : '';
    let badge, label;
    if (r.status === 'running') { badge = 'running'; label = '…'; }
    else if (r.status === 'error') { badge = 'error'; label = 'err'; }
    else if (r.status === 'done') {
      const n = (r.messages_count || 0) + (r.emails_count || 0);
      badge = n ? 'done' : 'empty'; label = n ? n + ' items' : '—';
    } else { badge = 'empty'; label = '—'; }
    return \`<div class="run-row \${active}" onclick="selectDate('\${r.date}')">
      <span class="dow">\${dow}</span>
      <span class="date">\${r.date}</span>
      <span class="badge \${badge}">\${label}</span>
    </div>\`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Detail panel
// ---------------------------------------------------------------------------
async function selectDate(date) {
  currentDate = date;
  clearInterval(pollTimer);
  await loadRuns();
  document.getElementById('detail-panel').innerHTML = '<div class="empty-state">Loading…</div>';
  const detail = await api('/api/runs/' + date).catch(() => null);
  renderDetail(date, detail);
  if (!detail || detail.run?.status === 'running') startPolling(date);
}

function startPolling(date) {
  pollTimer = setInterval(async () => {
    const d = await api('/api/runs/' + date).catch(() => null);
    renderDetail(date, d);
    await loadRuns();
    if (d?.run?.status !== 'running') clearInterval(pollTimer);
  }, 2000);
}

function renderDetail(date, detail) {
  const panel = document.getElementById('detail-panel');

  if (!detail || !detail.run) {
    panel.innerHTML = \`
      <div class="detail-header">
        <div><div class="detail-date">\${date}</div><div class="detail-meta">No data yet</div></div>
        <button class="btn ghost" onclick="triggerCollect('\${date}')">Collect</button>
      </div>\`;
    return;
  }

  const { run, contacts, emails, summary } = detail;
  const collectLabel = run.status === 'running' ? 'Collecting…' : 'Re-collect';
  const collectDisabled = run.status === 'running' ? 'disabled' : '';
  const collectedAt = run.collected_at ? new Date(run.collected_at).toLocaleTimeString() : '';

  let html = \`<div class="detail-header">
    <div>
      <div class="detail-date">\${run.date}</div>
      <div class="detail-meta">\${run.messages_count} iMessage contacts · \${run.emails_count} emails · \${collectedAt}</div>
    </div>
    <button class="btn ghost" \${collectDisabled} onclick="triggerCollect('\${run.date}')">\${collectLabel}</button>
  </div>\`;

  // No-data warning
  if (run.status === 'done' && !contacts?.length && !emails?.length) {
    html += \`<div class="warning-box">
      <strong>No data collected.</strong><br><br>
      <strong>Gmail:</strong> make sure at least one account is connected (use the + Gmail button above).<br>
      <strong>iMessages:</strong> run <code>osascript -e 'tell application "Messages" to count every chat'</code> in Terminal to trigger the Automation permission dialog, then re-collect.
      Or check <a href="/api/debug/messages" target="_blank" style="color:var(--yellow)">debug → messages</a> to see what's happening.
    </div>\`;
  }

  if (summary?.text) html += \`<p class="section-title">Summary</p><div class="summary-box">\${esc(summary.text)}</div>\`;

  if (contacts?.length) {
    html += '<p class="section-title">iMessages</p><div class="contact-grid">';
    for (const c of contacts) {
      html += \`<div class="contact-card">
        <div class="contact-name" title="\${esc(c.contact)}">\${esc(c.contact)}</div>
        <div class="contact-counts">↑<span>\${c.sent}</span> ↓<span>\${c.received}</span></div>
      </div>\`;
    }
    html += '</div>';
  }

  if (emails?.length) {
    html += '<p class="section-title">Gmail</p><div class="email-list">';
    for (const e of emails) {
      const arrow = e.direction === 'received' ? '↓' : '↑';
      html += \`<div class="email-row">
        <span class="email-dir \${e.direction}">\${arrow}</span>
        \${e.account ? \`<span class="email-acct" title="\${esc(e.account)}">\${esc(e.account.split('@')[0])}</span>\` : ''}
        <span class="email-from" title="\${esc(e.contact)}">\${esc(e.contact)}</span>
        <span class="email-subject">\${esc(e.subject || '(no subject)')}</span>
      </div>\`;
    }
    html += '</div>';
  }

  if (summary?.items?.length) {
    html += '<p class="section-title">Items</p><div class="items-list">';
    for (const item of summary.items) html += \`<div class="item-row">\${esc(item.text)}</div>\`;
    html += '</div>';
  }

  if (run.error) html += \`<p class="section-title" style="color:var(--red)">Error</p><div class="debug-box">\${esc(run.error)}</div>\`;

  panel.innerHTML = html;
}

// ---------------------------------------------------------------------------
async function triggerCollect(date) {
  await api('/api/collect/' + date, { method: 'POST' });
  await loadRuns();
  await selectDate(date);
}

async function collectToday() {
  const today = new Date().toISOString().slice(0, 10);
  await triggerCollect(today);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async () => {
  // Handle OAuth redirect params
  const params = new URLSearchParams(location.search);
  if (params.get('gmail_connected')) {
    toast('Connected ' + params.get('gmail_connected'));
    history.replaceState({}, '', '/');
  }
  if (params.get('gmail_error')) {
    toast('Gmail error: ' + params.get('gmail_error'), 'err');
    history.replaceState({}, '', '/');
  }

  await loadAccounts();
  await loadRuns();
  const runs = await api('/api/runs').catch(() => []);
  if (runs.length) selectDate(runs[0].date);
  setInterval(() => { loadRuns(); loadAccounts(); }, 30_000);
})();
</script>
</body>
</html>`;

app.get('/', (req, res) => res.send(HTML));

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Comm's  →  http://localhost:${PORT}`);
  console.log(`DB      →  ${DB_PATH}`);
  console.log('');
  console.log('Integration API:');
  console.log(`  GET  /api/runs`);
  console.log(`  GET  /api/runs/YYYY-MM-DD`);
  console.log(`  POST /api/collect/YYYY-MM-DD`);
  console.log(`  GET  /api/gmail/accounts`);
});
