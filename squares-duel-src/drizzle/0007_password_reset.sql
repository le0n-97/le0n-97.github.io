CREATE TABLE `account_password_resets` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`receipt` text NOT NULL,
	`used_at` integer NOT NULL
);
