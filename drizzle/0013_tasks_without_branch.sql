-- tasks.branch becomes nullable (RFC 0056, Cloud ab56551c): Lite creates no branch for a new task.
--
-- SQLite cannot drop a NOT NULL, so the table is rebuilt, as drizzle-kit generates it — with one
-- addition it does not know it needs. Its `PRAGMA foreign_keys=OFF` is a no-op inside the
-- migrator's transaction (every pending migration runs in one BEGIN … COMMIT), so `DROP TABLE
-- tasks` runs an implicit DELETE that cascades into every table hanging off a task: each task
-- would keep its row and lose its whole history. Renaming instead does not help (with foreign
-- keys on, the children's REFERENCES follow the rename), and rewriting the schema in place is
-- refused (better-sqlite3 opens databases in defensive mode). So the children are copied aside
-- first and put back once the new `tasks` holds every row again.
CREATE TABLE `__keep_task_commands` AS SELECT * FROM `task_commands`;--> statement-breakpoint
CREATE TABLE `__keep_task_events` AS SELECT * FROM `task_events`;--> statement-breakpoint
CREATE TABLE `__keep_task_attachments` AS SELECT * FROM `task_attachments`;--> statement-breakpoint
CREATE TABLE `__keep_mcp_gateway_tokens` AS SELECT * FROM `mcp_gateway_tokens`;--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`auto_title` integer DEFAULT false NOT NULL,
	`prompt` text NOT NULL,
	`base_branch` text,
	`branch` text,
	`model` text,
	`agent_app_id` text,
	`agent_options` text,
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
INSERT INTO `__new_tasks`("id", "project_id", "title", "auto_title", "prompt", "base_branch", "branch", "model", "agent_app_id", "agent_options", "worker_id", "command_id", "state", "error", "pending_action", "pending_since", "last_refreshed_at", "last_activity_at", "events_command_id", "events_offset", "events_seq", "created_at", "started_at", "completed_at") SELECT "id", "project_id", "title", "auto_title", "prompt", "base_branch", "branch", "model", "agent_app_id", "agent_options", "worker_id", "command_id", "state", "error", "pending_action", "pending_since", "last_refreshed_at", "last_activity_at", "events_command_id", "events_offset", "events_seq", "created_at", "started_at", "completed_at" FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
CREATE INDEX `tasks_project_activity_idx` ON `tasks` (`project_id`,`last_activity_at`);--> statement-breakpoint
CREATE INDEX `tasks_state_idx` ON `tasks` (`state`);--> statement-breakpoint
DELETE FROM `task_commands`;--> statement-breakpoint
INSERT INTO `task_commands` SELECT * FROM `__keep_task_commands`;--> statement-breakpoint
DELETE FROM `task_events`;--> statement-breakpoint
INSERT INTO `task_events` SELECT * FROM `__keep_task_events`;--> statement-breakpoint
DELETE FROM `task_attachments`;--> statement-breakpoint
INSERT INTO `task_attachments` SELECT * FROM `__keep_task_attachments`;--> statement-breakpoint
DELETE FROM `mcp_gateway_tokens`;--> statement-breakpoint
INSERT INTO `mcp_gateway_tokens` SELECT * FROM `__keep_mcp_gateway_tokens`;--> statement-breakpoint
DROP TABLE `__keep_task_commands`;--> statement-breakpoint
DROP TABLE `__keep_task_events`;--> statement-breakpoint
DROP TABLE `__keep_task_attachments`;--> statement-breakpoint
DROP TABLE `__keep_mcp_gateway_tokens`;
