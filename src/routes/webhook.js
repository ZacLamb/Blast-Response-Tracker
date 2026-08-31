const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// POST /webhook/blast-sent?secret=...
// GHL's native (free) Webhook action sends the full contact payload plus whatever
// you added under "Custom Data" nested at body.customData, and the sub-account
// info nested at body.location — not flat top-level fields. This reads both
// shapes so it works whether the values come from GHL's native webhook or a
// flatter custom body.
// Call this from a GHL workflow step right after the blast send action.
// It just logs the row — no GHL API calls happen here, since checking for a reply
// zero seconds after sending is meaningless.
router.post('/blast-sent', async (req, res) => {
  if (req.query.secret !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'invalid secret' });
  }

  const body = req.body || {};
  const contactId = body.customData?.contactId || body.contactId || body.contact_id;
  const campaignTag = body.customData?.campaignTag || body.campaignTag;
  const locationId =
    body.location?.id || body.customData?.locationId || body.locationId || process.env.GHL_LOCATION_ID;

  if (!contactId || !campaignTag || !locationId) {
    console.error('Webhook payload missing fields. Received body:', JSON.stringify(body));
    return res.status(400).json({
      error: 'contactId, campaignTag, and locationId (customData, location.id, or GHL_LOCATION_ID env) are required',
      received: body,
    });
  }

  try {
    // ON CONFLICT: if this contact gets blasted again under the same campaign_tag,
    // reset tracking rather than creating a duplicate/stale row.
    await pool.query(
      `INSERT INTO blast_tracking (contact_id, location_id, campaign_tag, blasted_at, status)
       VALUES ($1, $2, $3, now(), 'pending')
       ON CONFLICT (contact_id, campaign_tag)
       DO UPDATE SET
         blasted_at = now(),
         status = 'pending',
         conversation_id = NULL,
         responded_at = NULL,
         error = NULL,
         updated_at = now()`,
      [contactId, locationId, campaignTag]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error('webhook insert failed:', err);
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
