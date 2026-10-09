CREATE TABLE `profile_demand_events` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`source_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`episode_id` text NOT NULL,
	`activation_revision` integer NOT NULL,
	`payload_json` text NOT NULL,
	`payload_sha256` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `orchestrator_profiles`(`profile_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `profile_demand_events_key_idx` ON `profile_demand_events` (`profile_id`,`source_id`,`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `profile_demand_events_episode_revision_idx` ON `profile_demand_events` (`profile_id`,`episode_id`,`activation_revision`,`source_id`);--> statement-breakpoint
CREATE TABLE `__new_delivery_obligations` (
	`acked_at` integer,
	`agent_event_id` integer,
	`profile_demand_event_id` text,
	`delivery_seq` integer NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	`delivered_harness_turn_id` text,
	`delivered_owner_session_ref_json` text,
	`id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'agent' NOT NULL,
	`last_error_code` text,
	`last_error_summary` text,
	`lease_expires_at` integer,
	`lease_token` text,
	`profile_id` text NOT NULL,
	`state` text NOT NULL,
	`subscription_id` integer,
	FOREIGN KEY (`profile_demand_event_id`) REFERENCES `profile_demand_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_id`) REFERENCES `orchestrator_profiles`(`profile_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "delivery_obligations_exact_source" CHECK(("__new_delivery_obligations"."kind" = 'agent' and "__new_delivery_obligations"."agent_event_id" is not null and "__new_delivery_obligations"."subscription_id" is not null and "__new_delivery_obligations"."profile_demand_event_id" is null) or ("__new_delivery_obligations"."kind" = 'demand' and "__new_delivery_obligations"."agent_event_id" is null and "__new_delivery_obligations"."subscription_id" is null and "__new_delivery_obligations"."profile_demand_event_id" is not null))
);
--> statement-breakpoint
INSERT INTO `__new_delivery_obligations`("acked_at", "agent_event_id", "profile_demand_event_id", "delivery_seq", "attempt_count", "created_at", "delivered_at", "delivered_harness_turn_id", "delivered_owner_session_ref_json", "id", "kind", "last_error_code", "last_error_summary", "lease_expires_at", "lease_token", "profile_id", "state", "subscription_id") SELECT "acked_at", "agent_event_id", NULL, row_number() over (order by "agent_event_id", "id"), "attempt_count", "created_at", "delivered_at", "delivered_harness_turn_id", "delivered_owner_session_ref_json", "id", 'agent', "last_error_code", "last_error_summary", "lease_expires_at", "lease_token", "profile_id", "state", "subscription_id" FROM `delivery_obligations`; --> statement-breakpoint
DROP TABLE `delivery_obligations`;--> statement-breakpoint
ALTER TABLE `__new_delivery_obligations` RENAME TO `delivery_obligations`;--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_obligations_profile_event_idx` ON `delivery_obligations` (`profile_id`,`agent_event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_obligations_profile_demand_idx` ON `delivery_obligations` (`profile_id`,`profile_demand_event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_obligations_seq_idx` ON `delivery_obligations` (`delivery_seq`);--> statement-breakpoint
CREATE INDEX `delivery_obligations_profile_state_idx` ON `delivery_obligations` (`profile_id`,`state`);--> statement-breakpoint
ALTER TABLE `profile_owners` ADD `accepted_source_kinds_json` text DEFAULT '["agent"]' NOT NULL;