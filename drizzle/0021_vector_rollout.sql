CREATE TABLE `vector_backfills` (
	`namespace` text PRIMARY KEY NOT NULL,
	`cursor` text DEFAULT '' NOT NULL,
	`done` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE `vector_pending` ADD `queued_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `vector_pending` ADD `completed_at` integer DEFAULT 0 NOT NULL;