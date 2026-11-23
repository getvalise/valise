ALTER TABLE mcp_calls ADD COLUMN search_result_ids_json text;
--> statement-breakpoint
ALTER TABLE memory_revisions ADD COLUMN project text;
--> statement-breakpoint
ALTER TABLE memory_revisions ADD COLUMN source_client text;
--> statement-breakpoint
ALTER TABLE memory_revisions ADD COLUMN source_session text;
--> statement-breakpoint
CREATE TABLE memory_links (
  link_id text PRIMARY KEY NOT NULL,
  from_memory_id text NOT NULL REFERENCES memories(memory_id),
  to_memory_id text NOT NULL REFERENCES memories(memory_id),
  kind text NOT NULL CHECK (kind IN ('part-of', 'supersedes', 'contradicts', 'related')),
  asserted_by text NOT NULL CHECK (asserted_by IN ('model', 'person')),
  source_agent text NOT NULL,
  source_client text NOT NULL,
  source_session text,
  created_at integer NOT NULL,
  confirmed_at integer,
  confirmed_by text,
  removed_at integer,
  removed_by text,
  CHECK (from_memory_id <> to_memory_id),
  CHECK (kind NOT IN ('related', 'contradicts') OR from_memory_id < to_memory_id),
  CHECK ((confirmed_at IS NULL) = (confirmed_by IS NULL)),
  CHECK ((removed_at IS NULL) = (removed_by IS NULL))
);
--> statement-breakpoint
CREATE INDEX memory_links_to ON memory_links(to_memory_id);
--> statement-breakpoint
CREATE UNIQUE INDEX memory_links_pair_kind ON memory_links(from_memory_id, to_memory_id, kind);
