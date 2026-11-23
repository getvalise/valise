CREATE TABLE `source_vector_pending` (
	`namespace` text NOT NULL,
	`user_id` text NOT NULL,
	`enrichment_id` text NOT NULL,
	`source_id` text NOT NULL,
	`chunk` integer NOT NULL,
	`stamp` text NOT NULL,
	`epoch` integer DEFAULT 1 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT 0 NOT NULL,
	`lease_token` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`mutation_id` text,
	`error_code` text,
	PRIMARY KEY(`namespace`, `enrichment_id`, `chunk`)
);
--> statement-breakpoint
CREATE INDEX `source_vector_due` ON `source_vector_pending` (`namespace`,`user_id`,`next_attempt_at`,`lease_until`);--> statement-breakpoint
CREATE INDEX `source_vector_source` ON `source_vector_pending` (`user_id`,`source_id`);