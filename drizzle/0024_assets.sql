CREATE TABLE `assets` (
	`asset_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`object_id` text,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`file_name` text NOT NULL,
	`content_type` text NOT NULL,
	`declared_size` integer NOT NULL,
	`declared_sha256` text,
	`project` text,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`source_agent` text NOT NULL,
	`source_client` text NOT NULL,
	`source_session` text,
	`upload_token_digest` text,
	`upload_expires_at` integer,
	`expires_at` integer,
	`archived_at` integer,
	`failure` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finalized_at` integer,
	FOREIGN KEY (`object_id`) REFERENCES `objects`(`object_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "assets_state_check" CHECK("assets"."state" IN ('pending','ready','failed')),
	CONSTRAINT "assets_ready_object" CHECK(("assets"."state" = 'ready') = ("assets"."object_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `assets_user` ON `assets` (`user_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `assets_object` ON `assets` (`object_id`);--> statement-breakpoint
CREATE INDEX `assets_pending` ON `assets` (`state`,`upload_expires_at`);--> statement-breakpoint
CREATE INDEX `assets_expiry` ON `assets` (`expires_at`);