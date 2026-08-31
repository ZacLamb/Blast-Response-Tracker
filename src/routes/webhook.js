const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// POST /webhook/blast-sent?secret=...
// Body: { contactId, locationId?, campaignTag }
// Call this from a GHL workflow step right after the blast send action.
// It just logs the row — no GHL API calls happen here, since checking for a reply
// zero seconds after sending is meaningless.
router.post('/blast-sent', async (req, res) => {
  if (req.query.secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }

  const { contactId, campaignTag } = req.body || {};
  const locationId = req.body?.locationId || process.env.GHL_LOCATION_ID;

  if (!contactId || !campaignTag || !locationId) {
    return res.status(400).json({
      error: 'contactId, campaignTag, and locationId (body or GHL_LOCATION_ID env) are required',
    });
  }

  const windowDays = Number(process.env.RESPONSE_WINDOW_DAYS || 7);
  const finalCheckAt = new Date(Date.now() + windowDays * 24 * 60 * 60 * 1000);

  try {
    // ON CONFLICT: if this contact gets blasted again under the same campaign_tag,
    // reset the tracking window rather than creating a duplicate/stale row.
    await pool.query(
      `INSERT INTO blast_tracking (contact_id, location_id, campaign_tag, blasted_at, final_check_at, status)
       VALUES ($1, $2, $3, now(), $4, 'pending')
       ON CONFLICT (contact_id, campaign_tag)
       DO UPDATE SET
         blasted_at = now(),
         final_check_at = $4,
         status = 'pending',
         conversation_id = NULL,
         responded_at = NULL,
         error = NULL,
         updated_at = now()`,
      [contactId, locationId, campaignTag, finalCheckAt]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('webhook insert failed:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
