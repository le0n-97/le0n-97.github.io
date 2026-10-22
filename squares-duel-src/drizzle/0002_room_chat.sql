CREATE TABLE `room_chat` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`room_code` text NOT NULL,
	`room_created_at` integer NOT NULL,
	`player_id` text NOT NULL,
	`client_id` text NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `room_chat_room_seq_idx` ON `room_chat` (`room_code`,`room_created_at`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `room_chat_client_idx` ON `room_chat` (`room_code`,`room_created_at`,`player_id`,`client_id`);--> statement-breakpoint
CREATE TABLE `room_chat_rates` (
	`room_code` text NOT NULL,
	`room_created_at` integer NOT NULL,
	`player_id` text NOT NULL,
	`last_sent_at` integer NOT NULL,
	PRIMARY KEY(`room_code`, `room_created_at`, `player_id`)
);
