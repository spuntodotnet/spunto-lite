CREATE TABLE `lite_connect` (
	`id` text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	`spunto_url` text DEFAULT 'https://spunto.net' NOT NULL,
	`machine_name` text,
	`capabilities` text DEFAULT '["read"]' NOT NULL,
	`client_id` text,
	`client_spunto_url` text,
	`client_redirect_uri` text,
	`pending_state` text,
	`encrypted_pending_verifier` text,
	`pending_redirect_uri` text,
	`pending_at` integer,
	`encrypted_access_token` text,
	`access_expires_at` integer,
	`encrypted_refresh_token` text,
	`connected_at` integer,
	`last_error` text,
	`connection_id` text
);
