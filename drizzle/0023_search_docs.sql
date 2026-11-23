CREATE TABLE `search_docs` (
	`id` integer PRIMARY KEY NOT NULL,
	`doc_key` text NOT NULL,
	`concept` text NOT NULL,
	`concept_id` text NOT NULL,
	`project` text,
	`title` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`tags` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `search_docs_doc_key` ON `search_docs` (`doc_key`);--> statement-breakpoint
CREATE INDEX `search_docs_concept` ON `search_docs` (`concept`);--> statement-breakpoint
CREATE INDEX `search_docs_project` ON `search_docs` (`project`);--> statement-breakpoint
-- Hand-written below this line. drizzle-kit generates ordinary tables only, so
-- the FTS5 table over `search_docs`, its three sync triggers, its vocabulary
-- view, the copy out of `search_index`, and the forwarding triggers are kept
-- here by hand, as 0000_init.sql's tail is for the first projection.
--
-- `search_docs` replaces `search_index`, whose concept CHECK admits only
-- skill, memory and todo. Widening a CHECK means rebuilding the table, which
-- ADR-0008 makes a by-hand migration; a second table is additive. ADR-0015,
-- amendment of 2026-10-21.
CREATE VIRTUAL TABLE `search_docs_fts` USING fts5(
	title,
	body,
	tags,
	content='search_docs',
	content_rowid='id',
	tokenize='porter unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE TRIGGER `search_docs_ai` AFTER INSERT ON `search_docs` BEGIN
	INSERT INTO search_docs_fts(rowid, title, body, tags)
	VALUES (new.id, new.title, new.body, new.tags);
END;
--> statement-breakpoint
CREATE TRIGGER `search_docs_ad` AFTER DELETE ON `search_docs` BEGIN
	INSERT INTO search_docs_fts(search_docs_fts, rowid, title, body, tags)
	VALUES ('delete', old.id, old.title, old.body, old.tags);
END;
--> statement-breakpoint
CREATE TRIGGER `search_docs_au` AFTER UPDATE ON `search_docs` BEGIN
	INSERT INTO search_docs_fts(search_docs_fts, rowid, title, body, tags)
	VALUES ('delete', old.id, old.title, old.body, old.tags);
	INSERT INTO search_docs_fts(rowid, title, body, tags)
	VALUES (new.id, new.title, new.body, new.tags);
END;
--> statement-breakpoint
CREATE VIRTUAL TABLE `search_docs_vocab` USING fts5vocab(`search_docs_fts`, 'col');
--> statement-breakpoint
-- The same rows under the same rowids, so the index the insert trigger builds
-- holds exactly what `search_index` held.
INSERT INTO `search_docs` (`id`, `doc_key`, `concept`, `concept_id`, `project`, `title`, `body`, `tags`, `updated_at`)
SELECT `id`, `doc_key`, `concept`, `concept_id`, `project`, `title`, `body`, `tags`, `updated_at`
  FROM `search_index`;
--> statement-breakpoint
-- The deploy applies this before the Worker that reads `search_docs` replaces
-- the one that writes `search_index`. These forward the writes made in that
-- gap, so the cutover loses none. Delete then insert rather than REPLACE: a
-- REPLACE's implicit delete fires no delete trigger, which would leave stale
-- terms in `search_docs_fts`. They go when `search_index` is dropped by hand.
CREATE TRIGGER `search_index_forward_ai` AFTER INSERT ON `search_index` BEGIN
	DELETE FROM search_docs WHERE doc_key = new.doc_key;
	INSERT INTO search_docs (doc_key, concept, concept_id, project, title, body, tags, updated_at)
	VALUES (new.doc_key, new.concept, new.concept_id, new.project, new.title, new.body, new.tags, new.updated_at);
END;
--> statement-breakpoint
CREATE TRIGGER `search_index_forward_au` AFTER UPDATE ON `search_index` BEGIN
	DELETE FROM search_docs WHERE doc_key IN (old.doc_key, new.doc_key);
	INSERT INTO search_docs (doc_key, concept, concept_id, project, title, body, tags, updated_at)
	VALUES (new.doc_key, new.concept, new.concept_id, new.project, new.title, new.body, new.tags, new.updated_at);
END;
--> statement-breakpoint
CREATE TRIGGER `search_index_forward_ad` AFTER DELETE ON `search_index` BEGIN
	DELETE FROM search_docs WHERE doc_key = old.doc_key;
END;
