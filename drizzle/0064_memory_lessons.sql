CREATE TABLE `memory_lessons` (
	`memory_id` text NOT NULL,
	`revision` integer NOT NULL,
	`user_id` text NOT NULL,
	`lesson` text NOT NULL,
	`mechanism_json` text NOT NULL,
	`forward` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`memory_id`, `revision`),
	FOREIGN KEY (`memory_id`) REFERENCES `memories`(`memory_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `memory_lessons_user` ON `memory_lessons` (`user_id`,`created_at`);