# blast-response-tracker

Tracks contacts who go through a specific blast and tags each still-unreplied
contact with a single dated tag — `no-response-since-YYYY-MM-DD` — based on
whether they *ever* sent an inbound message after the blast, not just whether
the last message in the thread happens to be outbound. No expiry window: a
contact who hasn't replied stays in the check rotation indefinitely.

## How it works

1. GHL workflow (triggered right after your blast send step) fires a webhook to
   `POST /webhook/blast-sent` with the contact + a campaign tag. The row is saved,
   and a check for a reply runs immediately in the background — no wait time.
2. From then on, a cron job (default: every 6 hours) re-checks every `pending`
   row: it resolves the GHL conversation thread, walks its full message history,
   and checks whether any inbound message landed *after* `blasted_at`.
3. If still no reply → the contact gets tagged `no-response-since-{today's date}`.
   If they already carried a dated tag from an earlier run on the same calendar
   day, nothing changes. If the date has rolled over since the last check, the
   old dated tag is removed and the new one applied — so a contact only ever
   carries **one** no-response tag at a time, and its date tells you exactly how
   current that read is.
4. The moment a reply is found → the no-response tag is removed and the contact
   is marked `responded` (stops being rechecked). No "responded" tag is added;
   absence of the no-response tag *is* the responded state.

Filter contacts in GHL by any `no-response-since-*` tag (or by the specific
date) for your current never-responded list.

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
