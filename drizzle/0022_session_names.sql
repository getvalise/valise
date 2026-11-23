ALTER TABLE `memories` ADD `source_session_name` text;--> statement-breakpoint
ALTER TABLE `todo_comments` ADD `source_session_name` text;--> statement-breakpoint
ALTER TABLE `todo_updates` ADD `session_name` text;--> statement-breakpoint
ALTER TABLE `todos` ADD `source_session_name` text;