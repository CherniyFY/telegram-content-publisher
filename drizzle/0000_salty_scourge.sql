CREATE TABLE `telegram_connections` (
	`user_id` text PRIMARY KEY NOT NULL,
	`token_cipher` text NOT NULL,
	`bot_username` text NOT NULL,
	`bot_name` text NOT NULL,
	`pairing_code` text,
	`pairing_expires` integer,
	`chat_id` text,
	`chat_name` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `telegram_deliveries` (
	`user_id` text NOT NULL,
	`lesson_key` text NOT NULL,
	`content_hash` text NOT NULL,
	`total_parts` integer NOT NULL,
	`sent_parts` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`finished_at` text,
	PRIMARY KEY(`user_id`, `lesson_key`)
);
