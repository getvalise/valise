CREATE TABLE `memories` (
	`memory_id` text PRIMARY KEY NOT NULL,
	`memory_type` text NOT NULL,
	`title` text,
	`body` text NOT NULL,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`project` text,
	`source_agent` text NOT NULL,
	`source_client` text NOT NULL,
	`source_session` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `memories_type` ON `memories` (`memory_type`);--> statement-breakpoint
CREATE INDEX `memories_project` ON `memories` (`project`);--> statement-breakpoint
CREATE TABLE `memory_revisions` (
	`revision_id` text PRIMARY KEY NOT NULL,
	`memory_id` text NOT NULL,
	`revision` integer NOT NULL,
	`memory_type` text NOT NULL,
	`title` text,
	`body` text NOT NULL,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	FOREIGN KEY (`memory_id`) REFERENCES `memories`(`memory_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memory_revisions_memory_revision` ON `memory_revisions` (`memory_id`,`revision`);--> statement-breakpoint
CREATE TABLE `search_index` (
	`id` integer PRIMARY KEY NOT NULL,
	`doc_key` text NOT NULL,
	`concept` text NOT NULL,
	`concept_id` text NOT NULL,
	`project` text,
	`title` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`tags` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "search_index_concept_check" CHECK("search_index"."concept" IN ('skill','memory','todo'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `search_index_doc_key` ON `search_index` (`doc_key`);--> statement-breakpoint
CREATE INDEX `search_index_concept` ON `search_index` (`concept`);--> statement-breakpoint
CREATE INDEX `search_index_project` ON `search_index` (`project`);--> statement-breakpoint
CREATE TABLE `skill_versions` (
	`version_id` text PRIMARY KEY NOT NULL,
	`skill_id` text NOT NULL,
	`version` integer NOT NULL,
	`body_md` text NOT NULL,
	`body_sha256` text NOT NULL,
	`files_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`skill_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_versions_skill_version` ON `skill_versions` (`skill_id`,`version`);--> statement-breakpoint
CREATE TABLE `skills` (
	`skill_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`project` text,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`visibility` text DEFAULT 'private' NOT NULL,
	`head_version_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	CONSTRAINT "skills_visibility_check" CHECK("skills"."visibility" IN ('private','public'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skills_name_unique` ON `skills` (`name`);--> statement-breakpoint
CREATE INDEX `skills_project` ON `skills` (`project`);--> statement-breakpoint
CREATE TABLE `todo_updates` (
	`update_id` text PRIMARY KEY NOT NULL,
	`todo_id` text NOT NULL,
	`kind` text NOT NULL,
	`author` text NOT NULL,
	`token` integer,
	`body` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`todo_id`) REFERENCES `todos`(`todo_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "todo_updates_kind_check" CHECK("todo_updates"."kind" IN ('progress','claim','release','complete','blocked'))
);
--> statement-breakpoint
CREATE INDEX `todo_updates_todo` ON `todo_updates` (`todo_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `todos` (
	`todo_id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`project` text,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`lease_holder` text,
	`lease_expires_at` integer,
	`fencing_token` integer DEFAULT 0 NOT NULL,
	`blocked_on` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	CONSTRAINT "todos_state_check" CHECK("todos"."state" IN ('pending','claimed','done','blocked'))
);
--> statement-breakpoint
CREATE INDEX `todos_state` ON `todos` (`state`,`updated_at`);--> statement-breakpoint
CREATE INDEX `todos_project` ON `todos` (`project`);--> statement-breakpoint
-- Hand-written below this line. drizzle-kit generates ordinary tables only, so
-- the FTS5 virtual table and its three sync triggers are maintained by hand.
-- Regenerating this file means re-appending this block. Later migrations are
-- new files; 0000_init.sql is never edited again.
CREATE VIRTUAL TABLE `search_fts` USING fts5(
	title,
	body,
	tags,
	content='search_index',
	content_rowid='id',
	tokenize='porter unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE TRIGGER `search_index_ai` AFTER INSERT ON `search_index` BEGIN
	INSERT INTO search_fts(rowid, title, body, tags)
	VALUES (new.id, new.title, new.body, new.tags);
END;
--> statement-breakpoint
CREATE TRIGGER `search_index_ad` AFTER DELETE ON `search_index` BEGIN
	INSERT INTO search_fts(search_fts, rowid, title, body, tags)
	VALUES ('delete', old.id, old.title, old.body, old.tags);
END;
--> statement-breakpoint
CREATE TRIGGER `search_index_au` AFTER UPDATE ON `search_index` BEGIN
	INSERT INTO search_fts(search_fts, rowid, title, body, tags)
	VALUES ('delete', old.id, old.title, old.body, old.tags);
	INSERT INTO search_fts(rowid, title, body, tags)
	VALUES (new.id, new.title, new.body, new.tags);
END;
--> statement-breakpoint
-- A read-only view over the FTS index, one row per term and column. The weekly
-- reconciliation reads it to see what the index actually holds, and the tests
-- compare it across a rebuild, which raw shadow-table blocks cannot do because
-- an incrementally built index and a rebuilt one differ by segment layout.
CREATE VIRTUAL TABLE `search_fts_vocab` USING fts5vocab(`search_fts`, 'col');
