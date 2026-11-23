CREATE TABLE `source_enrichments` (
	`enrichment_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`source_id` text NOT NULL,
	`revision` integer NOT NULL,
	`article_revision` integer,
	`state` text NOT NULL,
	`fetch_status` text,
	`summary` text,
	`concepts_json` text DEFAULT '[]' NOT NULL,
	`passages_json` text,
	`model` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_microusd` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`source_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "source_enrichments_state" CHECK("source_enrichments"."state" IN ('ready', 'failed', 'skipped'))
);
--> statement-breakpoint
CREATE INDEX `source_enrichments_source` ON `source_enrichments` (`source_id`,`revision`);--> statement-breakpoint
CREATE INDEX `source_enrichments_user_time` ON `source_enrichments` (`user_id`,`created_at`);