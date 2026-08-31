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
app.post('/run-check-now', async (req, res) => {
  if (req.query.secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }
  try {
    await cronJob.runCheckCycle();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`blast-response-tracker listening on :${port}`);
  cronJob.start();
});
