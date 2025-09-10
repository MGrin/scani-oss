PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`institution_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`description` text,
	`account_number` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_accounts`("id", "institution_id", "name", "type", "description", "account_number", "is_active", "created_at", "updated_at") SELECT "id", "institution_id", "name", "type", "description", "account_number", "is_active", "created_at", "updated_at" FROM `accounts`;--> statement-breakpoint
DROP TABLE `accounts`;--> statement-breakpoint
ALTER TABLE `__new_accounts` RENAME TO `accounts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_institution_id_name_unique` ON `accounts` (`institution_id`,`name`);--> statement-breakpoint
CREATE TABLE `__new_holdings` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`token_id` text NOT NULL,
	`balance` real NOT NULL,
	`average_cost_basis` real,
	`last_updated` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`token_id`) REFERENCES `tokens`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_holdings`("id", "account_id", "token_id", "balance", "average_cost_basis", "last_updated", "created_at") SELECT "id", "account_id", "token_id", "balance", "average_cost_basis", "last_updated", "created_at" FROM `holdings`;--> statement-breakpoint
DROP TABLE `holdings`;--> statement-breakpoint
ALTER TABLE `__new_holdings` RENAME TO `holdings`;--> statement-breakpoint
CREATE UNIQUE INDEX `holdings_account_id_token_id_unique` ON `holdings` (`account_id`,`token_id`);--> statement-breakpoint
CREATE TABLE `__new_institutions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`description` text,
	`website` text,
	`logo_url` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_institutions`("id", "user_id", "name", "type", "description", "website", "logo_url", "is_active", "created_at", "updated_at") SELECT "id", "user_id", "name", "type", "description", "website", "logo_url", "is_active", "created_at", "updated_at" FROM `institutions`;--> statement-breakpoint
DROP TABLE `institutions`;--> statement-breakpoint
ALTER TABLE `__new_institutions` RENAME TO `institutions`;--> statement-breakpoint
CREATE UNIQUE INDEX `institutions_user_id_name_unique` ON `institutions` (`user_id`,`name`);--> statement-breakpoint
CREATE TABLE `__new_token_prices` (
	`id` text PRIMARY KEY NOT NULL,
	`token_id` text NOT NULL,
	`base_token_id` text NOT NULL,
	`price` real NOT NULL,
	`timestamp` integer NOT NULL,
	`source` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`token_id`) REFERENCES `tokens`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`base_token_id`) REFERENCES `tokens`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_token_prices`("id", "token_id", "base_token_id", "price", "timestamp", "source", "created_at") SELECT "id", "token_id", "base_token_id", "price", "timestamp", "source", "created_at" FROM `token_prices`;--> statement-breakpoint
DROP TABLE `token_prices`;--> statement-breakpoint
ALTER TABLE `__new_token_prices` RENAME TO `token_prices`;--> statement-breakpoint
CREATE UNIQUE INDEX `token_prices_token_id_base_token_id_timestamp_unique` ON `token_prices` (`token_id`,`base_token_id`,`timestamp`);--> statement-breakpoint
CREATE TABLE `__new_transactions` (
	`id` text PRIMARY KEY NOT NULL,
	`holding_id` text NOT NULL,
	`type` text NOT NULL,
	`amount` real NOT NULL,
	`price` real,
	`price_token_id` text,
	`fee` real DEFAULT 0 NOT NULL,
	`fee_token_id` text,
	`description` text,
	`reference` text,
	`timestamp` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`holding_id`) REFERENCES `holdings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`price_token_id`) REFERENCES `tokens`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`fee_token_id`) REFERENCES `tokens`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_transactions`("id", "holding_id", "type", "amount", "price", "price_token_id", "fee", "fee_token_id", "description", "reference", "timestamp", "created_at", "updated_at") SELECT "id", "holding_id", "type", "amount", "price", "price_token_id", "fee", "fee_token_id", "description", "reference", "timestamp", "created_at", "updated_at" FROM `transactions`;--> statement-breakpoint
DROP TABLE `transactions`;--> statement-breakpoint
ALTER TABLE `__new_transactions` RENAME TO `transactions`;--> statement-breakpoint
ALTER TABLE `users` ADD `base_currency` text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `locale` text DEFAULT 'en-US' NOT NULL;