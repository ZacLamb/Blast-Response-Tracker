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

// GET /status/:campaignTag/contacts?status=no_response  -> the actual contact list
router.get('/:campaignTag/contacts', async (req, res) => {
  const status = req.query.status || 'no_response';
  const { rows } = await pool.query(
    `SELECT contact_id, status, blasted_at, responded_at, final_check_at
     FROM blast_tracking
     WHERE campaign_tag = $1 AND status = $2
     ORDER BY blasted_at DESC`,
    [req.params.campaignTag, status]
  );
  res.json({ campaignTag: req.params.campaignTag, status, contacts: rows });
});

module.exports = router;
