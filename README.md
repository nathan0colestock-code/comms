# Comm's

Comm's collects your daily iMessages and Gmail into a local SQLite database that your other personal apps can query. It runs as a lightweight background server on your Mac and exposes a dashboard for browsing history and triggering collection.

The point isn't the dashboard — it's the database. Once Comm's is running, any other app you build can open `~/Library/Application Support/comms/comms.db` read-only and query exactly who you talked to, about what, and when — without touching iCloud, Google's servers, or any third-party service.

![Comm's dashboard](screenshot.png)

---

## What it collects

| Source | What's stored | What's skipped |
|--------|--------------|----------------|
| iMessages | Full message text, sender name, contact, timestamp | Attachments with no text, reactions/tapbacks |
| Gmail | Sender, subject, snippet (first ~150 chars) | Full email bodies, newsletters, automated mail |

Contact names are resolved locally from your macOS Contacts — phone numbers and Apple IDs are looked up in AddressBook before anything is stored. Only emails from real people (i.e. contacts you have, or addresses that don't look automated) are kept.

Nothing leaves your machine.

---

## The database

**`~/Library/Application Support/comms/comms.db`** — SQLite, WAL mode, safe to open read-only from any other process.

```sql
-- One row per collection run (one per day)
runs(id, date, collected_at, status, messages_count, emails_count, error)

-- Individual iMessages with full text
messages(id, run_id, date, contact, handle_id, direction, sender, text, sent_at)

-- Gmail metadata (no full bodies)
emails(id, run_id, date, direction, contact, email_address, subject, snippet, account)

-- Connected Gmail accounts (OAuth tokens, stored locally)
gmail_accounts(id, email, token_json, added_at)
```

Example query from another app:

```js
const Database = require('better-sqlite3');
const db = new Database(
  require('os').homedir() + '/Library/Application Support/comms/comms.db',
  { readonly: true }
);

// Everyone I texted this week
const contacts = db.prepare(`
  SELECT contact, COUNT(*) AS messages
  FROM messages
  WHERE date >= date('now', '-7 days')
  GROUP BY contact
  ORDER BY messages DESC
`).all();
```

---

## Requirements

- **macOS** — uses macOS-specific databases for iMessages and Contacts
- **Node.js** 18+
- **Full Disk Access** for your terminal app (to read iMessages)
- **Google OAuth credentials** (only if you want Gmail — optional)

---

## Setup

### 1. Clone and install

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

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. **APIs & Services → Credentials → Create OAuth 2.0 Client ID**
3. Application type: **Web application**
4. Add `http://localhost:3748/api/gmail/callback` as an authorized redirect URI
5. Copy the client ID and secret into `.env`

If you don't want Gmail, leave those fields blank — iMessages will still work.

### 3. Grant Full Disk Access (required for iMessages)

**System Settings → Privacy & Security → Full Disk Access** — add your terminal app (Terminal, iTerm2, etc.).

> If you run the server from inside another app (VS Code, an IDE, etc.), grant Full Disk Access to that app instead — the permission applies to whichever process launches `node`.

### 4. Start the server

```bash
npm start
```

Dashboard opens at **[http://localhost:3748](http://localhost:3748)**.

### 5. Connect Gmail (optional)

Click **+ Gmail** in the dashboard header and complete the OAuth flow. If Google shows an "app not verified" warning screen, click **Advanced → Go to app (unsafe)** — this is expected for OAuth apps you've created yourself that haven't gone through Google's verification process.

### 6. Collect

- **Today** button — collects today's messages and emails right now
- **Catch up** button — collects every day since the last successful run, sequentially
- **CLI**: `node collect.js 2026-04-15` — collect a specific date

For automated daily collection, add a cron job or launchd agent that runs `node collect.js` once per night.

---

## Integration API

The server also exposes a small REST API for other apps:

```
GET  /api/runs               — list recent runs (last 60 days)
GET  /api/runs/:date         — full detail for a date (messages + emails)
POST /api/collect/:date      — trigger collection for a specific date
GET  /api/gmail/accounts     — list connected Gmail accounts
```

Example — fetch today's communications from another Node.js app:

```js
const res = await fetch('http://localhost:3748/api/runs/2026-04-22');
const { messages, emails } = await res.json();
```

---

## Privacy

- **iMessages**: text is stored in your local SQLite file only — nothing is transmitted anywhere
- **Gmail**: only metadata is fetched (sender, subject, snippet). Full message bodies are never requested or stored
- **Contacts**: resolved locally from your macOS AddressBook — no external API calls
- **No AI, no cloud, no analytics** — the server has no outbound connections except to the Gmail API when you've connected an account
