'use strict';

// Structured logging contract (see shared-rules.md).
//
// Exports:
//   - log(level, event, ctx)     → emit one JSON line to stderr and push to
//                                  the 24h in-memory ring buffer.
//   - httpMiddleware              → Express middleware logging every request
//                                  with method/path/status/duration_ms and a
//                                  propagated trace_id (X-Trace-Id).
//   - outboundWrap(fn, opts)      → wraps an async fn, logs `outbound_http`
//                                  (or event you name) with url + duration.
//   - getRecent({since,level,limit,traceId}) → ring-buffer read for the
//                                  /api/logs/recent endpoint.
//   - setTraceId(req, id)         → explicit setter (rarely needed).
//
// Levels: debug | info | warn | error.
// Buffer: max 1000 entries, each with ts + 24h window enforced on read.

const crypto = require('crypto');

const LEVELS = ['debug', 'info', 'warn', 'error'];
const LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 };
const MAX_BUFFER = 1000;
const APP = process.env.APP_NAME || 'comms';

const ringBuffer = [];

function normalizeLevel(level) {
  return LEVELS.includes(level) ? level : 'info';
}

function now() { return new Date().toISOString(); }

function pushEntry(entry) {
  ringBuffer.push(entry);
  while (ringBuffer.length > MAX_BUFFER) ringBuffer.shift();
}

// Primary API.
function log(level, event, ctx = {}) {
  const lvl = normalizeLevel(level);
  const { trace_id, request_id, duration_ms, ...rest } = ctx || {};
  const entry = {
    ts: now(),
    app: APP,
    level: lvl,
    event: String(event || 'log'),
    ...(trace_id   ? { trace_id }   : {}),
    ...(request_id ? { request_id } : {}),
    ...(duration_ms != null ? { duration_ms } : {}),
    ctx: rest && Object.keys(rest).length ? rest : undefined,
  };
  pushEntry(entry);
  try {
    // Always to stderr so we never pollute stdout (MCP transports etc).
    process.stderr.write(JSON.stringify(entry) + '\n');
  } catch {}
  return entry;
}

// HTTP middleware. Generates / echoes X-Trace-Id and logs one entry per
// completed response.
function httpMiddleware() {
  return function httpMiddlewareImpl(req, res, next) {
    const traceId = req.get('X-Trace-Id') || crypto.randomUUID();
    req.trace_id = traceId;
    res.setHeader('X-Trace-Id', traceId);
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number((process.hrtime.bigint() - start) / 1_000_000n);
      const status = res.statusCode;
      const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
      log(level, 'http', {
        method: req.method,
        path: (req.originalUrl || req.url || '').split('?')[0],
        status,
        duration_ms: durationMs,
        trace_id: traceId,
      });
    });
    next();
  };
}

// Wrap an async function (fetch-like) and emit an outbound log event.
// Usage: outboundWrap(() => fetch(u), { event:'outbound_http', url:u, trace_id })
async function outboundWrap(fn, opts = {}) {
  const { event = 'outbound_http', url = null, trace_id = null, extra = {} } = opts;
  const start = process.hrtime.bigint();
  try {
    const result = await fn();
    const duration_ms = Number((process.hrtime.bigint() - start) / 1_000_000n);
    const status = result?.status ?? result?.statusCode ?? null;
    log(status && status >= 500 ? 'error' : 'info', event, {
      url, status, duration_ms, trace_id, ...extra,
    });
    return result;
  } catch (err) {
    const duration_ms = Number((process.hrtime.bigint() - start) / 1_000_000n);
    log('error', event, {
      url, error: err.message, duration_ms, trace_id, ...extra,
    });
    throw err;
  }
}

// Reader used by /api/logs/recent.
function getRecent({ since = null, level = null, limit = 500, traceId = null } = {}) {
  const cutoffIso = since ? new Date(since) : null;
  const windowFloor = Date.now() - 24 * 60 * 60 * 1000;
  const minRank = level && LEVEL_RANK[level] != null ? LEVEL_RANK[level] : 0;
  const out = [];
  for (let i = ringBuffer.length - 1; i >= 0 && out.length < limit; i--) {
    const e = ringBuffer[i];
    const ts = Date.parse(e.ts);
    if (!Number.isFinite(ts) || ts < windowFloor) continue;
    if (cutoffIso && ts <= cutoffIso.getTime()) continue;
    if (LEVEL_RANK[e.level] < minRank) continue;
    if (traceId && e.trace_id !== traceId) continue;
    out.push(e);
  }
  return out.reverse();
}

function _clearBufferForTests() { ringBuffer.length = 0; }
function _bufferSizeForTests() { return ringBuffer.length; }

// Wrap console.log/warn/error so every unmigrated call still reaches the
// ring buffer as a structured event (event='console'). Idempotent.
let _consolePatched = false;
function patchConsole() {
  if (_consolePatched) return;
  _consolePatched = true;
  const orig = {
    log:   console.log.bind(console),
    warn:  console.warn.bind(console),
    error: console.error.bind(console),
    info:  console.info.bind(console),
  };
  const toMsg = (args) => args.map(a => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
  console.log   = (...a) => { try { log('info',  'console', { msg: toMsg(a) }); } catch {} orig.log(...a); };
  console.info  = (...a) => { try { log('info',  'console', { msg: toMsg(a) }); } catch {} orig.info(...a); };
  console.warn  = (...a) => { try { log('warn',  'console', { msg: toMsg(a) }); } catch {} orig.warn(...a); };
  console.error = (...a) => { try { log('error', 'console', { msg: toMsg(a) }); } catch {} orig.error(...a); };
}

module.exports = {
  log,
  httpMiddleware,
  outboundWrap,
  getRecent,
  patchConsole,
  LEVELS,
  MAX_BUFFER,
  _clearBufferForTests,
  _bufferSizeForTests,
};
