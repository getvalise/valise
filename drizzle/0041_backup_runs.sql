CREATE TABLE `backup_alerts` (
	`id` integer PRIMARY KEY NOT NULL,
	`first_checked_at` integer NOT NULL,
	`incident` text,
	`alerted_at` integer,
	CONSTRAINT "backup_alerts_single_row" CHECK("backup_alerts"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `backup_runs` (
	`snapshot` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`originals` integer,
	`database_bytes` integer,
	`error` text,
	CONSTRAINT "backup_runs_state_check" CHECK("backup_runs"."state" IN ('running','complete','failed'))
);
--> statement-breakpoint
CREATE INDEX `backup_runs_started` ON `backup_runs` (`started_at`);