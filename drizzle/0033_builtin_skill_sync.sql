CREATE TABLE `builtin_skill_sweep` (
	`id` integer PRIMARY KEY NOT NULL,
	`after_user_id` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `builtin_skill_sync` (
	`user_id` text PRIMARY KEY NOT NULL,
	`completed_version` text,
	`target_version` text NOT NULL,
	`lease_token` text,
	`lease_expires_at` integer DEFAULT 0 NOT NULL,
	`retry_after` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`user_id`) ON UPDATE no action ON DELETE cascade
);
