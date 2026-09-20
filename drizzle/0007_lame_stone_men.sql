PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workers` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`container_id` text,
	`state` text DEFAULT 'provisioning' NOT NULL,
	`setup_status` text,
	`branch` text,
	`project_version` integer DEFAULT 1 NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_workers`("id", "project_id", "name", "container_id", "state", "setup_status", "branch", "project_version", "tags", "created_at") SELECT "id", "project_id", "name", "container_id", "state", "setup_status", "branch", "project_version", "tags", "created_at" FROM `workers`;--> statement-breakpoint
DROP TABLE `workers`;--> statement-breakpoint
ALTER TABLE `__new_workers` RENAME TO `workers`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
-- `pending` s'appelle désormais `provisioning`, des deux côtés : c'est le mot du design
-- system, et le traduire à l'affichage coûtait un adaptateur qui perdait l'information.
-- Même sens exactement, et un état transitoire : une ligne qui le porte est en vol ou morte.
-- La copie ci-dessus a repris `state` verbatim, donc le renommage se fait ici.
UPDATE `workers` SET `state` = 'provisioning' WHERE `state` = 'pending';--> statement-breakpoint
UPDATE `services` SET `state` = 'provisioning' WHERE `state` = 'pending';
