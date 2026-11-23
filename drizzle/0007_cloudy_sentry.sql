-- valise:by-hand renames todos.created_by, so no ordering of schema and code is
-- correct on its own. Applied against production by hand at 15:24 UTC on
-- 2026-10-17, three hours after V1-20 merged and broke create_todo. ADR-0008.
ALTER TABLE `todos` RENAME COLUMN `created_by` TO `source_agent`;--> statement-breakpoint
ALTER TABLE `todos` ADD `refs_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `todos` ADD `source_client` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `todos` ADD `source_session` text;