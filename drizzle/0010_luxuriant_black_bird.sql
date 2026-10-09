CREATE TABLE `source_entry_deliveries` (
	`source_entry_id` text NOT NULL,
	`content_sha256` text NOT NULL,
	`profile_id` text NOT NULL,
	`agent_event_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `orchestrator_profiles`(`profile_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_entry_deliveries_profile_entry_idx` ON `source_entry_deliveries` (`profile_id`,`source_entry_id`,`content_sha256`);