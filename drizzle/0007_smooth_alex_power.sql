CREATE TABLE `orchestration_operations` (
	`created_at` integer NOT NULL,
	`error_summary` text,
	`herdr_session_name` text NOT NULL,
	`id` text PRIMARY KEY NOT NULL,
	`lifecycle` text,
	`profile_id` text NOT NULL,
	`prompt_excerpt` text NOT NULL,
	`prompt_sha256` text NOT NULL,
	`settled_at` integer,
	`state` text NOT NULL,
	`target_json` text NOT NULL,
	`transport_request_id` text,
	`updated_at` integer NOT NULL,
	`workspace_id` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `orchestrator_profiles`(`profile_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `orchestration_operations_profile_created_idx` ON `orchestration_operations` (`profile_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `orchestration_operations_state_idx` ON `orchestration_operations` (`state`);