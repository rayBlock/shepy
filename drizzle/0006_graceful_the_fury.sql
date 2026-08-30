CREATE TABLE `delivery_obligations` (
	`acked_at` integer,
	`agent_event_id` integer NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	`delivered_harness_turn_id` text,
	`delivered_owner_session_ref_json` text,
	`id` text PRIMARY KEY NOT NULL,
	`last_error_code` text,
	`last_error_summary` text,
	`lease_expires_at` integer,
	`lease_token` text,
	`profile_id` text NOT NULL,
	`state` text NOT NULL,
	`subscription_id` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `orchestrator_profiles`(`profile_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_obligations_profile_event_idx` ON `delivery_obligations` (`profile_id`,`agent_event_id`);--> statement-breakpoint
CREATE INDEX `delivery_obligations_profile_state_idx` ON `delivery_obligations` (`profile_id`,`state`);--> statement-breakpoint
CREATE TABLE `profile_owners` (
	`claimed_at` integer NOT NULL,
	`harness_kind` text NOT NULL,
	`harness_session_ref_json` text NOT NULL,
	`herdr_session_name` text NOT NULL,
	`last_seen_at` integer NOT NULL,
	`lease_expires_at` integer NOT NULL,
	`lease_token` text NOT NULL,
	`pane_id` text NOT NULL,
	`profile_id` text PRIMARY KEY NOT NULL,
	`subscriber_id` text NOT NULL,
	`terminal_id` text NOT NULL,
	`workspace_id` text
);
