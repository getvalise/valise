CREATE TABLE `memory_review_cost_caps` (
	`user_id` text PRIMARY KEY NOT NULL,
	`review_microusd` integer NOT NULL,
	`ranking_microusd` integer NOT NULL,
	`set_by` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `memory_review_budgets` ADD `manual_calls` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `memory_review_budgets` ADD `upkeep_calls` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `memory_review_ranking_budgets` ADD `manual_requests` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `memory_review_ranking_budgets` ADD `upkeep_requests` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `memory_review_settings` ADD `manual_memories` integer DEFAULT 25 NOT NULL;--> statement-breakpoint
ALTER TABLE `memory_review_settings` ADD `upkeep_memories` integer DEFAULT 50 NOT NULL;