const express = require('express');
const { pool } = require('../db');

const router = express.Router();

// GET /status/:campaignTag  -> counts by status
router.get('/:campaignTag', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT status, count(*)::int AS count
     FROM blast_tracking
     WHERE campaign_tag = $1
     GROUP BY status`,
    [req.params.campaignTag]
  );
  res.json({ campaignTag: req.params.campaignTag, counts: rows });
});

// GET /status/:campaignTag/contacts?status=pending  -> the actual contact list
// status is 'pending' (never responded, still being checked) or 'responded'
router.get('/:campaignTag/contacts', async (req, res) => {
  const status = req.query.status || 'pending';
  const { rows } = await pool.query(
    `SELECT contact_id, status, current_tag, blasted_at, responded_at, last_checked_at
     FROM blast_tracking
     WHERE campaign_tag = $1 AND status = $2
     ORDER BY blasted_at DESC`,
    [req.params.campaignTag, status]
  );
  res.json({ campaignTag: req.params.campaignTag, status, contacts: rows });
});

module.exports = router;
