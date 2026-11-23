ALTER TABLE `asset_folders` ADD `tags_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `asset_folders` ADD `notes` text DEFAULT '' NOT NULL;