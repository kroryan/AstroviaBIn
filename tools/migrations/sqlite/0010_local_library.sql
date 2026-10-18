CREATE TABLE `library_assets` (
	`id` integer PRIMARY KEY NOT NULL,
	`legacy_asset_id` text,
	`legacy_relative_path` text NOT NULL,
	`relative_path` text NOT NULL,
	`filename` text NOT NULL,
	`mime_type` text,
	`byte_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `library_assets_legacy_asset_id_unique` ON `library_assets` (`legacy_asset_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `library_assets_legacy_relative_path_unique` ON `library_assets` (`legacy_relative_path`);
--> statement-breakpoint
CREATE UNIQUE INDEX `library_assets_relative_path_unique` ON `library_assets` (`relative_path`);
--> statement-breakpoint
ALTER TABLE `astrophotography_images` ADD COLUMN `library_asset_id` integer REFERENCES `library_assets`(`id`) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX `astrophotography_images_library_asset_id_idx` ON `astrophotography_images` (`library_asset_id`);
