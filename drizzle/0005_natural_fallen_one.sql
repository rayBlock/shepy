CREATE TABLE `orchestrator_profiles` (
	`created_at` integer NOT NULL,
	`display_name` text NOT NULL,
	`profile_id` text PRIMARY KEY NOT NULL,
	`project_roots_json` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `profile_subscriptions` (
	`agent_selector_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`herdr_session_name` text NOT NULL,
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` text NOT NULL,
	`updated_at` integer NOT NULL,
	`workspace_selector_json` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `orchestrator_profiles`(`profile_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profile_subscriptions_identity_idx` ON `profile_subscriptions` (`profile_id`,`herdr_session_name`,`workspace_selector_json`,`agent_selector_json`);