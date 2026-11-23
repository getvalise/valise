CREATE TABLE `vector_drain_state` (
	`namespace` text PRIMARY KEY NOT NULL,
	`after_user_id` text DEFAULT '' NOT NULL,
	`lease_token` text,
	`lease_until` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE `vector_pending` ADD `user_id` text;--> statement-breakpoint
CREATE INDEX `vector_pending_tenant_due` ON `vector_pending` (`namespace`,`user_id`,`next_attempt_at`,`memory_id`,`generation`);