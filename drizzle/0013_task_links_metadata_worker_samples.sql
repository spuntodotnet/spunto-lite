CREATE TABLE `worker_samples` (
	`worker_id` text NOT NULL,
	`ts` integer NOT NULL,
	`cpu_percent` real NOT NULL,
	`mem_used_mb` real NOT NULL,
	`mem_total_mb` real NOT NULL
);
--> statement-breakpoint
CREATE INDEX `worker_samples_worker_ts_idx` ON `worker_samples` (`worker_id`,`ts`);--> statement-breakpoint
CREATE INDEX `worker_samples_ts_idx` ON `worker_samples` (`ts`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `links` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `metadata` text DEFAULT '{}' NOT NULL;