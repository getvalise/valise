-- Review drafts never publish to search. Only a console approval writes memories/links.
CREATE INDEX memories_review_project ON memories(user_id, project, updated_at, memory_id);
--> statement-breakpoint
CREATE TABLE memory_review_settings (
  user_id TEXT PRIMARY KEY NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CONSTRAINT memory_review_enabled CHECK (enabled IN (0, 1)),
  overnight INTEGER NOT NULL DEFAULT 0 CONSTRAINT memory_review_overnight CHECK (overnight IN (0, 1)),
  model TEXT NOT NULL DEFAULT '@cf/meta/llama-3.1-8b-instruct-fp8',
  daily_calls INTEGER NOT NULL DEFAULT 2 CONSTRAINT memory_review_calls CHECK (daily_calls BETWEEN 1 AND 8),
  daily_microusd INTEGER NOT NULL DEFAULT 10000 CONSTRAINT memory_review_cost CHECK (daily_microusd BETWEEN 1000 AND 100000),
  next_run_at INTEGER NOT NULL DEFAULT 0,
  lock_token TEXT,
  lock_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX memory_review_due ON memory_review_settings(enabled, overnight, next_run_at);
--> statement-breakpoint
CREATE TABLE memory_review_pending (
  memory_id TEXT PRIMARY KEY NOT NULL REFERENCES memories(memory_id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  enqueued_at INTEGER NOT NULL
);
CREATE INDEX memory_review_pending_user ON memory_review_pending(user_id, enqueued_at, memory_id);
--> statement-breakpoint
CREATE TABLE memory_review_groups (
  group_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  proposal_json TEXT,
  draft_title TEXT,
  draft_body TEXT,
  state TEXT NOT NULL CONSTRAINT memory_review_state CHECK (state IN ('running', 'proposal', 'noop', 'failed', 'dismissed', 'accepted')),
  attempts INTEGER NOT NULL DEFAULT 1,
  retry_at INTEGER NOT NULL DEFAULT 0,
  result_memory_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX memory_review_groups_fingerprint ON memory_review_groups(user_id, fingerprint);
CREATE INDEX memory_review_groups_user ON memory_review_groups(user_id, created_at, group_id);
CREATE INDEX memory_review_retry ON memory_review_groups(user_id, state, retry_at);
--> statement-breakpoint
CREATE TABLE memory_review_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL REFERENCES memory_review_groups(group_id),
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CONSTRAINT memory_review_event_kind CHECK (kind IN ('edit-title', 'edit-body', 'dismiss', 'reopen', 'accept')),
  value TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX memory_review_events_group ON memory_review_events(user_id, group_id, created_at);
--> statement-breakpoint
CREATE TABLE memory_review_budgets (
  user_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  calls INTEGER NOT NULL,
  reserved_microusd INTEGER NOT NULL,
  PRIMARY KEY(user_id, day)
);
--> statement-breakpoint
-- One initial walk; all later eligibility is incremental. No pair table or daily corpus scan.
INSERT INTO memory_review_pending(memory_id, user_id, enqueued_at)
  SELECT memory_id, user_id, updated_at FROM memories WHERE deleted_at IS NULL;
--> statement-breakpoint
-- Explicit UPSERTs survive an outer memory/link UPSERT's conflict policy;
-- INSERT OR REPLACE in a trigger can instead inherit ABORT and reject a link confirmation.
CREATE TRIGGER memory_review_insert AFTER INSERT ON memories WHEN NEW.deleted_at IS NULL BEGIN
  INSERT INTO memory_review_pending(memory_id, user_id, enqueued_at)
    VALUES (NEW.memory_id, NEW.user_id, unixepoch())
    ON CONFLICT(memory_id) DO UPDATE SET user_id = excluded.user_id, enqueued_at = excluded.enqueued_at;
  INSERT INTO memory_review_pending(memory_id, user_id, enqueued_at)
    SELECT memory_id, user_id, unixepoch() FROM memories WHERE deleted_at IS NULL AND memory_id IN (
      SELECT CASE WHEN from_memory_id = NEW.memory_id THEN to_memory_id ELSE from_memory_id END
      FROM memory_links WHERE (from_memory_id = NEW.memory_id OR to_memory_id = NEW.memory_id) AND removed_at IS NULL)
    ON CONFLICT(memory_id) DO UPDATE SET user_id = excluded.user_id, enqueued_at = excluded.enqueued_at;
END;
--> statement-breakpoint
CREATE TRIGGER memory_review_change AFTER UPDATE OF title, body, memory_type, tags_json, project, deleted_at ON memories
WHEN NEW.title IS NOT OLD.title OR NEW.body IS NOT OLD.body OR NEW.memory_type IS NOT OLD.memory_type
  OR NEW.tags_json IS NOT OLD.tags_json OR NEW.project IS NOT OLD.project OR NEW.deleted_at IS NOT OLD.deleted_at BEGIN
  INSERT INTO memory_review_pending(memory_id, user_id, enqueued_at)
    VALUES (NEW.memory_id, NEW.user_id, unixepoch())
    ON CONFLICT(memory_id) DO UPDATE SET user_id = excluded.user_id, enqueued_at = excluded.enqueued_at;
  INSERT INTO memory_review_pending(memory_id, user_id, enqueued_at)
    SELECT memory_id, user_id, unixepoch() FROM memories WHERE deleted_at IS NULL AND memory_id IN (
      SELECT CASE WHEN from_memory_id = NEW.memory_id THEN to_memory_id ELSE from_memory_id END
      FROM memory_links WHERE (from_memory_id = NEW.memory_id OR to_memory_id = NEW.memory_id) AND removed_at IS NULL)
    ON CONFLICT(memory_id) DO UPDATE SET user_id = excluded.user_id, enqueued_at = excluded.enqueued_at;
END;
--> statement-breakpoint
CREATE TRIGGER memory_review_link_insert AFTER INSERT ON memory_links BEGIN
  INSERT INTO memory_review_pending(memory_id, user_id, enqueued_at)
    SELECT memory_id, user_id, unixepoch() FROM memories
    WHERE memory_id IN (NEW.from_memory_id, NEW.to_memory_id) AND deleted_at IS NULL
    ON CONFLICT(memory_id) DO UPDATE SET user_id = excluded.user_id, enqueued_at = excluded.enqueued_at;
END;
--> statement-breakpoint
CREATE TRIGGER memory_review_link_change AFTER UPDATE OF confirmed_at, removed_at ON memory_links
WHEN NEW.confirmed_at IS NOT OLD.confirmed_at OR NEW.removed_at IS NOT OLD.removed_at BEGIN
  INSERT INTO memory_review_pending(memory_id, user_id, enqueued_at)
    SELECT memory_id, user_id, unixepoch() FROM memories
    WHERE memory_id IN (NEW.from_memory_id, NEW.to_memory_id) AND deleted_at IS NULL
    ON CONFLICT(memory_id) DO UPDATE SET user_id = excluded.user_id, enqueued_at = excluded.enqueued_at;
END;
