CREATE TABLE `memory_review_ranking` (
	`user_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`destination` text NOT NULL,
	`daily_requests` integer DEFAULT 4 NOT NULL,
	`daily_microusd` integer DEFAULT 10000 NOT NULL,
	`manual_model` text,
	CONSTRAINT "review_ranking_enabled" CHECK("memory_review_ranking"."enabled" IN (0,1)),
	CONSTRAINT "review_ranking_requests" CHECK("memory_review_ranking"."daily_requests" BETWEEN 1 AND 16),
	CONSTRAINT "review_ranking_cost" CHECK("memory_review_ranking"."daily_microusd" BETWEEN 1000 AND 100000)
);
--> statement-breakpoint
CREATE TABLE `memory_review_ranking_budgets` (
	`user_id` text NOT NULL,
	`day` integer NOT NULL,
	`requests` integer NOT NULL,
	`reserved_microusd` integer NOT NULL,
	`last_error` text,
	PRIMARY KEY(`user_id`, `day`)
);
--> statement-breakpoint
CREATE TABLE `memory_review_sources` (
	`group_id` text NOT NULL,
	`user_id` text NOT NULL,
	`memory_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`group_id`, `memory_id`),
	FOREIGN KEY (`group_id`) REFERENCES `memory_review_groups`(`group_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memory_review_source_history` ON `memory_review_sources` (`user_id`,`memory_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `memory_review_source_coverage` ON `memory_review_sources` (`user_id`,`memory_id`,`fingerprint`);
--> statement-breakpoint
-- Source history is a disposable index of retained snapshots. No memory is rewritten.
CREATE TRIGGER memory_review_source_insert AFTER INSERT ON memory_review_groups BEGIN
  INSERT OR IGNORE INTO memory_review_sources(group_id,user_id,memory_id,fingerprint,revision,created_at)
  SELECT NEW.group_id,NEW.user_id,json_extract(value,'$.source.id'),
    COALESCE(json_extract(value,'$.fingerprint'),''),COALESCE(json_extract(value,'$.source.revision'),1),NEW.created_at
  FROM json_each(CASE WHEN json_valid(NEW.sources_json) THEN NEW.sources_json ELSE '[]' END)
  WHERE json_extract(value,'$.source.id') IS NOT NULL;
END;
--> statement-breakpoint
INSERT INTO memory_review_sources(group_id,user_id,memory_id,fingerprint,revision,created_at)
SELECT g.group_id,g.user_id,json_extract(j.value,'$.source.id'),
  COALESCE(json_extract(j.value,'$.fingerprint'),''),COALESCE(json_extract(j.value,'$.source.revision'),1),g.created_at
FROM memory_review_groups g,json_each(CASE WHEN json_valid(g.sources_json) THEN g.sources_json ELSE '[]' END) j
WHERE json_extract(j.value,'$.source.id') IS NOT NULL
ON CONFLICT(group_id,memory_id) DO NOTHING;
--> statement-breakpoint
CREATE TRIGGER memory_review_ranking_destination AFTER UPDATE OF model ON memory_review_settings
WHEN OLD.model <> NEW.model BEGIN
  UPDATE memory_review_ranking SET enabled=0,revision=revision+1,manual_model=NULL WHERE user_id=NEW.user_id;
END;
