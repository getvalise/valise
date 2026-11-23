CREATE TABLE `memory_attachments` (
	`memory_id` text NOT NULL,
	`object_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`memory_id`, `object_id`),
	FOREIGN KEY (`memory_id`) REFERENCES `memories`(`memory_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`object_id`) REFERENCES `objects`(`object_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `memory_attachments_memory` ON `memory_attachments` (`memory_id`,`created_at`);