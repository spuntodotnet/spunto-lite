CREATE TABLE `task_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`command_id` text,
	`origin` text NOT NULL,
	`filename` text,
	`media_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`data` blob NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_attachments_task_sha_idx` ON `task_attachments` (`task_id`,`sha256`);--> statement-breakpoint
CREATE TABLE `task_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`worker_id` text,
	`label` text,
	`command` text NOT NULL,
	`cwd` text,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`exit_code` integer,
	`stdout` text,
	`stderr` text,
	`truncated` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_commands_task_idx` ON `task_commands` (`task_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `task_events` (
	`task_id` text NOT NULL,
	`seq` integer NOT NULL,
	`command_id` text,
	`ts` integer NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`source` text,
	PRIMARY KEY(`task_id`, `seq`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_events_type_idx` ON `task_events` (`task_id`,`type`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`auto_title` integer DEFAULT false NOT NULL,
	`prompt` text NOT NULL,
	`base_branch` text,
	`branch` text NOT NULL,
	`model` text,
	`worker_id` text,
	`command_id` text,
	`state` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`pending_action` text,
	`pending_since` integer,
	`last_refreshed_at` integer,
	`last_activity_at` integer NOT NULL,
	`events_command_id` text,
	`events_offset` integer DEFAULT 0 NOT NULL,
	`events_seq` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`worker_id`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `tasks_project_activity_idx` ON `tasks` (`project_id`,`last_activity_at`);--> statement-breakpoint
CREATE INDEX `tasks_state_idx` ON `tasks` (`state`);--> statement-breakpoint
ALTER TABLE `projects` ADD `task_agent_command` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `task_agent_protocol` text DEFAULT 'claude-stream' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `task_follow_up_command` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `task_reset_command` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `task_validate_command` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `task_cancel_command` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `task_review_mode` text DEFAULT 'keep' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `task_agent_model` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `task_agent_instructions` text;