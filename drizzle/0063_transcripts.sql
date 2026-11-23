CREATE TABLE `transcript_turns` (
	`transcript_id` text NOT NULL,
	`position` integer NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`tool_name` text,
	`at` integer,
	`hash` text NOT NULL,
	PRIMARY KEY(`transcript_id`, `position`)
);
--> statement-breakpoint
CREATE TABLE `transcripts` (
	`transcript_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`client` text NOT NULL,
	`device` text NOT NULL,
	`session_id` text NOT NULL,
	`cwd` text,
	`git_branch` text,
	`project` text,
	`model` text,
	`title` text DEFAULT '' NOT NULL,
	`turn_count` integer DEFAULT 0 NOT NULL,
	`chain_hash` text DEFAULT '' NOT NULL,
	`first_at` integer,
	`last_at` integer,
	`source_agent` text NOT NULL,
	`source_client` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transcripts_session` ON `transcripts` (`user_id`,`client`,`device`,`session_id`);--> statement-breakpoint
CREATE INDEX `transcripts_user` ON `transcripts` (`user_id`,`updated_at`);--> statement-breakpoint
CREATE INDEX `transcripts_project` ON `transcripts` (`project`);