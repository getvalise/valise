CREATE TABLE `vector_pending` (
	`namespace` text NOT NULL,
	`memory_id` text NOT NULL,
	`generation` integer NOT NULL,
	`target` text NOT NULL,
	`epoch` integer DEFAULT 1 NOT NULL,
	`completed_epoch` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT 0 NOT NULL,
	`lease_token` text,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`mutation_id` text,
	`error_code` text,
	PRIMARY KEY(`namespace`, `memory_id`, `generation`),
	FOREIGN KEY (`memory_id`,`generation`) REFERENCES `vector_snapshots`(`memory_id`,`generation`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "vector_pending_target_check" CHECK("vector_pending"."target" IN ('head','history','delete'))
);
--> statement-breakpoint
CREATE INDEX `vector_pending_due` ON `vector_pending` (`next_attempt_at`,`lease_until`);--> statement-breakpoint
CREATE TABLE `vector_snapshots` (
	`memory_id` text NOT NULL,
	`generation` integer NOT NULL,
	`projection_json` text NOT NULL,
	PRIMARY KEY(`memory_id`, `generation`),
	FOREIGN KEY (`memory_id`) REFERENCES `memories`(`memory_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "vector_snapshots_generation_check" CHECK("vector_snapshots"."generation" > 0),
	CONSTRAINT "vector_snapshots_json_check" CHECK(json_valid("vector_snapshots"."projection_json"))
);
