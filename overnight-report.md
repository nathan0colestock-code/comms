# Overnight report — stream: comms

Branch: `maestro/overnight-comms-20260423`

## Shipped

- **SPEC 3 — Relational Health Score**
  - Migrations: `gloss_contacts.target_cadence_days`, `gloss_contacts.gloss_push_hash`, plus a matching nullable `contacts.target_cadence_days` column (per literal-spec reading).
  - `getContactHealth(contactKey)` → `{ contact, last_contact_at, days_since, target, score, band }` where band ∈ `healthy|overdue|red` at score cutoffs 1.0 / 2.0. "Last contact" = `MAX(messages.sent_at, emails.date)`.
  - `defaultCadenceForPriority()` — priority 1/2/3 → 7/30/90, else 90. Applied on first Gloss push when the user hasn't set a target; never overwrites an existing cadence.
  - `listPeopleForReview({sort})` — default `sort=health` sorts by band DESC then score DESC (most overdue first); `sort=alpha` returns legacy alphabetic.
  - `setContactCadence(name, days)` — validates positive integer or null, persists, returns fresh health row.
  - HTTP endpoints:
    - `GET  /api/people/review[?sort=alpha]`
    - `GET  /api/contacts/:name/health`
    - `PATCH /api/contacts/:name`  body: `{ target_cadence_days: int|null }`
    - `PUT  /api/contacts/:name/cadence` (minimal-UX variant — dedicated settings endpoint as spec'd for the no-UI fallback).

- **C-I-01 (simplified per orchestrator rule)** — INSIGHTS_MODEL selection, Gemini-only.
  - `resolveInsightsModel()` picks among `gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.0-flash`. The value `claude` is accepted as an alias for `gemini-2.5-pro` so the env-var name in `comms.md` still works.
  - `callInsightsModel()` retries on 5xx / ECONNRESET / ETIMEDOUT to `gemini-2.0-flash`.
  - `generateContactInsight()` now uses `callInsightsModel()`.
  - Full Claude + prompt-caching spec deferred — see recommendation ID 7.

- **C-I-03 — Gloss push dedup.**
  - `canonicalJsonStringify()` + `computeGlossPushHash()` (SHA-256 over sorted-keys canonical payload, excluding push-time timestamps).
  - `upsertGlossContact()` skips the full UPSERT when the hash matches the stored `gloss_push_hash`, bumping only `synced_at`. Returns `{skipped, hash}` so callers can count no-ops.

- **C-P-01 — Email-classifier edit rate.**
  - New `email_draft_log` table + `recordEmailDraft()` helper; `email-helper.js` writes each new draft body after saving to Gmail.
  - `getEmailEditRate({days:7})` compares each draft against the eventual sent reply in the same Gmail thread via a token-level Jaccard distance. Reports `{ compared, avg_edit_ratio, distribution:{unedited,light,heavy,rewrite} }`.
  - Surfaced in `getNightlyTelemetry()` as `edit_rate_7d`.

- **C-P-02 — People-review cadence adherence.**
  - `getCadenceAdherence({days:7})` → `{ due_last_7d, met, adherence_rate }`. Denominator = contacts whose last-contact age at t-7d exceeded their target; numerator = those now under their target.
  - Surfaced in `getNightlyTelemetry()` as `cadence_adherence_7d`.

- **Structured logging contract (shared-rules §).**
  - New `log.js` module: `log(level,event,ctx)`, JSON-line stderr emit, 1000-entry ring buffer, `httpMiddleware()` with X-Trace-Id echo/generate + per-request log entry (info/warn/error by status class), `outboundWrap()` helper for outbound calls, `patchConsole()` so every unmigrated `console.*` still lands in the ring buffer as `event='console'`.
  - `GET /api/logs/recent?since=&level=&limit=&trace_id=` — bearer-gated (API_KEY or SUITE_API_KEY), applies 24h window + level floor + optional trace filter.
  - `patchConsole()` called at server boot; one explicit `log('info','server_boot',...)` on listen.

## Tests — 136 pass / 0 fail

42 new tests across 5 files:
- `test/health.test.js` (17) — band cutoffs, default cadence, canonical-JSON / hash stability, upsert dedup, `listPeopleForReview` sort, `setContactCadence` persistence + validation.
- `test/health-api.test.js` (5) — end-to-end: `/api/people/review` default-vs-alpha sort, PATCH persists + reflects in health, missing-field 400, unknown-contact 404.
- `test/log.test.js` (8) — level filter, ring-buffer cap at 1000, `/api/logs/recent` bearer enforcement, http middleware fires and populates the buffer, X-Trace-Id round-trip.
- `test/ai-model.test.js` (6) — INSIGHTS_MODEL default/override/unknown/pro/2.0-flash, `isRetryableGeminiError` for numeric + embedded-5xx.
- `test/telemetry.test.js` (6) — `approximateEditRatio` edge cases, `getEmailEditRate` happy path, `getCadenceAdherence` window semantics, `getNightlyTelemetry` surfaces the two new fields.

`npm test` output: `tests 136 / pass 136 / fail 0 / duration_ms ~11000`.

## Deferred

- **C-B-01 — collect.js split** (out of scope per `comms.md`). Filed recommendation ID 8.
- **C-I-01 Claude+prompt-caching path** — ANTHROPIC_API_KEY unset in overnight env. Shipped Gemini-variant selection instead. Filed recommendation ID 7.
- **SPEC 3 full UX (inline-editable cadence field)** — shipped minimal variant (readonly health + PUT cadence endpoint) per the `comms.md` fallback. Filed recommendation ID 9.

## Bugs fixed

None — stayed in scope. No unrelated bugs noticed in the edited files.

## Questions filed (Maestro recommendations)

- `#7` C-I-01 Claude + prompt-caching deferral (priority 3)
- `#8` C-B-01 collect.js split deferral (priority 3)
- `#9` SPEC 3 full inline-cadence UX (priority 3)

## Files touched

Added:
- `log.js`
- `test/health.test.js`
- `test/health-api.test.js`
- `test/log.test.js`
- `test/ai-model.test.js`
- `test/telemetry.test.js`

Modified:
- `ai.js` — INSIGHTS_MODEL selector + retry
- `collect.js` — migrations, SPEC 3 helpers, hash dedup, telemetry helpers, exports
- `email-helper.js` — draft logging hook
- `server.js` — log middleware, endpoints, imports, patchConsole
- `package.json` — new test files registered
