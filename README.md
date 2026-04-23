# Comm's

A local macOS tool that collects your daily iMessages and Gmail into a SQLite database so other apps can query it. No cloud, no AI — just a clean local record of who you talked to and about what.

## What it does

- Reads iMessages from `~/Library/Messages/chat.db` (with your permission)
- Fetches Gmail metadata (sender, subject, snippet — no full bodies) via the Gmail API
- Resolves phone numbers to real names using your macOS Contacts
- Filters out newsletters and automated emails — only real people
- Stores everything in `~/Library/Application Support/comms/comms.db`
- Dashboard at `http://localhost:3748` to view history and trigger collection

## Requirements

- **macOS** (uses macOS-specific databases for iMessages and Contacts)
- **Node.js** 18+
- **Full Disk Access** for your terminal (for iMessages — see below)
- **Google OAuth credentials** (for Gmail — optional)

## Setup

### 1. Install

```bash
git clone https://github.com/nathan0colestock-code/comms.git
cd comms
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

For Gmail, fill in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`:
- Go to [console.cloud.google.com](https://console.cloud.google.com)
- APIs & Services → Credentials → Create OAuth 2.0 Client ID → Web application
- Add `http://localhost:3748/api/gmail/callback` as an authorized redirect URI

### 3. Grant Full Disk Access (for iMessages)

System Settings → Privacy & Security → Full Disk Access → add your terminal app (Terminal, iTerm, etc.).

If you're running the server from within another app (e.g. an IDE), you may need to add that app instead.

### 4. Start the server

```bash
npm start
```

Dashboard: [http://localhost:3748](http://localhost:3748)

### 5. Connect Gmail (optional)

Click **+ Gmail** in the dashboard and complete the OAuth flow. If Google shows a warning screen, click **Advanced → Go to app (unsafe)** — expected for unverified apps.

### 6. Collect

- **Today** — collects today's messages and emails
- **Catch up** — collects all days since the last run (up to today)
- Or run from the CLI: `node collect.js 2026-04-22`

## Database

The SQLite database lives at `~/Library/Application Support/comms/comms.db`. Other apps can open it read-only with any SQLite client.

### Schema

```sql
-- One row per collection run
runs(id, date, collected_at, status, messages_count, emails_count, error)

-- Individual iMessages with full text
messages(id, run_id, date, contact, handle_id, direction, sender, text, sent_at)

-- Gmail metadata (no full bodies)
emails(id, run_id, date, direction, contact, email_address, subject, snippet, account)

-- Connected Gmail accounts (tokens stored locally)
gmail_accounts(id, email, token_json, added_at)
```

## Privacy

- iMessage text is stored locally in your own SQLite file — nothing leaves your machine
- Gmail: only metadata is fetched (sender, subject, snippet). Full email bodies are never stored
- Contacts: resolved locally from your macOS AddressBook — no external lookups
