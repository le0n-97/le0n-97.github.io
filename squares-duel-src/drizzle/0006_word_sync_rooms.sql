CREATE TABLE `word_sync_rooms` (
  `id` text PRIMARY KEY NOT NULL,
  `code` text NOT NULL,
  `state` text NOT NULL,
  `revision` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `word_sync_rooms_code_idx` ON `word_sync_rooms` (`code`);
