ALTER TABLE `mcp_calls` ADD `target_id` text;--> statement-breakpoint
CREATE INDEX `mcp_calls_target_at` ON `mcp_calls` (`target_id`,`at`);