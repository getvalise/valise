CREATE TABLE `spend_daily` (
	`user_id` text NOT NULL,
	`day` text NOT NULL,
	`category` text NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	`unpriced_calls` integer DEFAULT 0 NOT NULL,
	`units` integer DEFAULT 0 NOT NULL,
	`microusd` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `day`, `category`)
);
--> statement-breakpoint
CREATE INDEX `spend_daily_day` ON `spend_daily` (`day`);--> statement-breakpoint
-- One-time backfill from the ledgers that existed before spend_daily
-- (docs/design/spend.md). Each statement fills its own category, so no two
-- collide. Prices match app/concepts/spend.ts.
INSERT INTO spend_daily (user_id, day, category, calls, unpriced_calls, units, microusd)
  SELECT user_id, date(created_at, 'unixepoch'), 'bookmark_summary', COUNT(*), 0,
    SUM(input_tokens + output_tokens), SUM(cost_microusd)
  FROM source_enrichments WHERE model IS NOT NULL
  GROUP BY user_id, date(created_at, 'unixepoch');
--> statement-breakpoint
-- File summaries recorded no usage before spend_daily, so the old ones are unpriced.
INSERT INTO spend_daily (user_id, day, category, calls, unpriced_calls, units, microusd)
  SELECT user_id, date(created_at, 'unixepoch'), 'file_summary', COUNT(*), COUNT(*), 0, 0
  FROM asset_processing_outputs WHERE suggestion_model IS NOT NULL
  GROUP BY user_id, date(created_at, 'unixepoch');
--> statement-breakpoint
INSERT INTO spend_daily (user_id, day, category, calls, unpriced_calls, units, microusd)
  SELECT user_id, date(created_at, 'unixepoch'), 'file_conversion', COUNT(*),
    SUM(extractor = 'workers-ai-toMarkdown-image-description'), COUNT(*), 0
  FROM asset_processing_outputs WHERE extractor LIKE 'workers-ai-toMarkdown%'
  GROUP BY user_id, date(created_at, 'unixepoch');
--> statement-breakpoint
INSERT INTO spend_daily (user_id, day, category, calls, unpriced_calls, units, microusd)
  SELECT user_id, date(day * 86400, 'unixepoch'), 'memory_review', calls, 0, calls, reserved_microusd
  FROM memory_review_budgets WHERE calls > 0;
--> statement-breakpoint
-- Before spend_daily the ranking reservation held its embedding stage too.
INSERT INTO spend_daily (user_id, day, category, calls, unpriced_calls, units, microusd)
  SELECT user_id, date(day * 86400, 'unixepoch'), 'review_ranking', requests, 0, 0, reserved_microusd
  FROM memory_review_ranking_budgets WHERE requests > 0;
--> statement-breakpoint
INSERT INTO spend_daily (user_id, day, category, calls, unpriced_calls, units, microusd)
  SELECT user_id, day, 'embedding', SUM(calls), 0, SUM(input_bytes),
    CAST(SUM(input_bytes) * 0.0118 + 0.999999 AS INTEGER)
  FROM embedding_usage_daily
  GROUP BY user_id, day;
--> statement-breakpoint
-- A call with no account is a refusal before sign-in: unattributed load.
INSERT INTO spend_daily (user_id, day, category, calls, unpriced_calls, units, microusd)
  SELECT COALESCE(user_id, '(unattributed)'), date(at / 1000, 'unixepoch'), 'mcp_requests', COUNT(*), 0, COUNT(*), 0
  FROM mcp_calls
  GROUP BY COALESCE(user_id, '(unattributed)'), date(at / 1000, 'unixepoch');
