-- valise:by-hand replaces global skill-name uniqueness with tenant-local uniqueness; owner authorized 2026-10-23 after verification (ADR-0016).
CREATE UNIQUE INDEX `skills_user_name_unique` ON `skills` (`user_id`,`name`);--> statement-breakpoint
DROP INDEX `skills_name_unique`;--> statement-breakpoint
DROP INDEX `skills_user_name`;
