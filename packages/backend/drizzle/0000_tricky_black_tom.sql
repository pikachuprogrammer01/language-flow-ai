CREATE TABLE `cet_words` (
	`id` int AUTO_INCREMENT NOT NULL,
	`word` varchar(100) NOT NULL,
	`meaning` varchar(500) NOT NULL,
	`level` enum('CET4','CET6') NOT NULL,
	`frequency` float DEFAULT 0,
	CONSTRAINT `cet_words_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `contents` (
	`id` varchar(32) NOT NULL,
	`template` enum('scene_word','word_card','quiz') NOT NULL,
	`title` varchar(255) NOT NULL,
	`level` enum('CET4','CET6') NOT NULL,
	`target_duration` int NOT NULL,
	`content` json NOT NULL,
	`words` json NOT NULL,
	`style` json NOT NULL,
	`voice` json NOT NULL,
	`audio` json,
	`video` json,
	`status` enum('draft','ai_generating','content_ready','tts_processing','audio_ready','video_rendering','completed','failed') NOT NULL DEFAULT 'draft',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `contents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_level_freq` ON `cet_words` (`level`,`frequency`);--> statement-breakpoint
CREATE INDEX `idx_status` ON `contents` (`status`);