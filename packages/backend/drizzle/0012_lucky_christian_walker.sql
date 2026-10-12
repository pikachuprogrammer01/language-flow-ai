CREATE TABLE `experiment_assignments` (
	`id` varchar(32) NOT NULL,
	`experiment_id` varchar(32) NOT NULL,
	`content_id` varchar(32),
	`variant` enum('A','B') NOT NULL,
	`assignment_method` enum('operator_selected') NOT NULL DEFAULT 'operator_selected',
	`assigned_params` json NOT NULL,
	`final_params` json,
	`assigned_at` timestamp NOT NULL DEFAULT (now()),
	`bound_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `experiment_assignments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_experiment_assignments_exp_variant` ON `experiment_assignments` (`experiment_id`,`variant`);--> statement-breakpoint
CREATE INDEX `idx_experiment_assignments_content` ON `experiment_assignments` (`content_id`);