ALTER TABLE `projects` ADD `ports_attributes` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `task_review_park_after_minutes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `park_at` integer;