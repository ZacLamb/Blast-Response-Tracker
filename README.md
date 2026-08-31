# blast-response-tracker

Tracks contacts who go through a blast and applies two independent tags in GHL,
tracking two separate signals:

- **`NR M-D-YY`** — hasn't responded to the *most recent* blast specifically.
  Dated to the check that confirmed it (e.g. `NR 8-31-26`). The reference point
  for "the blast" is the timestamp of the most recent OUTBOUND message actually
  found in the GHL conversation — not when our webhook happened to fire, since
  these blasts go out manually and our webhook can hear about it days or weeks
  later. Removed the moment a reply comes in after that outbound message; a new
  dated tag replaces the old one once the date rolls over.
- **`never-responded`** — hasn't sent a single inbound message, ever, in the
  whole conversation history. Independent of any specific blast: a contact can
  carry `NR M-D-YY` while NOT carrying `never-responded` (they replied to an
  older blast, just not the latest one), or carry both (truly silent), or
  neither (responded to the latest blast).

## How it works

1. GHL workflow fires a webhook to `POST /webhook/blast-sent` with the contact +
   a campaign tag. The row is saved, and a check runs immediately in the
   background — no wait time.
2. A cron job (default: every 6 hours) re-checks every `pending` row (a contact
   who hasn't replied to the latest blast yet): it resolves the GHL conversation
   thread, finds the real timestamp of the most recent outbound message, and
   checks for any inbound message after that point (→ `NR M-D-YY` signal) as
   well as any inbound message at all, ever (→ `never-responded` signal).
3. The `NR M-D-YY` tag is swapped for a fresh dated tag each time the date rolls
   over with no reply; it's removed and the row marked `responded` (stops being
   rechecked) the moment a reply lands after the latest blast.
4. The `never-responded` tag is added the first time a contact is confirmed to
   have zero inbound messages ever, and removed the first time that changes —
   independently of whatever's happening with `NR M-D-YY`.

## Deploy (Railway + GitHub, browser-only)

1. Push this folder to a new GitHub repo.
2. In Railway: New Project → Deploy from GitHub repo → pick the repo.
3. Add a Postgres plugin to the Railway project (Railway sets `DATABASE_URL`
   automatically).
4. Set these environment variables in Railway (Settings → Variables):
   - `GHL_API_TOKEN` — Private Integration Token from GHL Settings → Integrations
     → Private Integrations. Scopes needed: `conversations.readonly`,
     `conversations/message.readonly`, `contacts.readonly`, `contacts.write`.
   - `GHL_LOCATION_ID` — your sub-account id (fallback if the webhook payload
     doesn't include one).
   - `WEBHOOK_SECRET` — any random string (e.g. `openssl rand -hex 16`); also goes
     in the GHL webhook URL as a query param.
   - `CHECK_CRON` — default `0 */6 * * *` (every 6 hours).
5. Deploy. Then run the migration once, either:
   - Locally against the Railway `DATABASE_URL`: `npm install && npm run migrate`, or
   - Via Railway's one-off command runner (Deployments → ... → Run command):
     `node src/migrate.js`

## GHL workflow setup

In the workflow that fires right after your blast send action, add a **Webhook**
action:

- URL: `https://<your-railway-domain>/webhook/blast-sent?secret=<WEBHOOK_SECRET>`
- Method: POST
- Body (JSON):
  ```json
  {
    "contactId": "{{contact.id}}",
    "locationId": "{{location.id}}",
    "campaignTag": "aug-2026-mca-blast"
  }
  ```
  Set `campaignTag` to whatever you want this batch's tags to be scoped under —
  it becomes `responded-aug-2026-mca-blast` / `no-response-aug-2026-mca-blast`.
  Hardcode it per workflow, or drive it from a custom field if you reuse one
  workflow across campaigns.

## Checking status

- `GET /status/:campaignTag` — counts of pending/responded
- `GET /status/:campaignTag/contacts?status=no_response` — the actual contact ids
- `POST /run-check-now?secret=<WEBHOOK_SECRET>` — manually trigger a check cycle
  instead of waiting for the cron schedule (useful for testing)

## Notes / things to tune

- **Re-blasting the same contact under the same `campaignTag`** resets their
  tracking row (fresh `blasted_at`, fresh window) rather than creating a
  duplicate — so if your workflow can fire twice for the same send, that's safe.
- **"Replied" is scoped to after `blasted_at`.** An old reply from a previous,
  unrelated conversation won't falsely mark someone as responded to this blast.
- **Rate limits:** the cron checks with a concurrency cap of 5 at a time
  (`runBatch` in `src/cron.js`) to stay well under GHL's per-10-second burst
  limit. If you're checking thousands of contacts per cycle, consider lowering
  `LIMIT 500` in `runCheckCycle` or spreading the cron to run more frequently
  with smaller batches.
- **Tags don't get removed automatically** if a contact who was marked
  `no-response` later texts in on a totally separate thread — this only
  processes each row through the pending → responded/no_response lifecycle
  once. If you need re-evaluation, you'd re-fire the webhook for that contact.
