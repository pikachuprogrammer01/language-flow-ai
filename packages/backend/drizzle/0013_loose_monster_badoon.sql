CREATE TABLE `tts_voices` (
	`id` varchar(64) NOT NULL,
	`label` varchar(64) NOT NULL,
	`gender` varchar(8) NOT NULL,
	`engine` enum('edge','local') NOT NULL DEFAULT 'edge',
	`enabled` int NOT NULL DEFAULT 1,
	`last_check_at` timestamp,
	`last_check_status` enum('ok','no_audio','rate_limited','handshake_failed','error'),
	`last_check_detail` varchar(200),
	`created_at` timestamp NOT NULL DEFAULT (now()),
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `tts_voices_id` PRIMARY KEY(`id`)
);

--> statement-breakpoint

-- 音色目录种子（docs/24）：改数据即可上下架，不再改代码
-- 晓辰/晓涵/晓梦：2026-10-12 在 api.msedgeservices.com 上实测「连上但零音频帧」，按事实下架
-- 本地音色 engine='local'：仅宿主机 darwin 可用，容器内由 service 按平台过滤，不出下拉
INSERT IGNORE INTO tts_voices (id, label, gender, engine, enabled, last_check_at, last_check_status, last_check_detail) VALUES
  ('zh-CN-XiaoxiaoNeural','晓晓（女·温暖）','女','edge',1,NOW(),'ok','2026-10-12 生产实测出音频'),
  ('zh-CN-XiaoyiNeural','晓伊（女·活泼）','女','edge',1,NOW(),'ok','2026-10-12 生产实测出音频'),
  ('zh-CN-YunxiNeural','云希（男·阳光）','男','edge',1,NOW(),'ok','2026-10-12 生产实测出音频'),
  ('zh-CN-YunjianNeural','云健（男·浑厚）','男','edge',1,NOW(),'ok','2026-10-12 生产实测出音频'),
  ('zh-CN-YunyangNeural','云扬（男·新闻）','男','edge',1,NOW(),'ok','2026-10-12 生产实测出音频'),
  ('zh-CN-XiaochenNeural','晓辰（女·温柔）','女','edge',0,NOW(),'no_audio','2026-10-12 实测零音频帧，端点不提供该音色'),
  ('zh-CN-XiaohanNeural','晓涵（女·知性）','女','edge',0,NOW(),'no_audio','2026-10-12 实测零音频帧，端点不提供该音色'),
  ('zh-CN-XiaomengNeural','晓梦（女·少年感）','女','edge',0,NOW(),'no_audio','2026-10-12 实测零音频帧，端点不提供该音色'),
  ('Tingting','婷婷（普通话·本地）','女','local',1,NULL,NULL,NULL),
  ('Sinji','阿欣（粤语·本地）','女','local',1,NULL,NULL,NULL),
  ('Meijia','美佳（粤语·本地）','女','local',1,NULL,NULL,NULL);
