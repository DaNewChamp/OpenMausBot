ALTER TABLE installations
  ADD COLUMN runtime_profile TEXT NOT NULL DEFAULT 'desktop-hub';

ALTER TABLE installations
  ADD COLUMN capabilities_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE installations
  ADD COLUMN presence_updated_at INTEGER;

CREATE INDEX IF NOT EXISTS installations_owner_presence_idx
  ON installations(owner_user_id, presence_updated_at);
