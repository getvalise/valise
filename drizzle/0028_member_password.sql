ALTER TABLE `users` ADD `password_hash` text;--> statement-breakpoint
ALTER TABLE `users` ADD `email_verified` integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `users` ADD `verification_token` text;