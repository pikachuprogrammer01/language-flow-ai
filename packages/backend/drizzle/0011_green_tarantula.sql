CREATE TABLE `recommendation_applications` (
	`id` varchar(32) NOT NULL,
	`recommendation_id` varchar(32) NOT NULL,
	`content_id` varchar(32),
	`suggested_params` json NOT NULL,
	`prefill_params` json NOT NULL,
	`final_params` json,
	`target_metric` varchar(64) NOT NULL,
	`analysis_result_id` int,
	`accepted_at` timestamp NOT NULL DEFAULT (now()),
	`applied_at` timestamp,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `recommendation_applications_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `recommendations` ADD `analysis_result_id` int;--> statement-breakpoint
CREATE INDEX `idx_recommendation_applications_rec` ON `recommendation_applications` (`recommendation_id`);--> statement-breakpoint
CREATE INDEX `idx_recommendation_applications_content` ON `recommendation_applications` (`content_id`);--> statement-breakpoint
CREATE INDEX `idx_recommendations_analysis` ON `recommendations` (`analysis_result_id`);