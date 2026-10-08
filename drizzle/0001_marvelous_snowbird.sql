CREATE TABLE `telegram_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`code_hash` text NOT NULL,
	`label` text NOT NULL,
	`language` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` text,
	`redeemed_chat_id` text,
	`redeemed_update_id` integer,
	`redeemed_at` text,
	FOREIGN KEY (`user_id`) REFERENCES `telegram_connections`(`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `telegram_invites_code_hash_unique` ON `telegram_invites` (`code_hash`);--> statement-breakpoint
CREATE INDEX `idx_telegram_invites_user` ON `telegram_invites` (`user_id`);--> statement-breakpoint
CREATE TABLE `telegram_recipient_deliveries` (
	`user_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`lesson_key` text NOT NULL,
	`content_hash` text NOT NULL,
	`total_parts` integer NOT NULL,
	`sent_parts` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`finished_at` text,
	PRIMARY KEY(`user_id`, `chat_id`, `lesson_key`),
	FOREIGN KEY (`user_id`) REFERENCES `telegram_connections`(`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `telegram_subscriptions` (
	`id` text NOT NULL,
	`user_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`chat_name` text NOT NULL,
	`invite_id` text NOT NULL,
	`language` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `chat_id`),
	FOREIGN KEY (`user_id`) REFERENCES `telegram_connections`(`user_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `telegram_subscriptions_id_unique` ON `telegram_subscriptions` (`id`);--> statement-breakpoint
ALTER TABLE `telegram_connections` ADD `update_offset` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `telegram_connections` ADD `poll_lock_until` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `telegram_connections` ADD `poll_lock_id` text;--> statement-breakpoint
ALTER TABLE `telegram_connections` ADD `owner_delivery_enabled` integer DEFAULT 1 NOT NULL;