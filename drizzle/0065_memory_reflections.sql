CREATE TABLE `memory_principles` (
	`principle_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`reflection_id` text NOT NULL,
	`state` text NOT NULL,
	`rule` text NOT NULL,
	`applies_when` text NOT NULL,
	`mechanism` text NOT NULL,
	`exceptions` text NOT NULL,
	`change_kind` text NOT NULL,
	`change_text` text NOT NULL,
	`evidence_json` text NOT NULL,
	`counter_json` text NOT NULL,
	`reason` text,
	`result_memory_id` text,
	`result_todo_id` text,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `memory_principles_user` ON `memory_principles` (`user_id`,`state`,`created_at`);--> statement-breakpoint
CREATE TABLE `memory_reflections` (
	`reflection_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`requested_by` text NOT NULL,
	`since` integer NOT NULL,
	`state_json` text,
	`calls` integer DEFAULT 0 NOT NULL,
	`proposed` integer DEFAULT 0 NOT NULL,
	`ended` text,
	`created_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `memory_reflections_user` ON `memory_reflections` (`user_id`,`created_at`);