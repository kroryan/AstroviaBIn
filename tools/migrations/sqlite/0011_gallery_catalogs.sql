CREATE TABLE `gallery_catalogs` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gallery_catalogs_name_unique` ON `gallery_catalogs` (`name`);
--> statement-breakpoint
CREATE TABLE `gallery_catalog_images` (
	`id` integer PRIMARY KEY NOT NULL,
	`catalog_id` integer NOT NULL REFERENCES `gallery_catalogs`(`id`) ON DELETE CASCADE,
	`image_id` integer NOT NULL REFERENCES `astrophotography_images`(`id`) ON DELETE CASCADE,
	`added_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gallery_catalog_images_pair_unique` ON `gallery_catalog_images` (`catalog_id`, `image_id`);
--> statement-breakpoint
CREATE INDEX `gallery_catalog_images_image_idx` ON `gallery_catalog_images` (`image_id`);
