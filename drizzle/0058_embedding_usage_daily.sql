CREATE TABLE `embedding_usage_daily` (
	`user_id` text NOT NULL,
	`day` text NOT NULL,
	`kind` text NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`input_bytes` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `day`, `kind`),
	CONSTRAINT "embedding_usage_daily_kind_check" CHECK("embedding_usage_daily"."kind" IN ('memory','asset','source','query'))
);
--> statement-breakpoint
CREATE INDEX `embedding_usage_daily_day` ON `embedding_usage_daily` (`day`);