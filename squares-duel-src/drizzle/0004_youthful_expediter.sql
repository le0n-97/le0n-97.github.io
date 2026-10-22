CREATE TABLE `rating_changes` (
	`round_id` text NOT NULL,
	`account_id` text NOT NULL,
	`player_id` text NOT NULL,
	`team_id` integer NOT NULL,
	`before_milli` integer NOT NULL,
	`delta_milli` integer NOT NULL,
	`after_milli` integer NOT NULL,
	PRIMARY KEY(`round_id`, `account_id`),
	FOREIGN KEY (`round_id`) REFERENCES `rating_rounds`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `rating_changes_account_idx` ON `rating_changes` (`account_id`);--> statement-breakpoint
CREATE TABLE `rating_rounds` (
	`id` text PRIMARY KEY NOT NULL,
	`receipt` text NOT NULL,
	`room_code` text NOT NULL,
	`round` integer NOT NULL,
	`ended_at` integer NOT NULL,
	`result_json` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `accounts` ADD `rating_milli` integer DEFAULT 1000000 NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `rated_games` integer DEFAULT 0 NOT NULL;