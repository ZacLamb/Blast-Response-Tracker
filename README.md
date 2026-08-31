# blast-response-tracker

Tags every contact who's been through a blast with **`never-responded`** if
they have not sent a single inbound message, ever, in their whole conversation
history — and removes that tag the moment they reply for the first time,
whenever that happens. That's the whole system: one signal, one tag.

## How it works

1. GHL workflow fires a webhook to `POST /webhook/blast-sent` with the contact +
   a campaign tag. The row is saved, and a check runs immediately in the
   background — no wait time.
2. The check resolves the GHL conversation thread for that contact and looks
   for any inbound message at all, ever.
3. If none exists → tag `never-responded` is applied, and the row stays
   `pending` so it gets rechecked on the next cron cycle.
4. The moment any inbound message is found → the tag is removed, and the row
   is marked `responded` (stops being rechecked — once someone's replied, that
   doesn't change).
5. A cron job (default: every hour) re-checks every `pending` row the same
   way, so contacts who go quiet-to-responsive get caught automatically.

## Throughput for a large backlog

Each check is 1-3 GHL API calls (find the conversation, walk its messages,
add/remove a tag). GHL caps requests at 100 per 10 seconds per location; this
runs at a safe ~80/10s with 20 concurrent workers, so a 15,000-contact backlog
takes roughly an hour on its first full pass — not instant, but continuous and
automatic from then on rather than trickling through a few hundred at a time.
To kick off processing the full backlog right away instead of waiting for the
next scheduled cron tick, hit `/run-check-now` (see below) — it starts the run
in the background and returns immediately, so you don't have to keep a browser
tab open. Watch progress in Railway's logs (`cron: checked N/total...`) or by
polling `/status/:campaignTag`.

Filter contacts in GHL by the `never-responded` tag at any time for your
current list of contacts who have genuinely never engaged.

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
   - `CHECK_CRON` — default `0 * * * *` (every hour).
5. Deploy. Then, from a browser, visit
   `https://<your-railway-domain>/admin/migrate?secret=<WEBHOOK_SECRET>` once
   to create/update the database schema.

## GHL workflow setup

In the workflow that fires when a blast goes out, add a **Webhook** action:

- URL: `https://<your-railway-domain>/webhook/blast-sent?secret=<WEBHOOK_SECRET>`
- Method: POST
- Under **Custom Data**, add:
  - `contactId` → `{{contact.id}}`
  - `campaignTag` → a literal string identifying this blast, e.g. `aug-2026-mca-blast`
- `locationId` doesn't need to be set manually — GHL's native webhook already
  includes `location.id`, which the server reads automatically.

## Checking status

- `GET /status/:campaignTag` — counts of pending/responded
- `GET /status/:campaignTag/contacts?status=pending` — the actual contact ids
  still tagged `never-responded`
- `GET /status/:campaignTag/contacts?status=responded` — contacts who have replied
- `GET /run-check-now?secret=<WEBHOOK_SECRET>` — kicks off a check of the
  entire pending backlog in the background and responds immediately; doesn't
  block waiting for it to finish. Safe to call again while one is already
  running — it'll just report `alreadyRunning: true` instead of starting a
  second overlapping run.
- `GET /admin/migrate?secret=<WEBHOOK_SECRET>` — run any pending database
  migrations (also works from a browser)

## Notes

- **Re-blasting the same contact under the same `campaignTag`** resets their
  tracking row rather than creating a duplicate — safe if your workflow fires
  more than once for the same send.
- **Rate limits:** the cron checks with a concurrency cap of 5 at a time
  (`runBatch` in `src/cron.js`) to stay well under GHL's per-10-second burst
  limit. If you're checking thousands of contacts per cycle, consider lowering
  `LIMIT 500` in `runCheckCycle` or spreading the cron to run more frequently
  with smaller batches.
