CREATE TABLE `game_records` (
	`id` text PRIMARY KEY NOT NULL,
	`room_code` text NOT NULL,
	`round` integer NOT NULL,
	`ended_at` integer NOT NULL,
	`player_names` text NOT NULL,
	`record_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `game_records_ended_at_idx` ON `game_records` (`ended_at`,`id`);