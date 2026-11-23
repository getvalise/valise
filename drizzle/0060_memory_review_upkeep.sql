ALTER TABLE `memory_review_groups` ADD `applied_by` text;--> statement-breakpoint
ALTER TABLE `memory_review_settings` ADD `auto_apply` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `memory_review_settings` ADD `nightly_calls` integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE `memory_review_settings` ADD `last_run_json` text;