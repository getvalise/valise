CREATE TABLE `objects` (
	`object_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`name` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `objects_user` ON `objects` (`user_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `objects_r2_key` ON `objects` (`r2_key`);--> statement-breakpoint
CREATE TABLE `todo_attachments` (
	`todo_id` text NOT NULL,
	`object_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`todo_id`, `object_id`),
	FOREIGN KEY (`todo_id`) REFERENCES `todos`(`todo_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`object_id`) REFERENCES `objects`(`object_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `todo_attachments_todo` ON `todo_attachments` (`todo_id`,`created_at`);