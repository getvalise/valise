CREATE TABLE `memory_subject_members` (
	`subject_id` text NOT NULL,
	`memory_id` text NOT NULL,
	`asserted_by` text NOT NULL,
	`confirmed_at` integer,
	`confirmed_by` text,
	`created_at` integer NOT NULL,
	`removed_at` integer,
	`removed_by` text,
	PRIMARY KEY(`subject_id`, `memory_id`),
	FOREIGN KEY (`subject_id`) REFERENCES `memory_subjects`(`subject_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`memory_id`) REFERENCES `memories`(`memory_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "memory_subject_members_assertion" CHECK("memory_subject_members"."asserted_by" IN ('person', 'model')),
	CONSTRAINT "memory_subject_members_confirmation" CHECK(("memory_subject_members"."confirmed_at" IS NULL) = ("memory_subject_members"."confirmed_by" IS NULL)),
	CONSTRAINT "memory_subject_members_removal" CHECK(("memory_subject_members"."removed_at" IS NULL) = ("memory_subject_members"."removed_by" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `memory_subject_members_memory` ON `memory_subject_members` (`memory_id`);--> statement-breakpoint
CREATE TABLE `memory_subjects` (
	`subject_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`summary_memory_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`summary_memory_id`) REFERENCES `memories`(`memory_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "memory_subjects_kind" CHECK("memory_subjects"."kind" IN ('profile', 'topic', 'area', 'person'))
);
--> statement-breakpoint
CREATE INDEX `memory_subjects_user_name` ON `memory_subjects` (`user_id`,`name`,`subject_id`);