ALTER TABLE `workers` ADD `data_plane` text DEFAULT 'exec' NOT NULL;--> statement-breakpoint
ALTER TABLE `workers` ADD `agent_token_hash` text;