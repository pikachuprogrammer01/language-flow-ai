ALTER TABLE `video_analytics` MODIFY COLUMN `publish_at` datetime;--> statement-breakpoint
-- 加 FK 前确定性清理孤儿 analytics 行（否则 ADD CONSTRAINT 在存在孤儿时失败）；X6 预检
DELETE FROM `video_analytics` WHERE `content_id` NOT IN (SELECT `id` FROM `contents`);--> statement-breakpoint
ALTER TABLE `video_analytics` ADD CONSTRAINT `video_analytics_content_id_contents_id_fk` FOREIGN KEY (`content_id`) REFERENCES `contents`(`id`) ON DELETE cascade ON UPDATE no action;