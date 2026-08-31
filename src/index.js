require('dotenv').config();
const express = require('express');
const webhookRoutes = require('./routes/webhook');
const statusRoutes = require('./routes/status');
const cronJob = require('./cron');

const app = express();

// Parse the body as JSON regardless of the incoming Content-Type header — GHL's
// webhook action doesn't always set Content-Type: application/json even when the
// body itself is JSON, and express.json() silently skips parsing when the header
// doesn't match, leaving req.body empty.
app.use(express.json({ type: () => true }));

// If the body genuinely isn't valid JSON, return a clear 400 instead of crashing.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    console.error('Body was not valid JSON:', err.body);
    return res.status(400).json({ error: 'request body is not valid JSON', raw: err.body });
  }
  next(err);
});

app.get('/', (req, res) => res.json({ ok: true, service: 'blast-response-tracker' }));

app.use('/webhook', webhookRoutes);
app.use('/status', statusRoutes);

// Manual trigger, useful for testing without waiting for the cron schedule.
// GET so it also works from a plain browser address bar; POST kept for scripts/curl.
// Runs in the background and responds immediately — a large backlog can take a
// while (rate-limited against GHL), so this doesn't hold the HTTP connection
// open for the whole run. Check Railway's logs for progress ("cron: checked
// N/total...") or poll /status/:campaignTag to watch counts change.
let runInProgress = false;
async function handleRunCheckNow(req, res) {
  if (req.query.secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }
  if (runInProgress) {
    return res.json({ ok: true, alreadyRunning: true });
  }
  runInProgress = true;
  res.json({ ok: true, started: true });
  cronJob
    .runCheckCycle()
    .catch((err) => console.error('manual run-check-now failed:', err))
    .finally(() => {
      runInProgress = false;
    });
}
app.get('/run-check-now', handleRunCheckNow);
app.post('/run-check-now', handleRunCheckNow);

// One-off migration trigger, for browser-only setups with no local CLI. Hit this
// URL directly (GET, so it works from a browser address bar) after deploying to
// create/update the schema. Safe to call more than once — migrations that already
// ran will just error harmlessly on "already exists" style statements if you add
// more later; the initial migration uses CREATE TABLE IF NOT EXISTS.
app.get('/admin/migrate', async (req, res) => {
  if (req.query.secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }
  try {
    const fs = require('fs');
    const path = require('path');
    const { pool } = require('./db');
    const dir = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const ran = [];
    for (const file of files) {
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      await pool.query(sql);
      ran.push(file);
    }
    res.json({ ok: true, ran });
  } catch (err) {
    console.error('migration via /admin/migrate failed:', err);
    res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`blast-response-tracker listening on :${port}`);
  cronJob.start();
});
