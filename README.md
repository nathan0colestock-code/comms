# Comms

Comms is a personal relationship intelligence hub. It collects your iMessages, Gmail, call history, and calendar — then puts AI to work helping you show up prepared for every meeting, keep relationships warm, and manage your inbox without losing context.

It has two parts: a **local collector** that runs on your Mac (reading iMessages, call history, and Apple Contacts directly from macOS), and a **server** that can run locally or deploy to Fly.io (handling Gmail, Google Calendar, Google Contacts, the web UI, and all API access). iMessage data never leaves your machine. Gmail metadata flows through your own OAuth credentials.

Part of a five-app personal suite: [maestro](https://github.com/nathan0colestock-code/maestro) · [gloss](https://github.com/nathan0colestock-code/gloss) · [scribe](https://github.com/nathan0colestock-code/scribe) · [black hole](https://github.com/nathan0colestock-code/black)

---

## What it does

### Meeting prep that actually knows the person
Before any calendar event, Comms generates a pre-meeting brief grounded in your real history — not boilerplate. It pulls from the attendee's message and email history, their entry in your Gloss notebook, and the calendar details themselves. If you want something more tactical, apply a named playbook: Challenger Sale, SPIN, GROW coaching, Radical Candor, Nonviolent Communication, Getting to Yes, or any custom framework you define.

### People review — flashcard mode for relationships
Comms picks the person you've gone longest without reviewing and shows everything on one card: last contact, your relationship profile, Gloss notes, upcoming special dates, and a recent timeline. Keyboard-driven (→ / ← / Esc). A sidebar counter shows how many contacts are overdue. Works best run once a day.

### Scheduled inbox triage
At 8am and noon (configurable), Comms classifies your Gmail:
- **Transactional** (receipts, 2FA, no-reply) — left alone
- **Newsletter / bulk** (List-Unsubscribe + heuristics) — queued for your review; optionally auto-archived
- **Real person** — Comms drafts a context-aware reply into Gmail Drafts using your communication history. It never sends.

The classifier is pure heuristic — fast, free, deterministic. Unsubscribe links are never auto-clicked.

### Contact intelligence
Every contact has a full profile: relationship type, follow-up cadence, your personal notes, Gloss notebook entries, upcoming birthdays and anniversaries, and a timeline of recent exchanges. Comms can generate a 2–3 sentence AI insight — a concrete talking point based on their recent context — on demand.

### Nudges
Comms surfaces contacts who are due for outreach, weighted toward priority contacts. One-click dismiss for the week. Works alongside people review.

### Agenda system
Per-contact and per-meeting action items, surfaced wherever you need them — in the people review card, the meeting brief, and the contact detail view.

### Address book sync
Keeps Apple Contacts and Google Contacts in sync with what Comms knows. Deduplication merges fuzzy name + phone matches; you review suggestions before anything merges.

### MCP server
Comms exposes a Claude-compatible MCP server so any AI tool can query your contact intelligence directly:
- `search_by_contact(name)` — 50 most recent messages and emails with someone
- `search_by_topic(query)` — keyword search across all messages and emails
- `get_nudges()` — contacts due for outreach with reasons
- `get_contact_detail(name)` — full profile: messages, emails, calendar events, Gloss notes, special dates

---

## What it collects

| Source | What's stored | What's skipped |
|---|---|---|
| iMessages | Full message text, sender, contact, timestamp | Attachments with no text, reactions/tapbacks |
| Gmail | Sender, subject, snippet (~150 chars) | Full bodies, newsletters, automated mail |
| Call history | Timestamp, direction, duration, resolved contact name | Recordings |
| Google Calendar | Event title, time, location, attendees + response status | Cancelled events, declined events |
| Apple Contacts | Names, emails, phones, org, job title, birthdays | — |
| Google Contacts | Names, emails, phones, org, job title, photo, notes | — |

Contact names resolved locally from macOS Contacts — nothing sent to any external service.

---

## Requirements

- macOS — uses macOS-specific databases for iMessages, Contacts, and call history
- Node.js 18+
- Full Disk Access for your terminal (System Settings → Privacy & Security → Full Disk Access)
- Google OAuth credentials (optional — for Gmail and Calendar)

---

## Setup

```bash
git clone https://github.com/nathan0colestock-code/comms.git
cd comms && npm install
cp .env.example .env
openssl rand -hex 32   # paste as API_KEY in .env
npm start              # dashboard at http://localhost:3748
```

**Gmail + Calendar OAuth (optional):** Create a Web application OAuth 2.0 client at [console.cloud.google.com](https://console.cloud.google.com). Add `http://localhost:3748/api/gmail/callback` as a redirect URI. Paste the client ID and secret into `.env`, then click **+ Gmail** in the dashboard. Calendar and Contacts sync automatically once Gmail is connected.

---

## Meeting playbooks

Apply a named conversational framework to any meeting — Comms generates stage-by-stage guidance grounded in your real history with the attendee, including sample phrases you could use.

| Playbook | What it's for |
|---|---|
| **Auto** | Scans context and picks the best fit, explains why |
| **Challenger Sale** | Teaching → reframing → rational drowning → new way → solution |
| **SPIN Selling** | Situation → problem → implication → need-payoff |
| **Sandler 7-Step** | Bonding → up-front contract → pain → budget → decision |
| **MEDDIC** | Metrics → economic buyer → decision criteria → pain → champion |
| **GROW Coaching** | Goal → reality → options → will/way-forward |
| **Radical Candor** | Employee-led agenda, care personally + challenge directly |
| **Crucial Conversations (STATE)** | Share facts → tell story → ask theirs → tentative → encourage |
| **Nonviolent Communication** | Observation → feeling → need → request |
| **Getting to Yes** | Separate people from problem → interests not positions → options |
| **Start/Stop/Continue** | Retro framing for partnerships and projects |
| **Five Whys** | Root cause analysis |
| **STAR Feedback** | Situation → task → action → result |
| **Custom** | Define your own frameworks, stored in the database |

---

## API

All routes require `Authorization: Bearer <API_KEY>` (or `SUITE_API_KEY` for inter-app calls).

### System
```
GET  /api/health                               — liveness, no auth
GET  /api/status                               — suite-standard status envelope
GET  /api/telemetry/nightly                    — metrics for maestro's nightly analyst
GET  /api/sync-status                          — per-source last-sync times and health
```

### Collection
```
GET  /api/runs                                 — recent runs (last 60 days)
GET  /api/runs/:date                           — messages + emails for a specific date
POST /api/collect/:date                        — trigger collection for a date
POST /api/collect/catchup                      — collect all missing dates since last run
```

### Search
```
GET  /api/search?q=...                         — unified search across messages, emails, contacts
```

### Contacts
```
GET  /api/contacts                             — list all contacts
GET  /api/contacts/:name                       — full profile + timeline + Gloss notes + special dates
POST /api/contacts/:name/insight               — generate AI insight paragraph
GET  /api/contacts/:name/profile               — user-authored relationship profile
PUT  /api/contacts/:name/profile               — save relationship profile
PUT  /api/contacts/:name/rename                — rename and merge aliases
POST /api/contacts/:name/draft-message         — AI-draft email or iMessage body
POST /api/contacts/:name/message-template      — short message draft with channel recommendation
```

### Calendar
```
GET  /api/calendar/events                      — events for next N days (default 14, max 60)
GET  /api/calendar/events/:id                  — event detail + cached brief
POST /api/calendar/events/:id/brief            — generate meeting brief from history + Gloss + calendar
POST /api/calendar/events/:id/prep             — reminder-only synthesis of user-authored content
POST /api/calendar/events/:id/playbook         — apply a named conversational framework
POST /api/calendar/poll                        — manually trigger calendar sync
GET  /api/calendar/list                        — list all calendars per account
GET/PUT /api/settings                          — app settings (enabled calendars, etc.)
```

### Special Dates
```
GET  /api/upcoming-special-dates               — dates in next N days (default 60)
GET  /api/special-dates                        — all special dates, filter by contact
POST /api/special-dates                        — create a manual entry
DELETE /api/special-dates/:id                  — delete
```

### Agenda
```
GET  /api/agenda/:scope_type/:scope_id         — open action items (scope: person or event)
POST /api/agenda                               — create agenda item
PATCH /api/agenda/:id                          — update (mark done, change content)
DELETE /api/agenda/:id                         — delete
```

### People Review
```
GET  /api/people/review/next?skip=N            — next person due for review
GET  /api/people/review/due?days=N             — count overdue contacts
POST /api/people/review/:id/reviewed           — mark reviewed
```

### People & Deduplication
```
GET  /api/people/resolve                       — resolve a name to a canonical person record
GET  /api/people/:id                           — get person record
GET  /api/people/duplicates                    — likely duplicates (fuzzy name + phone)
POST /api/people/merge                         — merge records, preserving full history
POST /api/people/reject-merge                  — dismiss a suggested duplicate pair
POST /api/people/rebuild                       — force full rebuild of people deduplication
```

### Nudges
```
GET  /api/nudges                               — contacts due for outreach
POST /api/nudges/:contact/dismiss              — dismiss for this week
```

### Address Book
```
GET  /api/address-book                         — list with search and pagination
GET  /api/address-book/stats                   — total by source
GET  /api/address-book/:id                     — single contact detail
POST /api/address-book/sync/apple              — sync from macOS Contacts
POST /api/address-book/sync/google             — sync from Google Contacts
POST /api/address-book/sync                    — sync both
```

### Playbook Models
```
GET  /api/playbook/models                      — built-in + custom frameworks
GET  /api/playbook/custom                      — user-defined models
POST /api/playbook/custom                      — create custom model
PUT  /api/playbook/custom/:key                 — update
DELETE /api/playbook/custom/:key               — delete
```

### Email Helper
```
POST /api/email-helper/run                     — manually trigger inbox triage
GET  /api/email-helper/runs                    — recent triage runs with summaries
GET  /api/email-helper/unsubscribes            — newsletters queued for review
POST /api/email-helper/unsubscribes/:id/approve
POST /api/email-helper/unsubscribes/:id/dismiss
```

### Gmail
```
GET  /api/gmail/accounts                       — connected Gmail accounts
GET  /api/gmail/auth                           — initiate OAuth
GET  /api/gmail/callback                       — OAuth callback
DELETE /api/gmail/accounts/:id                 — disconnect account
```

### Gloss Integration
```
POST /api/gloss/contacts                       — receive contact profiles from Gloss
POST /api/gloss/notes                          — receive timeline notes from Gloss
```

---

## Background jobs

| Job | Schedule | What it does |
|---|---|---|
| Calendar sync | Every 30 min + on boot | Fetches past 180 days + future 30 days; prunes events older than 365 days |
| Address book sync | Every 6 hours + on boot | Apple Contacts (local SQLite) + Google Contacts (per account) |
| Email triage | 08:00 and 12:00 local | Classifies inbox, drafts replies, queues unsubscribes |

---

## Install as background services

```bash
bash install.sh
```

Generates launchd plist files for your machine and loads them immediately.

---

## Tests

```bash
npm test   # 42 tests — unit, DB, and HTTP via Node's built-in test runner
```

---

## Privacy

- **iMessages + call history**: read directly from macOS, stored in your local SQLite database, never transmitted
- **Gmail**: only metadata (sender, subject, snippet) — full bodies never requested; flows through your own Google OAuth credentials
- **Apple Contacts**: read directly from macOS AddressBook, no external calls
- **Google Contacts/Calendar**: fetched via Google APIs using your OAuth tokens
- **AI**: runs through Gemini via your own API key — no third-party indexing
- No analytics; SQLite optionally replicated to your own Cloudflare R2 bucket via Litestream

---

## Suite siblings

Comms is the **relationships + meetings** node of a five-app personal suite. Independent processes, all on [Fly.io](https://fly.io), backed up to Cloudflare R2 via [Litestream](https://litestream.io).

| App | What it does | What flows to/from Comms |
|---|---|---|
| **[gloss](https://github.com/nathan0colestock-code/gloss)** | Personal knowledge graph (journal OCR, pages, people) | Gloss pushes contact profiles and timeline notes; Comms surfaces them in meeting briefs and people review |
| **[scribe](https://github.com/nathan0colestock-code/scribe)** | Collaborative document editor | "Send to Comms" hands a draft for Gmail outbound in the recipient's voice |
| **[black hole](https://github.com/nathan0colestock-code/black)** | Personal file search (Drive, Evernote, iCloud) | Black Hole can enrich search hits with contact context |
| **[maestro](https://github.com/nathan0colestock-code/maestro)** | Overnight code orchestration | Polls `/api/status`; dispatches feature sets |

All five apps expose `GET /api/status` → `{ app, version, ok, uptime_seconds, metrics }`, Bearer-authed.

---

---

## Have Claude help you set this up

Paste this into [Claude](https://claude.ai) to get guided setup assistance:

> I want to set up Comms from https://github.com/nathan0colestock-code/comms. It reads my iMessages, Gmail, and calendar. The server can run locally or on Fly.io, but the iMessage and call history collection requires running the collector on my Mac with Full Disk Access enabled. Help me get it set up step by step — I'll tell you whether I want it local-only or also deployed to Fly.io, and I'll share any error messages as we go.
