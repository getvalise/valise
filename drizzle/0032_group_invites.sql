ALTER TABLE `invites` ADD `reusable` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `users_invite` ON `users` (`invite_id`);