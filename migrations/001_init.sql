CREATE TABLE IF NOT EXISTS blast_tracking (
  id SERIAL PRIMARY KEY,
  contact_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  campaign_tag TEXT NOT NULL,
  blasted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  conversation_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | responded | no_response
  last_checked_at TIMESTAMPTZ,
  final_check_at TIMESTAMPTZ NOT NULL,
  responded_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- one row per contact per campaign, so re-sending the same blast (retries, webhook
  -- retries from GHL) doesn't create duplicate tracking rows
  UNIQUE (contact_id, campaign_tag)
);

CREATE INDEX IF NOT EXISTS idx_blast_tracking_status ON blast_tracking (status);
CREATE INDEX IF NOT EXISTS idx_blast_tracking_campaign ON blast_tracking (campaign_tag);
