CREATE TABLE `upload_marks` (
	`id` varchar(32) NOT NULL,
	`video_filename` varchar(100) NOT NULL,
	`platform` varchar(50) NOT NULL,
	`url` varchar(500),
	`note` varchar(500),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `upload_marks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_upload_marks_video_filename` ON `upload_marks` (`video_filename`);