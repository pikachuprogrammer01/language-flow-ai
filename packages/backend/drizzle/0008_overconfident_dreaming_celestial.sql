CREATE TABLE `import_batch` (
	`id` varchar(32) NOT NULL,
	`filename` varchar(255) NOT NULL,
	`file_size` int NOT NULL,
	`file_hash` varchar(64) NOT NULL,
	`platform` varchar(50) NOT NULL,
	`row_count` int NOT NULL,
	`data_granularity` enum('work_level_strong','work_level_weak','account_day_level') NOT NULL,
	`granularity_evidence` json NOT NULL,
	`headers` json NOT NULL,
	`field_detection` json NOT NULL,
	`match_rules` json,
	`status` enum('draft','granularity_confirmed','rules_set','prematched','preflight_ok','committed','rolled_back','cancelled') NOT NULL DEFAULT 'draft',
	`commit_summary` json,
	`commit_preimage` json,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`completed_at` timestamp,
	CONSTRAINT `import_batch_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `import_row` (
	`id` int AUTO_INCREMENT NOT NULL,
	`batch_id` varchar(32) NOT NULL,
	`row_number` int NOT NULL,
	`raw_data` json NOT NULL,
	`normalized_data` json NOT NULL,
	`data_granularity` enum('work_level_strong','work_level_weak','account_day_level') NOT NULL,
	`match_status` enum('unique_match','conflict','unmatched','account_day_level','confirmed','ignored') NOT NULL,
	`validation_status` enum('pending','ok','warning','error') NOT NULL DEFAULT 'pending',
	CONSTRAINT `import_row_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_import_row_batch_number` UNIQUE(`batch_id`,`row_number`)
);
--> statement-breakpoint
CREATE TABLE `match_candidate` (
	`id` int AUTO_INCREMENT NOT NULL,
	`import_row_id` int NOT NULL,
	`video_id` varchar(32) NOT NULL,
	`match_method` enum('platform_work_id_exact','work_url_id','account_publish_time','account_date_title','account_date_title_duration') NOT NULL,
	`match_score` float NOT NULL,
	`evidence` json NOT NULL,
	`rank` int NOT NULL,
	CONSTRAINT `match_candidate_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_match_candidate_row_video` UNIQUE(`import_row_id`,`video_id`)
);
--> statement-breakpoint
CREATE TABLE `match_decision` (
	`import_row_id` int NOT NULL,
	`batch_id` varchar(32) NOT NULL,
	`match_status` enum('unique_match','conflict','unmatched','account_day_level','confirmed','ignored') NOT NULL,
	`matched_video_id` varchar(32),
	`match_method` enum('platform_work_id_exact','work_url_id','account_publish_time','account_date_title','account_date_title_duration'),
	`confidence` float,
	`decision_type` enum('system_auto','operator_confirm','operator_assign','operator_external','operator_account_day','operator_ignore') NOT NULL DEFAULT 'system_auto',
	`operator` varchar(100) NOT NULL DEFAULT 'local',
	`confirmed_at` datetime,
	`metadata` json,
	CONSTRAINT `match_decision_import_row_id` PRIMARY KEY(`import_row_id`)
);
--> statement-breakpoint
ALTER TABLE `import_row` ADD CONSTRAINT `import_row_batch_id_import_batch_id_fk` FOREIGN KEY (`batch_id`) REFERENCES `import_batch`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `match_candidate` ADD CONSTRAINT `match_candidate_import_row_id_import_row_id_fk` FOREIGN KEY (`import_row_id`) REFERENCES `import_row`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `match_candidate` ADD CONSTRAINT `match_candidate_video_id_publish_records_id_fk` FOREIGN KEY (`video_id`) REFERENCES `publish_records`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `match_decision` ADD CONSTRAINT `match_decision_import_row_id_import_row_id_fk` FOREIGN KEY (`import_row_id`) REFERENCES `import_row`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `match_decision` ADD CONSTRAINT `match_decision_batch_id_import_batch_id_fk` FOREIGN KEY (`batch_id`) REFERENCES `import_batch`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_import_batch_status` ON `import_batch` (`status`);--> statement-breakpoint
CREATE INDEX `idx_import_batch_file_hash` ON `import_batch` (`file_hash`);--> statement-breakpoint
CREATE INDEX `idx_import_row_batch_status` ON `import_row` (`batch_id`,`match_status`);--> statement-breakpoint
CREATE INDEX `idx_match_candidate_row` ON `match_candidate` (`import_row_id`,`rank`);--> statement-breakpoint
CREATE INDEX `idx_match_decision_batch` ON `match_decision` (`batch_id`,`match_status`);