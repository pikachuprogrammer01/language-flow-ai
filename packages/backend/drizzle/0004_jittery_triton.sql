CREATE TABLE `video_analytics` (
	`content_id` varchar(32) NOT NULL,
	`story_topic` varchar(255),
	`publish_at` timestamp,
	`cover_url` varchar(500),
	`allow_save` int NOT NULL DEFAULT 1,
	`custom_params` json,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `video_analytics_content_id` PRIMARY KEY(`content_id`)
);
