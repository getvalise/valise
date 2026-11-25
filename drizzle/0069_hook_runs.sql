CREATE TABLE `hook_runs` (
	`user_id` text NOT NULL,
	`run_id` text NOT NULL,
	`runnable_id` text NOT NULL,
	`version_hash` text NOT NULL,
	`machine` text NOT NULL,
	`session` text,
	`repo` text,
	`started_at` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`outcome` text NOT NULL,
	`cost_microusd` integer,
	`result` text,
	`received_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `run_id`),
	FOREIGN KEY (`runnable_id`) REFERENCES `hook_runnables`(`runnable_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "hook_runs_outcome" CHECK("hook_runs"."outcome" IN ('ok', 'failed', 'timeout', 'violation'))
);
--> statement-breakpoint
CREATE INDEX `hook_runs_runnable` ON `hook_runs` (`user_id`,`runnable_id`,`started_at`);