ALTER TABLE `source_enrichments` ADD `suggested_tags_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `source_enrichments` ADD `dismissed_tags_json` text DEFAULT '[]' NOT NULL;