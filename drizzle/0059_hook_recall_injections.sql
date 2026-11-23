CREATE TABLE `hook_recall_injections` (
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `session_id`, `fingerprint`)
);
--> statement-breakpoint
CREATE INDEX `hook_recall_injections_age` ON `hook_recall_injections` (`user_id`,`created_at`);