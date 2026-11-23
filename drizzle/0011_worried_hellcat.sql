CREATE TABLE `todo_comments` (
	`comment_id` text PRIMARY KEY NOT NULL,
	`todo_id` text NOT NULL,
	`author` text NOT NULL,
	`source_client` text NOT NULL,
	`source_session` text,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`todo_id`) REFERENCES `todos`(`todo_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `todo_comments_todo` ON `todo_comments` (`todo_id`,`created_at`);