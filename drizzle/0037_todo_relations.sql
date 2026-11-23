CREATE TABLE `todo_relations` (
	`user_id` text NOT NULL,
	`from_todo_id` text NOT NULL,
	`to_todo_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`from_todo_id`, `to_todo_id`, `kind`),
	FOREIGN KEY (`from_todo_id`) REFERENCES `todos`(`todo_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_todo_id`) REFERENCES `todos`(`todo_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "todo_relations_kind" CHECK("todo_relations"."kind" IN ('parent', 'depends-on')),
	CONSTRAINT "todo_relations_distinct" CHECK("todo_relations"."from_todo_id" <> "todo_relations"."to_todo_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `todo_relations_one_parent` ON `todo_relations` (`from_todo_id`) WHERE "todo_relations"."kind" = 'parent';--> statement-breakpoint
CREATE INDEX `todo_relations_inverse` ON `todo_relations` (`user_id`,`to_todo_id`,`kind`);
--> statement-breakpoint
CREATE TABLE `todo_relation_fences` (
  `user_id` text PRIMARY KEY NOT NULL,
  `token` text NOT NULL
);
