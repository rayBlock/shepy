CREATE INDEX `agent_events_latest_settled_idx` ON `agent_events` (`agent_id`,`id`) WHERE "agent_events"."type" in ('agent.done', 'agent.idle');--> statement-breakpoint
CREATE INDEX `delivery_obligations_agent_event_idx` ON `delivery_obligations` (`agent_event_id`);--> statement-breakpoint
CREATE INDEX `source_entry_deliveries_agent_event_idx` ON `source_entry_deliveries` (`agent_event_id`);