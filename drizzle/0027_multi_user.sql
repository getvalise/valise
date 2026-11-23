CREATE TABLE `invites` (
	`invite_id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`email` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`redeemed_at` integer,
	`redeemed_by` text,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invites_code_unique` ON `invites` (`code`);--> statement-breakpoint
CREATE INDEX `invites_created` ON `invites` (`created_by`,`created_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`user_id` text PRIMARY KEY NOT NULL,
	`email` text,
	`display_name` text DEFAULT '' NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`plan` text DEFAULT 'free' NOT NULL,
	`invite_id` text,
	`created_at` integer NOT NULL,
	`last_seen_at` integer,
	CONSTRAINT "users_role_check" CHECK("users"."role" IN ('owner','member'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
ALTER TABLE `memories` ADD `user_id` text DEFAULT 'local' NOT NULL;--> statement-breakpoint
CREATE INDEX `memories_user` ON `memories` (`user_id`,`updated_at`);--> statement-breakpoint
ALTER TABLE `search_docs` ADD `user_id` text DEFAULT 'local' NOT NULL;--> statement-breakpoint
CREATE INDEX `search_docs_user` ON `search_docs` (`user_id`,`concept`);--> statement-breakpoint
ALTER TABLE `skills` ADD `user_id` text DEFAULT 'local' NOT NULL;--> statement-breakpoint
CREATE INDEX `skills_user_name` ON `skills` (`user_id`,`name`);--> statement-breakpoint
ALTER TABLE `todos` ADD `user_id` text DEFAULT 'local' NOT NULL;--> statement-breakpoint
CREATE INDEX `todos_user_state` ON `todos` (`user_id`,`state`,`updated_at`);
--> statement-breakpoint
-- The owner's row. Every row the single-user era wrote defaults to `local`,
-- so the account it belongs to has to exist before the first invite. The
-- email is filled in by the owner's first Google sign-in. ADR-0016.
INSERT INTO `users` (`user_id`, `email`, `display_name`, `role`, `plan`, `invite_id`, `created_at`, `last_seen_at`)
  SELECT 'local', NULL, 'Owner', 'owner', 'free', NULL, unixepoch(), NULL
  WHERE NOT EXISTS (SELECT 1 FROM `users` WHERE `user_id` = 'local');
