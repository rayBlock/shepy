PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_profile_owners` (
	`accepted_source_kinds_json` text DEFAULT '["agent"]' NOT NULL,
	`claimed_at` integer NOT NULL,
	`harness_kind` text NOT NULL,
	`harness_session_ref_json` text NOT NULL,
	`herdr_session_name` text,
	`last_seen_at` integer NOT NULL,
	`lease_expires_at` integer NOT NULL,
	`lease_token` text NOT NULL,
	`pane_id` text,
	`profile_id` text PRIMARY KEY NOT NULL,
	`subscriber_id` text NOT NULL,
	`terminal_id` text,
	`workspace_id` text
);
--> statement-breakpoint
INSERT INTO `__new_profile_owners`("accepted_source_kinds_json", "claimed_at", "harness_kind", "harness_session_ref_json", "herdr_session_name", "last_seen_at", "lease_expires_at", "lease_token", "pane_id", "profile_id", "subscriber_id", "terminal_id", "workspace_id") SELECT "accepted_source_kinds_json", "claimed_at", "harness_kind", "harness_session_ref_json", "herdr_session_name", "last_seen_at", "lease_expires_at", "lease_token", "pane_id", "profile_id", "subscriber_id", "terminal_id", "workspace_id" FROM `profile_owners`;--> statement-breakpoint
DROP TABLE `profile_owners`;--> statement-breakpoint
ALTER TABLE `__new_profile_owners` RENAME TO `profile_owners`;--> statement-breakpoint
PRAGMA foreign_keys=ON;