CREATE TABLE `integration_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`origin` text NOT NULL,
	`encrypted_token` text NOT NULL,
	`account` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integration_connections_origin_unique` ON `integration_connections` (`origin`);