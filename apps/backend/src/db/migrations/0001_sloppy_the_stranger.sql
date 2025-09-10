PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_institutions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`type_id` text NOT NULL,
	`description` text,
	`website` text,
	`logo_url` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`type_id`) REFERENCES `institution_types`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_institutions`("id", "user_id", "name", "type_id", "description", "website", "logo_url", "is_active", "created_at", "updated_at") SELECT "id", "user_id", "name", "type_id", "description", "website", "logo_url", "is_active", "created_at", "updated_at" FROM `institutions`;--> statement-breakpoint
DROP TABLE `institutions`;--> statement-breakpoint
ALTER TABLE `__new_institutions` RENAME TO `institutions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `institutions_user_id_name_unique` ON `institutions` (`user_id`,`name`);