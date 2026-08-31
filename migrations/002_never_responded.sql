ALTER TABLE blast_tracking
  ADD COLUMN IF NOT EXISTS never_responded_tag_applied BOOLEAN NOT NULL DEFAULT false;
