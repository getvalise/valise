CREATE TABLE `hook_runnable_decisions` (
	`decision_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`version_hash` text NOT NULL,
	`decision` text NOT NULL,
	`credential_id` text,
	`at` integer NOT NULL,
	`reason` text,
	CONSTRAINT "hook_runnable_decisions_decision" CHECK("hook_runnable_decisions"."decision" IN ('approved', 'rejected', 'revoked', 'suspended'))
);
--> statement-breakpoint
CREATE INDEX `hook_runnable_decisions_version` ON `hook_runnable_decisions` (`user_id`,`version_hash`);--> statement-breakpoint
CREATE TABLE `hook_runnable_versions` (
	`user_id` text NOT NULL,
	`version_hash` text NOT NULL,
	`runnable_id` text NOT NULL,
	`event` text NOT NULL,
	`argv_json` text NOT NULL,
	`gates_json` text NOT NULL,
	`outputs_json` text NOT NULL,
	`timeout_seconds` integer NOT NULL,
	`daily_cap_microusd` integer NOT NULL,
	`max_runs_per_day` integer NOT NULL,
	`files_json` text NOT NULL,
	`source_agent` text NOT NULL,
	`source_client` text NOT NULL,
	`source_session` text,
	`proposed_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `version_hash`),
	FOREIGN KEY (`runnable_id`) REFERENCES `hook_runnables`(`runnable_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "hook_runnable_versions_event" CHECK("hook_runnable_versions"."event" IN ('SessionStart', 'Stop', 'SessionEnd'))
);
--> statement-breakpoint
CREATE INDEX `hook_runnable_versions_runnable` ON `hook_runnable_versions` (`runnable_id`,`proposed_at`);--> statement-breakpoint
CREATE TABLE `hook_runnables` (
	`runnable_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`disabled_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hook_runnables_name` ON `hook_runnables` (`user_id`,`name`);--> statement-breakpoint
ALTER TABLE `assets` ADD `purpose` text;