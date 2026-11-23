CREATE TABLE `asset_folder_files` (
	`asset_id` text PRIMARY KEY NOT NULL,
	`folder_id` text NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`asset_id`) REFERENCES `assets`(`asset_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`folder_id`) REFERENCES `asset_folders`(`folder_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `asset_folder_files_folder` ON `asset_folder_files` (`user_id`,`folder_id`);--> statement-breakpoint
CREATE TABLE `asset_folders` (
	`folder_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`title` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX asset_folders_user_created ON asset_folders(user_id, created_at, folder_id);
--> statement-breakpoint
-- Hand-written tail: backfill and folder lifecycle/ownership guards.
-- Do not regenerate this migration after release; use a new migration.
-- Existing assets acquire containers without rewriting any original row.
INSERT INTO asset_folders (folder_id, user_id, created_at)
SELECT asset_id, user_id, created_at FROM assets;
--> statement-breakpoint
INSERT INTO asset_folder_files (asset_id, folder_id, user_id)
SELECT asset_id, asset_id, user_id FROM assets;
--> statement-breakpoint
-- Every writer, including a pre-deploy Worker and portable import, gets a folder.
CREATE TRIGGER assets_create_folder AFTER INSERT ON assets BEGIN
  INSERT OR IGNORE INTO asset_folders(folder_id, user_id, created_at) VALUES (NEW.asset_id, NEW.user_id, NEW.created_at);
  INSERT INTO asset_folder_files(asset_id, folder_id, user_id) VALUES (NEW.asset_id, NEW.asset_id, NEW.user_id);
END;
--> statement-breakpoint
CREATE TRIGGER asset_folder_owner_insert BEFORE INSERT ON asset_folder_files BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM asset_folder_files WHERE folder_id = NEW.folder_id) >= 100
    THEN RAISE(ABORT, 'folder file limit') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM assets a JOIN asset_folders f ON f.folder_id = NEW.folder_id
    WHERE a.asset_id = NEW.asset_id AND a.user_id = NEW.user_id AND f.user_id = NEW.user_id)
    THEN RAISE(ABORT, 'folder owner mismatch') END;
END;
--> statement-breakpoint
CREATE TRIGGER asset_folder_owner_update BEFORE UPDATE ON asset_folder_files BEGIN
  SELECT CASE WHEN NEW.folder_id <> OLD.folder_id AND (SELECT COUNT(*) FROM asset_folder_files WHERE folder_id = NEW.folder_id) >= 100
    THEN RAISE(ABORT, 'folder file limit') END;
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM assets a JOIN asset_folders f ON f.folder_id = NEW.folder_id
    WHERE a.asset_id = NEW.asset_id AND a.user_id = NEW.user_id AND f.user_id = NEW.user_id)
    THEN RAISE(ABORT, 'folder owner mismatch') END;
END;
--> statement-breakpoint
CREATE TRIGGER assets_remove_empty_folder AFTER DELETE ON assets BEGIN
  DELETE FROM asset_folders WHERE user_id = OLD.user_id
    AND NOT EXISTS (SELECT 1 FROM asset_folder_files m WHERE m.folder_id = asset_folders.folder_id);
END;
--> statement-breakpoint
CREATE TRIGGER asset_folder_remove_empty AFTER UPDATE OF folder_id ON asset_folder_files BEGIN
  DELETE FROM asset_folders WHERE folder_id = OLD.folder_id
    AND NOT EXISTS (SELECT 1 FROM asset_folder_files m WHERE m.folder_id = OLD.folder_id);
END;
