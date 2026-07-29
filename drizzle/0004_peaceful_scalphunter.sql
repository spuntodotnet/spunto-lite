CREATE TABLE `services` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`image` text NOT NULL,
	`command` text,
	`env` text DEFAULT '[]' NOT NULL,
	`ports` text DEFAULT '[]' NOT NULL,
	`volumes` text DEFAULT '[]' NOT NULL,
	`http_port` integer,
	`restart_policy` text DEFAULT 'unless-stopped' NOT NULL,
	`container_id` text,
	`state` text DEFAULT 'stopped' NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `services_slug_unique` ON `services` (`slug`);