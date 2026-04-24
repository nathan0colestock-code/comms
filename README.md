# Comms

Comms collects your iMessages, Gmail, and call history into a private SQLite database on your Mac. No data leaves your machine. Once running, any personal app can ask "who have I been in contact with?" or "what's my full history with this person?" — without touching iCloud, Google's servers, or any third-party service.

The point isn't the dashboard — it's the database.

Part of a five-app personal suite: [maestro](https://github.com/nathan0colestock-code/maestro) · [gloss](https://github.com/nathan0colestock-code/gloss) · [scribe](https://github.com/nathan0colestock-code/scribe) · [black](https://github.com/nathan0colestock-code/black)

![Comms dashboard showing iMessage and Gmail collection runs](screenshot.png)

---

## What it collects

| Source | What's stored | What's skipped |
|---|---|---|
| iMessages | Full message text, sender, contact, timestamp | Attachments with no text, reactions/tapbacks |
| Gmail | Sender, subject, snippet (~150 chars) | Full bodies, newsletters, automated mail |
| Call history | Timestamp, direction, duration, resolved contact name | Recordings |

Contact names resolved locally from macOS Contacts — nothing sent to any external service.

---

## The database

**`~/Library/Application Support/comms/comms.db`** — SQLite, WAL mode, safe to open read-only from any process.

```sql
runs(id, date, collected_at, status, messages_count, emails_count, error)
messages(id, run_id, date, contact, handle_id, direction, sender, text, sent_at)
emails(id, run_id, date, direction, contact, email_address, subject, snippet, account)
gmail_accounts(id, email, token_json, added_at)
```

```js
const db = new Database(
  require('os').homedir() + '/Library/Application Support/comms/comms.db',
  { readonly: true }
);
const contacts = db.prepare(
  `SELECT contact, COUNT(*) AS n FROM messages
   WHERE date >= date('now','-7 days')
   GROUP BY contact ORDER BY n DESC`
).all();
```

---

## Requirements

- macOS — uses macOS-specific databases for iMessages, Contacts, and call history
- Node.js 18+
- Full Disk Access for your terminal (System Settings → Privacy & Security → Full Disk Access)
- Google OAuth credentials (optional — only for Gmail)

---

## Setup

```bash
git clone https://github.com/nathan0colestock-code/comms.git
cd comms && npm install
cp .env.example .env
openssl rand -hex 32   # paste as API_KEY in .env
npm start              # dashboard at http://localhost:3748
```

**Gmail OAuth (optional):** Create a Web application OAuth 2.0 client at [console.cloud.google.com](https://console.cloud.google.com), add `http://localhost:3748/api/gmail/callback` as a redirect URI, paste the client ID and secret into `.env`, then click **+ Gmail** in the dashboard.

---

## Features

### Collection
- **Today** — collect right now
- **Catch up** — collect every day since the last successful run
- **CLI:** `node collect.js 2026-04-15` — specific date
- Scheduled via cron or launchd (see `install.sh`)

### People review
Flashcard mode for keeping relationships warm. Comms picks the person you've gone longest without reviewing (biased toward `priority >= 1`) and shows everything on one card: last contact, profile, gloss notes, upcoming dates, timeline. Keyboard: → / ← / Esc. A sidebar counter shows overdue contacts.

### Meeting brief generation
`POST /api/calendar/events/:id/brief` generates a pre-meeting context note from the attendee's message history, gloss notebook entries, and calendar details. Surfaces talking points and recent exchanges before a call.

### Duplicate detection & merge
`/api/people/duplicates` surfaces likely duplicate contact records (fuzzy name + phone). `/api/people/merge` collapses them, preserving the full history of both.

### Address book sync
`POST /api/address-book/sync/apple` and `/google` push comms contact data back into the system address books.

### Agenda system
Per-contact open action items, surfaced in the people review and contact detail views.

### Scheduled inbox triage
Runs at 08:00 and 12:00 local (configurable via `EMAIL_HELPER_HOURS`):

- **Transactional** (receipts, 2FA, no-reply) → leave alone
- **Newsletter / bulk** (List-Unsubscribe + bulk heuristics) → queue for human review; optionally auto-archive
- **Real person** → draft a context-aware Gemini reply into Gmail Drafts. Never sends.

Classifier is pure heuristic — free, deterministic, no AI cost. Unsubscribes never auto-click.

### MCP tools
`mcp.js` exposes Comms as an MCP server:
- `search_by_contact` — full profile + timeline
- `search_by_topic` — keyword search across messages and emails
- `get_nudges` — people due for contact
- `get_contact_detail` — structured profile with gloss notes
- `draft_message` — Gmail draft tailored to contact history

---

## Integration API

All routes require `Authorization: Bearer <API_KEY>` (or `SUITE_API_KEY` for inter-app calls).

```
GET  /api/runs                                 — recent runs (last 60 days)
GET  /api/runs/:date                           — messages + emails for a date
POST /api/collect/:date                        — trigger collection
GET  /api/status                               — suite-standard status envelope
GET  /api/telemetry/nightly                    — metrics for maestro's nightly analyst

GET  /api/contacts/:name                       — full profile + timeline
POST /api/contacts/:name/draft-message         — Gmail draft tailored to contact

POST /api/gloss/contacts                       — gloss → comms contact push

GET  /api/calendar/events/:id/brief            — pre-meeting context brief

GET  /api/people/review/next?skip=N            — next person due for review
POST /api/people/review/:id/reviewed           — mark reviewed
GET  /api/people/review/due?days=N             — count overdue

GET  /api/people/duplicates                    — likely duplicates
POST /api/people/merge                         — merge two records
POST /api/people/reject-merge                  — mark as not a duplicate

POST /api/address-book/sync/apple              — sync to macOS Contacts
POST /api/address-book/sync/google             — sync to Google Contacts

GET  /api/email-helper/runs                    — recent triage runs
GET  /api/email-helper/unsubscribes            — pending unsubscribe queue
POST /api/email-helper/unsubscribes/:id/approve
POST /api/email-helper/unsubscribes/:id/dismiss
POST /api/email-helper/run                     — manually trigger triage
```

Remote access:
```js
const res = await fetch('https://<your-ngrok-static-domain>/api/runs/2026-04-22', {
  headers: { 'Authorization': `Bearer ${process.env.COMMS_API_KEY}` }
});
```

---

## Tests

```bash
npm test   # 42 tests — unit, DB, and HTTP via Node's built-in test runner
```

---

## Install as background services

```bash
bash install.sh
```

Generates launchd plist files for your machine and loads them immediately.

---

## Privacy

- iMessages: stored locally only, nothing transmitted
- Gmail: only metadata (sender, subject, snippet), full bodies never requested
- Contacts: resolved from macOS AddressBook, no external calls
- No AI, no cloud, no analytics — zero outbound connections except the Gmail API

---

## Suite siblings

Comms is the **messaging + contacts** node of a five-app personal suite. Independent processes, all on [Fly.io](https://fly.io), backed up to Cloudflare R2 via [Litestream](https://litestream.io).

| App | What it does | What flows to/from Comms |
|---|---|---|
| **[gloss](https://github.com/nathan0colestock-code/gloss)** | Personal knowledge graph (journal OCR, pages, people) | Gloss pushes contact profiles; Comms returns timeline data for research briefings |
| **[scribe](https://github.com/nathan0colestock-code/scribe)** | Collaborative document editor | "Send to Comms" hands a draft for Gmail outbound in the recipient's voice |
| **[black](https://github.com/nathan0colestock-code/black)** | Personal file search (Drive, Evernote, iCloud) | Black can enrich search hits with contact context |
| **[maestro](https://github.com/nathan0colestock-code/maestro)** | Overnight code orchestration | Polls `/api/status`; dispatches feature sets |

All five apps expose `GET /api/status` → `{ app, version, ok, uptime_seconds, metrics }`, Bearer-authed.
