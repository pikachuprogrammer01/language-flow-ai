CREATE TABLE `analysis_result` (
	`id` int AUTO_INCREMENT NOT NULL,
	`analysis_type` varchar(64) NOT NULL,
	`subject_id` varchar(32),
	`result` json NOT NULL,
	`evidence` json,
	`confidence` float,
	`model_version` varchar(32) NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `analysis_result_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `content_features` (
	`content_id` varchar(32) NOT NULL,
	`template` enum('scene_word','word_card','quiz') NOT NULL,
	`level` enum('CET4','CET6') NOT NULL,
	`duration` double,
	`knowledge_point_count` int,
	`character_count` int,
	`dialogue_count` int,
	`segment_count` int,
	`speech_rate` float,
	`voice_id` varchar(100),
	`bgm` varchar(500),
	`subtitle_type` varchar(32),
	`shot_count` int,
	`intro_effect` int,
	`intro_topic` varchar(255),
	`prompt_version` varchar(32),
	`renderer_version` varchar(32),
	`scene` varchar(32),
	`hook` varchar(32),
	`content_format` varchar(32),
	`emotion` varchar(32),
	`cta_type` varchar(32),
	`cta_start_time` int,
	`field_sources` json,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `content_features_content_id` PRIMARY KEY(`content_id`)
);
--> statement-breakpoint
CREATE TABLE `creator_metric_daily` (
	`platform` varchar(50) NOT NULL,
	`stat_date` date NOT NULL,
	`play_increment` int,
	`like_increment` int,
	`comment_increment` int,
	`share_increment` int,
	`profile_uv` int,
	`new_fans` int,
	`total_fans` int,
	`bounce_rate_2s` double,
	`watch_rate_5s` double,
	`avg_watch_time` double,
	`post_count` int,
	`cover_click_rate` double,
	`source_type` enum('CREATOR_IMPORT','PLATFORM_PRODUCTION','PLATFORM_CALCULATED','AI_EXTRACTED','USER_INPUT') NOT NULL,
	`fetched_at` timestamp NOT NULL DEFAULT (now()),
	`metadata` json,
	CONSTRAINT `creator_metric_daily_platform_stat_date_pk` PRIMARY KEY(`platform`,`stat_date`)
);
--> statement-breakpoint
CREATE TABLE `experiments` (
	`id` varchar(32) NOT NULL,
	`variable` varchar(32) NOT NULL,
	`variant_a` json NOT NULL,
	`variant_b` json NOT NULL,
	`control_variables` json,
	`target_metric` varchar(64) NOT NULL DEFAULT 'completion_rate',
	`start_at` datetime,
	`end_at` datetime,
	`status` enum('draft','running','completed','cancelled') NOT NULL DEFAULT 'draft',
	`result` json,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `experiments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `publish_records` (
	`id` varchar(32) NOT NULL,
	`content_id` varchar(32) NOT NULL,
	`video_asset_id` varchar(100),
	`platform` varchar(50) NOT NULL,
	`platform_video_id` varchar(100),
	`publish_title` varchar(255),
	`publish_time` datetime,
	`cover_url` varchar(500),
	`publish_status` enum('scheduled','published','deleted') NOT NULL DEFAULT 'published',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `publish_records_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_publish_records_platform_video` UNIQUE(`platform`,`platform_video_id`)
);
--> statement-breakpoint
CREATE TABLE `recommendations` (
	`id` varchar(32) NOT NULL,
	`recommendation_type` varchar(32) NOT NULL,
	`recommendation` json NOT NULL,
	`reason` varchar(500) NOT NULL,
	`source_sample_count` int NOT NULL,
	`source_metric` varchar(64) NOT NULL,
	`confidence` float,
	`accepted` int,
	`applied_to_content_id` varchar(32),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `recommendations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `video_metric_daily` (
	`id` int AUTO_INCREMENT NOT NULL,
	`publish_record_id` varchar(32) NOT NULL,
	`metric_name` varchar(64) NOT NULL,
	`metric_value` double NOT NULL,
	`source_type` enum('CREATOR_IMPORT','PLATFORM_PRODUCTION','PLATFORM_CALCULATED','AI_EXTRACTED','USER_INPUT') NOT NULL,
	`source_field` varchar(100),
	`data_date` date NOT NULL,
	`fetched_at` timestamp NOT NULL DEFAULT (now()),
	`is_estimated` int NOT NULL DEFAULT 0,
	`confidence` float,
	`metadata` json,
	CONSTRAINT `video_metric_daily_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_video_metric_daily_record_name_date` UNIQUE(`publish_record_id`,`metric_name`,`data_date`)
);
--> statement-breakpoint
CREATE TABLE `video_metrics` (
	`id` int AUTO_INCREMENT NOT NULL,
	`publish_record_id` varchar(32) NOT NULL,
	`metric_name` varchar(64) NOT NULL,
	`metric_value` double NOT NULL,
	`source_type` enum('CREATOR_IMPORT','PLATFORM_PRODUCTION','PLATFORM_CALCULATED','AI_EXTRACTED','USER_INPUT') NOT NULL,
	`source_field` varchar(100),
	`data_date` date,
	`fetched_at` timestamp NOT NULL DEFAULT (now()),
	`is_estimated` int NOT NULL DEFAULT 0,
	`confidence` float,
	`metadata` json,
	CONSTRAINT `video_metrics_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_video_metrics_record_name` UNIQUE(`publish_record_id`,`metric_name`)
);
--> statement-breakpoint
CREATE TABLE `video_segments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`content_id` varchar(32) NOT NULL,
	`idx` int NOT NULL,
	`start_time` double NOT NULL,
	`end_time` double NOT NULL,
	`segment_type` varchar(32) NOT NULL,
	`dialogue` varchar(2000),
	`knowledge_point` varchar(500),
	`scene` varchar(32),
	`emotion` varchar(32),
	`shot_type` varchar(32),
	`source_type` enum('CREATOR_IMPORT','PLATFORM_PRODUCTION','PLATFORM_CALCULATED','AI_EXTRACTED','USER_INPUT') NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `video_segments_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_video_segments_content_idx` UNIQUE(`content_id`,`idx`)
);
--> statement-breakpoint
ALTER TABLE `content_features` ADD CONSTRAINT `content_features_content_id_contents_id_fk` FOREIGN KEY (`content_id`) REFERENCES `contents`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `publish_records` ADD CONSTRAINT `publish_records_content_id_contents_id_fk` FOREIGN KEY (`content_id`) REFERENCES `contents`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `video_metric_daily` ADD CONSTRAINT `video_metric_daily_publish_record_id_publish_records_id_fk` FOREIGN KEY (`publish_record_id`) REFERENCES `publish_records`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `video_metrics` ADD CONSTRAINT `video_metrics_publish_record_id_publish_records_id_fk` FOREIGN KEY (`publish_record_id`) REFERENCES `publish_records`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `video_segments` ADD CONSTRAINT `video_segments_content_id_contents_id_fk` FOREIGN KEY (`content_id`) REFERENCES `contents`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_analysis_result_type` ON `analysis_result` (`analysis_type`,`subject_id`);--> statement-breakpoint
CREATE INDEX `idx_experiments_status` ON `experiments` (`status`);--> statement-breakpoint
CREATE INDEX `idx_publish_records_content_id` ON `publish_records` (`content_id`);--> statement-breakpoint
CREATE INDEX `idx_recommendations_type` ON `recommendations` (`recommendation_type`);--> statement-breakpoint
CREATE INDEX `idx_recommendations_applied` ON `recommendations` (`applied_to_content_id`);--> statement-breakpoint
CREATE INDEX `idx_video_metric_daily_date` ON `video_metric_daily` (`data_date`);--> statement-breakpoint
CREATE INDEX `idx_video_metrics_record` ON `video_metrics` (`publish_record_id`);--> statement-breakpoint
CREATE INDEX `idx_video_segments_content` ON `video_segments` (`content_id`);