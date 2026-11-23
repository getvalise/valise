CREATE TABLE `source_articles` (
	`source_id` text NOT NULL,
	`revision` integer NOT NULL,
	`user_id` text NOT NULL,
	`detected` integer NOT NULL,
	`markdown` text DEFAULT '' NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`truncated` integer DEFAULT false NOT NULL,
	`word_count` integer DEFAULT 0 NOT NULL,
	`page_word_count` integer DEFAULT 0 NOT NULL,
	`extractor` text NOT NULL,
	`published` text,
	`site_name` text,
	`canonical_url` text,
	`lead_image` text,
	`description` text,
	`language` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`source_id`, `revision`),
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`source_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `source_articles_user` ON `source_articles` (`user_id`);--> statement-breakpoint
ALTER TABLE `source_revisions` ADD `authors_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `authors_json` text DEFAULT '[]' NOT NULL;