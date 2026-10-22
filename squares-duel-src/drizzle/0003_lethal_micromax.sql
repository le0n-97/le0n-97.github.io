CREATE TABLE `account_rates` (
	`key` text PRIMARY KEY NOT NULL,
	`window_start` integer NOT NULL,
	`hits` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `account_rates_window_idx` ON `account_rates` (`window_start`);--> statement-breakpoint
CREATE TABLE `account_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`password_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_sessions_account_idx` ON `account_sessions` (`account_id`);--> statement-breakpoint
CREATE INDEX `account_sessions_expiry_idx` ON `account_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`username_key` text NOT NULL,
	`password_hash` text NOT NULL,
	`password_version` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_username_key_idx` ON `accounts` (`username_key`);