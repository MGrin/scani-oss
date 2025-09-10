ALTER TABLE `users` ADD `theme` text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `accent_color` text DEFAULT '#2563eb' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `compact_mode` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `show_animations` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `auto_logout_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `auto_logout_minutes` integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `share_analytics` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `share_usage_data` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `email_notifications` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `push_notifications` integer DEFAULT true NOT NULL;