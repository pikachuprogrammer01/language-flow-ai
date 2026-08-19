ALTER TABLE `upload_marks` ADD `task_id` varchar(32);--> statement-breakpoint
CREATE INDEX `idx_upload_marks_task_id` ON `upload_marks` (`task_id`);