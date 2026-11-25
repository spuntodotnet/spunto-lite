CREATE TABLE `worker_starts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`worker_id` text NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`origin` text NOT NULL,
	`outcome` text NOT NULL,
	`at` integer NOT NULL,
	`total_ms` integer NOT NULL,
	`phases` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `worker_starts_at_idx` ON `worker_starts` (`at`);--> statement-breakpoint
CREATE INDEX `worker_starts_project_idx` ON `worker_starts` (`project_id`,`at`);--> statement-breakpoint
ALTER TABLE `project_image_builds` ADD `duration_ms` integer;