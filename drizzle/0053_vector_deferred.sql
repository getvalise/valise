CREATE TABLE `vector_deferred` (
	`namespace` text NOT NULL,
	`user_id` text NOT NULL,
	`memory_id` text NOT NULL,
	`deferred_at` integer NOT NULL,
	PRIMARY KEY(`namespace`, `memory_id`)
);
--> statement-breakpoint
CREATE INDEX `vector_deferred_tenant` ON `vector_deferred` (`namespace`,`user_id`,`deferred_at`,`memory_id`);--> statement-breakpoint
CREATE INDEX `vector_pending_outstanding` ON `vector_pending` (`namespace`,`user_id`,`memory_id`) WHERE "vector_pending"."completed_epoch" < "vector_pending"."epoch" AND "vector_pending"."target" != 'delete';