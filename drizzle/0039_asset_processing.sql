-- Bounded processing is independent of successful immutable uploads.
CREATE TABLE asset_processing (
  processing_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  processor_version TEXT NOT NULL,
  state TEXT NOT NULL CONSTRAINT asset_processing_state CHECK (state IN ('queued', 'running', 'ready', 'failed')),
  error_code TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX asset_processing_asset_generation ON asset_processing(asset_id, generation);
CREATE INDEX asset_processing_asset ON asset_processing(asset_id, generation);
CREATE INDEX asset_processing_user_due ON asset_processing(user_id, state, lease_until);
CREATE INDEX asset_processing_user_created ON asset_processing(user_id, created_at);
-- Usage survives an original's explicit deletion; it cannot reset the daily cap.
CREATE TABLE asset_processing_admissions (
  processing_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX asset_processing_admissions_user ON asset_processing_admissions(user_id, created_at);
CREATE TABLE asset_drain_state (
  namespace TEXT PRIMARY KEY NOT NULL,
  after_user_id TEXT NOT NULL DEFAULT '',
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE asset_processing_outputs (
  processing_id TEXT PRIMARY KEY NOT NULL REFERENCES asset_processing(processing_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
  object_id TEXT NOT NULL,
  original_sha256 TEXT NOT NULL,
  processor_version TEXT NOT NULL,
  extractor TEXT NOT NULL,
  text TEXT NOT NULL,
  truncated INTEGER NOT NULL,
  suggestions_json TEXT NOT NULL CONSTRAINT asset_processing_suggestions_json CHECK (json_valid(suggestions_json)),
  suggestion_model TEXT,
  suggestion_error TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE asset_processing_heads (
  asset_id TEXT PRIMARY KEY NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  processing_id TEXT NOT NULL REFERENCES asset_processing_outputs(processing_id) ON DELETE CASCADE
);
CREATE TABLE asset_suggestion_decisions (
  user_id TEXT NOT NULL,
  processing_id TEXT NOT NULL REFERENCES asset_processing_outputs(processing_id) ON DELETE CASCADE,
  field TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  decision TEXT NOT NULL CONSTRAINT asset_suggestion_decision CHECK (decision IN ('accepted', 'dismissed')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (processing_id, field, value)
);
-- No cascading FK: a deleted asset must leave the external deletion target.
CREATE TABLE asset_vector_pending (
  namespace TEXT NOT NULL,
  user_id TEXT NOT NULL,
  processing_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  chunk INTEGER NOT NULL,
  stamp TEXT NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 1,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  mutation_id TEXT,
  error_code TEXT,
  PRIMARY KEY (namespace, processing_id, chunk)
);
CREATE INDEX asset_vector_due ON asset_vector_pending(namespace, user_id, next_attempt_at, lease_until);
CREATE INDEX asset_vector_asset ON asset_vector_pending(user_id, asset_id);
