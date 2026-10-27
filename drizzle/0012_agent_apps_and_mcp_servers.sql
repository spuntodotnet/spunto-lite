CREATE TABLE `mcp_connections` (
	`server_id` text PRIMARY KEY NOT NULL,
	`encrypted_access_token` text NOT NULL,
	`encrypted_refresh_token` text,
	`expires_at` integer,
	`status` text DEFAULT 'ok' NOT NULL,
	`scope` text,
	`connected_at` integer NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `mcp_servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mcp_gateway_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`project_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mcp_gateway_tokens_task_idx` ON `mcp_gateway_tokens` (`task_id`);--> statement-breakpoint
CREATE TABLE `mcp_oauth_states` (
	`state` text PRIMARY KEY NOT NULL,
	`server_id` text NOT NULL,
	`encrypted_code_verifier` text NOT NULL,
	`issuer` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `mcp_servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mcp_servers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`auth` text NOT NULL,
	`mode` text DEFAULT 'default' NOT NULL,
	`oauth` text,
	`client_id` text,
	`encrypted_client_secret` text,
	`encrypted_header_name` text,
	`encrypted_header_value` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_servers_name_unique` ON `mcp_servers` (`name`);--> statement-breakpoint
CREATE TABLE `project_mcp_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`server_id` text NOT NULL,
	`enabled` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`server_id`) REFERENCES `mcp_servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_mcp_settings_project_server_idx` ON `project_mcp_settings` (`project_id`,`server_id`);--> statement-breakpoint
ALTER TABLE `projects` ADD `agent_app_ids` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `task_agent_models` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `agent_app_id` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `agent_options` text;--> statement-breakpoint
-- Agent apps (RFC 0048, docs/taches.md): every existing project moves to Claude Code, the harness
-- it ran before, as a new version — its image gains the app's feature (the SDK and its Node).
-- Its single default model becomes Claude's, when the app's catalog knows it.
UPDATE `projects` SET
	`agent_app_ids` = '["claude"]',
	`task_agent_models` = CASE
		WHEN `task_agent_model` IN ('claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-haiku-5-5') THEN json_object('claude', `task_agent_model`)
		ELSE '{}'
	END,
	`current_version` = `current_version` + 1;--> statement-breakpoint
INSERT INTO `project_versions` (`id`, `project_id`, `version`, `config`, `created_at`)
SELECT lower(hex(randomblob(6))), p.`id`, p.`current_version`, json_set(v.`config`, '$.agentAppIds', json('["claude"]')), unixepoch()
FROM `projects` p
JOIN `project_versions` v ON v.`project_id` = p.`id` AND v.`version` = p.`current_version` - 1;
