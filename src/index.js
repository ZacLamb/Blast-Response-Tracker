require('dotenv').config();
const express = require('express');
const webhookRoutes = require('./routes/webhook');
const statusRoutes = require('./routes/status');
const cronJob = require('./cron');

const app = express();
app.use(express.json());

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
