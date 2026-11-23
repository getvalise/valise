CREATE TABLE `auth_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`user_id` text,
	`subject` text,
	`detail` text,
	`ip` text,
	`user_agent` text,
	CONSTRAINT "auth_events_kind_check" CHECK("auth_events"."kind" IN ('console_login','console_login_failed','console_logout','oauth_grant','oauth_denied'))
);
--> statement-breakpoint
CREATE INDEX `auth_events_at` ON `auth_events` (`at`);--> statement-breakpoint
CREATE INDEX `auth_events_kind_at` ON `auth_events` (`kind`,`at`);--> statement-breakpoint
CREATE TABLE `mcp_calls` (
	`call_id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`transport` text NOT NULL,
	`user_id` text,
	`principal` text,
	`agent` text,
	`client` text,
	`session` text,
	`method` text NOT NULL,
	`tool` text,
	`required_scope` text,
	`args_json` text,
	`args_bytes` integer,
	`outcome` text NOT NULL,
	`error_code` text,
	`status` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`result_bytes` integer,
	CONSTRAINT "mcp_calls_transport_check" CHECK("mcp_calls"."transport" IN ('oauth','bearer','loopback')),
	CONSTRAINT "mcp_calls_outcome_check" CHECK("mcp_calls"."outcome" IN ('ok','tool_error','invalid_input','insufficient_scope','rate_limited','unauthorized','protocol_error'))
);
--> statement-breakpoint
CREATE INDEX `mcp_calls_at` ON `mcp_calls` (`at`);--> statement-breakpoint
CREATE INDEX `mcp_calls_tool_at` ON `mcp_calls` (`tool`,`at`);--> statement-breakpoint
CREATE INDEX `mcp_calls_outcome_at` ON `mcp_calls` (`outcome`,`at`);