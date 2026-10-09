-- Seat-authorized private dispatch-receipt persistence for row 15.259; no public operation/CLI schema change.
ALTER TABLE `orchestration_operations` ADD `receipt_agent` text;--> statement-breakpoint
ALTER TABLE `orchestration_operations` ADD `receipt_agent_session` text;--> statement-breakpoint
ALTER TABLE `orchestration_operations` ADD `receipt_terminal_id` text;--> statement-breakpoint
ALTER TABLE `orchestration_operations` ADD `receipt_state_change_seq` integer;--> statement-breakpoint
ALTER TABLE `orchestration_operations` ADD `receipt_completion_seq` integer;
