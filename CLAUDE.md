# CLAUDE.md — comms

## Purpose
Comm's is a personal relationship-intelligence hub: it aggregates Gmail /
iMessage / Apple & Google Contacts / Google Calendar into a single local
SQLite store and cross-references it with profiles and notes pushed from the
companion Gloss app.

## Stack
- Node.js 20
- Express 4 (+ helmet)
- SQLite via `better-sqlite3`
- Vanilla HTML/CSS/JS frontend (no build step) served from `public/`
- Fly.io deploy target (app `comms-nc`) with Litestream continuous backup

## Key files
- `server.js` — HTTP entry point, auth middleware, all route handlers
- `collect.js` — schema, migrations, DB access, nightly collection pipeline
- `ai.js` — Gemini prompts for insights / briefs / prep / playbooks
- `gmail.js`, `calendar.js`, `google-contacts.js`, `apple-contacts.js` — source adapters
- `mcp.js` — Model Context Protocol server exposing the same data to Claude
- `public/index.html` — the single-page UI
- `public/sw.js`, `public/offline.html` — PWA offline fallback
- `Dockerfile`, `litestream.yml`, `fly.toml` — deploy
- `test/*.test.js` — `node:test` suites

## API routes (high level)
Public (no auth):
- `GET  /api/health` — liveness probe, returns `{ ok, now }`
- `POST /api/login`, `POST /api/logout` — cookie session login
- `GET  /api/gmail/callback` — OAuth return leg

Authenticated (cookie OR Bearer/X-API-Key):
- `GET  /api/status` — suite-shaped envelope: `{ app, version, ok, uptime_seconds, metrics }`
- `GET  /api/overview` — legacy in-app overview snapshot
- `GET  /api/search?q=` — unified messages/emails/contacts search
- `GET  /api/runs`, `GET /api/runs/:date`, `POST /api/collect/:date`
- `GET  /api/gmail/accounts`, `DELETE /api/gmail/accounts/:id`, `GET /api/gmail/auth`
- `GET  /api/contacts`, `GET /api/contacts/:name`
- `POST /api/contacts/:name/insight`, `POST /api/contacts/:name/message-template`
- `GET/PUT /api/contacts/:name/profile`, `PUT /api/contacts/:name/rename`
- `GET  /api/calendar/events`, `GET /api/calendar/events/:id`
- `POST /api/calendar/events/:id/{brief,prep,playbook}`, `POST /api/calendar/poll`
- `GET  /api/playbook/models`, CRUD at `/api/playbook/custom[/:key]`
- `GET  /api/nudges`, `POST /api/nudges/:contact/dismiss`
- `GET  /api/address-book[/:id]`, `POST /api/address-book/sync{,/apple,/google}`
- `GET  /api/people/{resolve,duplicates,:id}`, `POST /api/people/{merge,reject-merge,rebuild}`
- `GET/POST/DELETE /api/special-dates`, `GET /api/upcoming-special-dates`
- `GET/PUT /api/settings`
- `POST /api/gloss/contacts`, `POST /api/gloss/notes` — push endpoints from Gloss

## Integration points (env vars)
- `API_KEY` — app-local bearer token (accepted on all /api/* routes)
- `SUITE_API_KEY` — shared bearer accepted alongside `API_KEY` for cross-app polling
- `AUTH_PASSWORD`, `SESSION_SECRET` — cookie session auth for the web UI
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — Gmail/Calendar/Contacts OAuth
- `GEMINI_API_KEY` — AI generation (insights, briefs, playbooks)
- `GLOSS_URL`, `GLOSS_API_KEY` — companion app that pushes contacts/notes in (comms does not currently call out to Gloss; the traffic is inbound only)
- `GMAIL_*` — reserved for per-account overrides read by `gmail.js`
- `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` — Litestream replication target
- `COMMS_DB_PATH` — override the SQLite path (defaults to `./data/comms.db`; Fly sets `/data/comms.db`)
- `PORT` — HTTP port (default 3748)

## Auth model
- **Humans**: cookie session. `POST /api/login` with `AUTH_PASSWORD` sets the
  `comms_auth` HMAC-signed cookie (30-day TTL, rate-limited).
- **Machines**: bearer token on every `/api/*` route. Accepted via either
  `Authorization: Bearer <key>` or `X-API-Key: <key>`. Valid keys are
  `API_KEY` and `SUITE_API_KEY`. `requireApiKey()` uses constant-time compare.
- A small allowlist (`/api/health`, `/api/login`, `/api/logout`,
  `/api/gmail/callback`, PWA static assets) is public.

## Test command
```
npm test
```
Runs `node:test` across `test/unit.test.js`, `test/db.test.js`,
`test/api.test.js`, `test/mcp.test.js`. Keep it green; use a 30s timeout.

## Deploy command
```
fly deploy -a comms-nc
```
Production serves on `https://comms-nc.fly.dev`. Data lives on the `comms_data`
volume mounted at `/data`. Litestream wraps `node server.js` to stream WAL
frames to the R2 `nathan-suite-backups` bucket (`comms/comms.db`).

## Local LaunchAgent
`~/Library/LaunchAgents/com.comms.server.plist` runs a local instance on
`http://localhost:3748` for legacy consumers (Keyboard Maestro macros, the MCP
bridge, ad-hoc scripts). Do **not** confuse that local instance with the Fly
deployment, and do **not** modify the plist as part of suite-deployment work —
they're independent. The local DB is at `./data/comms.db` (project root);
Fly's DB is at `/data/comms.db` on the volume.
