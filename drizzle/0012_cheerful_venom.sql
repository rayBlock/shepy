CREATE TABLE `claude_idle_wakes` (
	`batch_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`obligation_ids_json` text NOT NULL,
	`profile_id` text NOT NULL,
	PRIMARY KEY(`profile_id`, `batch_key`),
	FOREIGN KEY (`profile_id`) REFERENCES `orchestrator_profiles`(`profile_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `orchestrator_profiles` ADD `claude_idle_wake` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `profile_owners` ADD `claude_messaging_socket_json` text;