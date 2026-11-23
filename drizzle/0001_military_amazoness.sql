CREATE TABLE `bearer_token_scopes` (
	`token_id` text NOT NULL,
	`scope` text NOT NULL,
	PRIMARY KEY(`token_id`, `scope`),
	FOREIGN KEY (`token_id`) REFERENCES `bearer_tokens`(`token_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "bearer_token_scopes_scope_check" CHECK("bearer_token_scopes"."scope" IN ('search:read','todos:read','todos:write','memories:read','memories:write','skills:read','skills:write'))
);
--> statement-breakpoint
CREATE TABLE `bearer_tokens` (
	`token_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`label` text NOT NULL,
	`token_digest` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bearer_tokens_token_digest_unique` ON `bearer_tokens` (`token_digest`);--> statement-breakpoint
CREATE INDEX `bearer_tokens_user_id` ON `bearer_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_user_id` ON `sessions` (`user_id`);