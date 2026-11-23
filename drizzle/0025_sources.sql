CREATE TABLE `source_revision_assets` (
	`source_id` text NOT NULL,
	`revision` integer NOT NULL,
	`asset_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`source_id`, `revision`, `asset_id`),
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`source_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`asset_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `source_revision_assets_asset` ON `source_revision_assets` (`asset_id`);--> statement-breakpoint
CREATE TABLE `source_revisions` (
	`revision_id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`revision` integer NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`url` text,
	`notes` text DEFAULT '' NOT NULL,
	`project` text,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`source_agent` text NOT NULL,
	`source_client` text NOT NULL,
	`source_session` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`source_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_revisions_source_revision` ON `source_revisions` (`source_id`,`revision`);--> statement-breakpoint
CREATE TABLE `sources` (
	`source_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`url` text,
	`notes` text DEFAULT '' NOT NULL,
	`project` text,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`revision` integer NOT NULL,
	`source_agent` text NOT NULL,
	`source_client` text NOT NULL,
	`source_session` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`archived_at` integer
);
--> statement-breakpoint
CREATE INDEX `sources_user` ON `sources` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `sources_project` ON `sources` (`project`);