CREATE TABLE `bearer_token_grants` (
	`token_id` text NOT NULL,
	`scope` text NOT NULL,
	PRIMARY KEY(`token_id`, `scope`),
	FOREIGN KEY (`token_id`) REFERENCES `bearer_tokens`(`token_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `hook_configs` (
	`user_id` text PRIMARY KEY NOT NULL,
	`document` text NOT NULL,
	`updated_at` integer NOT NULL
);
