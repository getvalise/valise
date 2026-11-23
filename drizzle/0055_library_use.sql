CREATE TABLE `library_ratings` (
	`user_id` text NOT NULL,
	`concept` text NOT NULL,
	`concept_id` text NOT NULL,
	`stars` integer NOT NULL,
	`rated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `concept`, `concept_id`),
	CONSTRAINT "library_rating_stars" CHECK("library_ratings"."stars" BETWEEN 1 AND 3)
);
--> statement-breakpoint
CREATE TABLE `library_use_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`concept` text NOT NULL,
	`concept_id` text NOT NULL,
	`kind` text NOT NULL,
	`at` integer NOT NULL,
	CONSTRAINT "library_use_kind" CHECK("library_use_events"."kind" IN ('opened', 'fetched'))
);
--> statement-breakpoint
CREATE INDEX `library_use_item` ON `library_use_events` (`user_id`,`concept`,`concept_id`,`at`);