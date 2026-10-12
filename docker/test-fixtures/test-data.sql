-- Docker 测试栈预置数据（真实词数 8-12，与生成链路约束一致；仅测试库执行）
-- 幂等契约：可重复执行且收敛到本文件声明的状态。含相对日期的三张指标表必须先 DELETE 本 fixture
-- 自己的行再 INSERT——只靠 INSERT IGNORE 时：唯一键含 date 的日表会跨天堆叠（9/28 与 9/30 各跑一次
-- 即得 5 个快照日，钉「3 个快照日」的 E2E 必挂）；唯一键不含 date 的表则永久保留首次运行的旧值
-- 与旧 data_date，使下方「相对值保证 7/30 天窗口内可见」的承诺随时间失效。
INSERT IGNORE INTO contents (id, template, title, level, target_duration, content, words, style, voice, audio, video, status, audit, created_at, updated_at) VALUES
('test0001scene','scene_word','测试：机场英语 错过登机','CET4',60,'[{"text": "This is a generated story sentence using flight in an everyday context.", "words": [{"word": "flight", "meaning": "释义-flight", "level": "CET4"}]}, {"text": "This is a generated story sentence using missed in an everyday context.", "words": [{"word": "missed", "meaning": "释义-missed", "level": "CET4"}]}, {"text": "This is a generated story sentence using reschedule in an everyday context.", "words": [{"word": "reschedule", "meaning": "释义-reschedule", "level": "CET4"}]}, {"text": "This is a generated story sentence using ticket in an everyday context.", "words": [{"word": "ticket", "meaning": "释义-ticket", "level": "CET4"}]}, {"text": "This is a generated story sentence using passport in an everyday context.", "words": [{"word": "passport", "meaning": "释义-passport", "level": "CET4"}]}, {"text": "This is a generated story sentence using boarding in an everyday context.", "words": [{"word": "boarding", "meaning": "释义-boarding", "level": "CET4"}]}, {"text": "This is a generated story sentence using delay in an everyday context.", "words": [{"word": "delay", "meaning": "释义-delay", "level": "CET4"}]}, {"text": "This is a generated story sentence using gate in an everyday context.", "words": [{"word": "gate", "meaning": "释义-gate", "level": "CET4"}]}]','[{"word": "flight", "meaning": "释义-flight", "level": "CET4"}, {"word": "missed", "meaning": "释义-missed", "level": "CET4"}, {"word": "reschedule", "meaning": "释义-reschedule", "level": "CET4"}, {"word": "ticket", "meaning": "释义-ticket", "level": "CET4"}, {"word": "passport", "meaning": "释义-passport", "level": "CET4"}, {"word": "boarding", "meaning": "释义-boarding", "level": "CET4"}, {"word": "delay", "meaning": "释义-delay", "level": "CET4"}, {"word": "gate", "meaning": "释义-gate", "level": "CET4"}]','{}','{}','{"url":"/files/audio/b52537e5-2f1b-4df3-b889-1f61b12ca7bf.mp3","duration":45,"format":"mp3"}','{"url":"/files/video/da40d3dc-4071-4e34-bcb0-4151781021c1.mp4","duration":48,"format":"mp4","introStatus":"rendered"}','completed','{"input": {"topic": "机场英语", "level": "CET4", "wordCount": 8, "targetDuration": 60}, "process": {"candidates": [{"source": "bank", "word": "flight"}, {"source": "bank", "word": "missed"}, {"source": "bank", "word": "reschedule"}, {"source": "bank", "word": "ticket"}, {"source": "bank", "word": "passport"}, {"source": "bank", "word": "boarding"}, {"source": "bank", "word": "delay"}, {"source": "bank", "word": "gate"}, {"source": "bank", "word": "luggage"}, {"source": "bank", "word": "check-in"}, {"source": "bank", "word": "customs"}, {"source": "bank", "word": "arrival"}], "attempts": [{"result": "rejected", "reason": "词超纲"}, {"result": "accepted", "injectedWords": ["flight", "missed", "reschedule", "ticket"]}]}, "modifications": [{"at": "2026-09-21T01:00:00Z", "fields": ["title"]}]}',NOW() - INTERVAL 10 MINUTE,NOW() - INTERVAL 5 MINUTE),
('test0002wordc','word_card','测试：职场高频词 deadline','CET4',45,'[{"word": "deadline", "pos": "n.", "meaning": "释义-deadline", "example": "The deadline matters today."}, {"word": "project", "pos": "n.", "meaning": "释义-project", "example": "The project matters today."}, {"word": "meeting", "pos": "n.", "meaning": "释义-meeting", "example": "The meeting matters today."}, {"word": "report", "pos": "n.", "meaning": "释义-report", "example": "The report matters today."}, {"word": "overtime", "pos": "n.", "meaning": "释义-overtime", "example": "The overtime matters today."}, {"word": "budget", "pos": "n.", "meaning": "释义-budget", "example": "The budget matters today."}, {"word": "client", "pos": "n.", "meaning": "释义-client", "example": "The client matters today."}, {"word": "schedule", "pos": "n.", "meaning": "释义-schedule", "example": "The schedule matters today."}]','[{"word": "deadline", "meaning": "释义-deadline", "level": "CET4"}, {"word": "project", "meaning": "释义-project", "level": "CET4"}, {"word": "meeting", "meaning": "释义-meeting", "level": "CET4"}, {"word": "report", "meaning": "释义-report", "level": "CET4"}, {"word": "overtime", "meaning": "释义-overtime", "level": "CET4"}, {"word": "budget", "meaning": "释义-budget", "level": "CET4"}, {"word": "client", "meaning": "释义-client", "level": "CET4"}, {"word": "schedule", "meaning": "释义-schedule", "level": "CET4"}]','{}','{}',NULL,NULL,'failed','{"input": {"topic": "deadline", "level": "CET4"}, "process": {"attempts": [{"result": "rejected", "reason": "词库校验失败"}]}}',NOW() - INTERVAL 30 MINUTE,NOW() - INTERVAL 2 MINUTE),
('test0003quiz0','quiz','测试：CET6 易错点','CET6',60,'[{"stem": "Choose the wrong word 0: ____", "options": ["abandon", "benefit", "capture", "deliver"], "correctIndex": 0, "explanation": "词义辨析题。", "word": {"word": "abandon", "meaning": "放弃", "level": "CET6"}}, {"stem": "Choose the wrong word 1: ____", "options": ["abandon", "benefit", "capture", "deliver"], "correctIndex": 0, "explanation": "词义辨析题。", "word": {"word": "abandon", "meaning": "放弃", "level": "CET6"}}, {"stem": "Choose the wrong word 2: ____", "options": ["abandon", "benefit", "capture", "deliver"], "correctIndex": 0, "explanation": "词义辨析题。", "word": {"word": "abandon", "meaning": "放弃", "level": "CET6"}}, {"stem": "Choose the wrong word 3: ____", "options": ["abandon", "benefit", "capture", "deliver"], "correctIndex": 0, "explanation": "词义辨析题。", "word": {"word": "abandon", "meaning": "放弃", "level": "CET6"}}, {"stem": "Choose the wrong word 4: ____", "options": ["abandon", "benefit", "capture", "deliver"], "correctIndex": 0, "explanation": "词义辨析题。", "word": {"word": "abandon", "meaning": "放弃", "level": "CET6"}}, {"stem": "Choose the wrong word 5: ____", "options": ["abandon", "benefit", "capture", "deliver"], "correctIndex": 0, "explanation": "词义辨析题。", "word": {"word": "abandon", "meaning": "放弃", "level": "CET6"}}, {"stem": "Choose the wrong word 6: ____", "options": ["abandon", "benefit", "capture", "deliver"], "correctIndex": 0, "explanation": "词义辨析题。", "word": {"word": "abandon", "meaning": "放弃", "level": "CET6"}}, {"stem": "Choose the wrong word 7: ____", "options": ["abandon", "benefit", "capture", "deliver"], "correctIndex": 0, "explanation": "词义辨析题。", "word": {"word": "abandon", "meaning": "放弃", "level": "CET6"}}, {"stem": "Choose the wrong word 8: ____", "options": ["abandon", "benefit", "capture", "deliver"], "correctIndex": 0, "explanation": "词义辨析题。", "word": {"word": "abandon", "meaning": "放弃", "level": "CET6"}}, {"stem": "Choose the wrong word 9: ____", "options": ["abandon", "benefit", "capture", "deliver"], "correctIndex": 0, "explanation": "词义辨析题。", "word": {"word": "abandon", "meaning": "放弃", "level": "CET6"}}]','[{"word": "abandon", "meaning": "释义-abandon", "level": "CET6"}, {"word": "benefit", "meaning": "释义-benefit", "level": "CET6"}, {"word": "capture", "meaning": "释义-capture", "level": "CET6"}, {"word": "deliver", "meaning": "释义-deliver", "level": "CET6"}, {"word": "essence", "meaning": "释义-essence", "level": "CET6"}, {"word": "fragile", "meaning": "释义-fragile", "level": "CET6"}, {"word": "generous", "meaning": "释义-generous", "level": "CET6"}, {"word": "harmony", "meaning": "释义-harmony", "level": "CET6"}, {"word": "instinct", "meaning": "释义-instinct", "level": "CET6"}, {"word": "justice", "meaning": "释义-justice", "level": "CET6"}]','{}','{}','{"url":"/files/audio/test3.mp3","duration":30,"format":"mp3"}',NULL,'audio_ready',NULL,NOW() - INTERVAL 60 MINUTE,NOW() - INTERVAL 50 MINUTE);

-- 数据分析 Phase 2 预置：发布记录（内容 test0001scene 双平台）+ 指标（导入+派生，含每日快照）+ 账号日聚合 + 生产特征
-- 均为 INSERT IGNORE 幂等；日期用相对值保证 7/30 天窗口内可见
INSERT IGNORE INTO publish_records (id, content_id, video_asset_id, platform, platform_video_id, publish_title, publish_time, publish_status, created_at, updated_at) VALUES
('testpub0001douyin','test0001scene','da40d3dc-4071-4e34-bcb0-4151781021c1.mp4','抖音','7432123456789012345','机场英语：错过登机怎么办',NOW(),'published',NOW() - INTERVAL 2 DAY,NOW() - INTERVAL 2 DAY),
('testpub0002kuaishou','test0001scene','da40d3dc-4071-4e34-bcb0-4151781021c1.mp4','快手',NULL,'机场英语（快手未回填作品ID）',NULL,'published',NOW() - INTERVAL 3 DAY,NOW() - INTERVAL 3 DAY);
UPDATE publish_records SET publish_time = DATE_SUB(NOW(), INTERVAL 2 DAY) WHERE id='testpub0001douyin';

DELETE FROM video_metrics WHERE publish_record_id IN ('testpub0001douyin','testpub0002kuaishou');
INSERT IGNORE INTO video_metrics (publish_record_id, metric_name, metric_value, source_type, source_field, data_date, is_estimated, metadata) VALUES
('testpub0001douyin','play_count',12000,'CREATOR_IMPORT','播放量',DATE_FORMAT(NOW(),'%Y-%m-%d'),0,NULL),
('testpub0001douyin','like_count',480,'CREATOR_IMPORT','点赞量',DATE_FORMAT(NOW(),'%Y-%m-%d'),0,NULL),
('testpub0001douyin','comment_count',60,'CREATOR_IMPORT','评论量',DATE_FORMAT(NOW(),'%Y-%m-%d'),0,NULL),
('testpub0001douyin','share_count',30,'CREATOR_IMPORT','分享量',DATE_FORMAT(NOW(),'%Y-%m-%d'),0,NULL),
('testpub0001douyin','collect_count',90,'CREATOR_IMPORT','收藏量',DATE_FORMAT(NOW(),'%Y-%m-%d'),0,NULL),
('testpub0001douyin','bounce_rate_2s',0.18,'CREATOR_IMPORT','2秒跳出率',DATE_FORMAT(NOW(),'%Y-%m-%d'),0,NULL),
('testpub0001douyin','watch_rate_5s',0.62,'CREATOR_IMPORT','5秒完播率',DATE_FORMAT(NOW(),'%Y-%m-%d'),0,NULL),
('testpub0001douyin','avg_watch_time',21.5,'CREATOR_IMPORT','平均播放时长',DATE_FORMAT(NOW(),'%Y-%m-%d'),0,NULL),
('testpub0001douyin','completion_rate',0.36,'CREATOR_IMPORT','完播率',DATE_FORMAT(NOW(),'%Y-%m-%d'),0,NULL),
('testpub0001douyin','profile_visit_count',150,'CREATOR_IMPORT','主页访问数',DATE_FORMAT(NOW(),'%Y-%m-%d'),0,NULL),
('testpub0001douyin','effective_play_rate_2s',0.82,'PLATFORM_CALCULATED',NULL,NULL,0,'{"formula":"1 - bounce_rate_2s"}'),
('testpub0001douyin','like_rate',0.04,'PLATFORM_CALCULATED',NULL,NULL,0,'{"formula":"like_count / play_count"}'),
('testpub0001douyin','comment_rate',0.005,'PLATFORM_CALCULATED',NULL,NULL,0,'{"formula":"comment_count / play_count"}'),
('testpub0001douyin','share_rate',0.0025,'PLATFORM_CALCULATED',NULL,NULL,0,'{"formula":"share_count / play_count"}'),
('testpub0001douyin','engagement_rate',0.0475,'PLATFORM_CALCULATED',NULL,NULL,0,'{"formula":"(like_count + comment_count + share_count) / play_count"}'),
('testpub0001douyin','avg_watch_ratio',0.4479,'PLATFORM_CALCULATED',NULL,NULL,0,'{"formula":"avg_watch_time / 视频时长（production 事实）"}'),
('testpub0001douyin','profile_visit_rate',0.0125,'PLATFORM_CALCULATED',NULL,NULL,0,'{"formula":"profile_visit_count / play_count"}'),
('testpub0002kuaishou','play_count',3000,'CREATOR_IMPORT','播放量',DATE_FORMAT(NOW(),'%Y-%m-%d'),0,NULL);

DELETE FROM video_metric_daily WHERE publish_record_id IN ('testpub0001douyin','testpub0002kuaishou');
INSERT IGNORE INTO video_metric_daily (publish_record_id, metric_name, metric_value, source_type, source_field, data_date, is_estimated) VALUES
('testpub0001douyin','play_count',8000,'CREATOR_IMPORT','播放量',DATE_FORMAT(DATE_SUB(NOW(),INTERVAL 2 DAY),'%Y-%m-%d'),0),
('testpub0001douyin','completion_rate',0.30,'CREATOR_IMPORT','完播率',DATE_FORMAT(DATE_SUB(NOW(),INTERVAL 2 DAY),'%Y-%m-%d'),0),
('testpub0001douyin','play_count',10000,'CREATOR_IMPORT','播放量',DATE_FORMAT(DATE_SUB(NOW(),INTERVAL 1 DAY),'%Y-%m-%d'),0),
('testpub0001douyin','completion_rate',0.33,'CREATOR_IMPORT','完播率',DATE_FORMAT(DATE_SUB(NOW(),INTERVAL 1 DAY),'%Y-%m-%d'),0),
('testpub0001douyin','play_count',12000,'CREATOR_IMPORT','播放量',DATE_FORMAT(NOW(),'%Y-%m-%d'),0),
('testpub0001douyin','completion_rate',0.36,'CREATOR_IMPORT','完播率',DATE_FORMAT(NOW(),'%Y-%m-%d'),0);

DELETE FROM creator_metric_daily WHERE platform = '抖音' AND source_type = 'CREATOR_IMPORT';
INSERT IGNORE INTO creator_metric_daily (platform, stat_date, play_increment, like_increment, comment_increment, share_increment, profile_uv, new_fans, total_fans, source_type) VALUES
('抖音',DATE_FORMAT(DATE_SUB(NOW(),INTERVAL 2 DAY),'%Y-%m-%d'),8000,300,40,15,90,28,8200,'CREATOR_IMPORT'),
('抖音',DATE_FORMAT(DATE_SUB(NOW(),INTERVAL 1 DAY),'%Y-%m-%d'),2000,120,10,10,30,12,8250,'CREATOR_IMPORT'),
('抖音',DATE_FORMAT(NOW(),'%Y-%m-%d'),2000,60,10,5,30,15,8300,'CREATOR_IMPORT');

INSERT IGNORE INTO content_features (content_id, template, level, duration, knowledge_point_count, dialogue_count, segment_count, speech_rate, subtitle_type, shot_count, intro_effect, field_sources) VALUES
('test0001scene','scene_word','CET4',48,8,8,8,1,'burned_in',9,1,'{"template":"PLATFORM_PRODUCTION","level":"PLATFORM_PRODUCTION","duration":"PLATFORM_PRODUCTION","knowledge_point_count":"PLATFORM_PRODUCTION","segment_count":"PLATFORM_PRODUCTION","speech_rate":"PLATFORM_PRODUCTION","subtitle_type":"PLATFORM_PRODUCTION","shot_count":"PLATFORM_PRODUCTION","intro_effect":"PLATFORM_PRODUCTION"}');

-- ── 批次二夹具：把「同平台同指标 ≥8 条非估算真实样本才出参数建议」放到真实页面上跑 ──
-- 18 条小红书样本（8 高 / 10 低），指标按**已提交导入**的形状落库：
-- import_batch(committed) + import_row + match_decision + video_metrics(metadata.batch_id/import_row)，
-- 于是「建议 → 因子快照 → 分组 → 参与视频 → 导入原始行」在真实 HTTP + 真实库上可逐层回放。
-- 两组在 hook / 语速 / 时长带 / 段落数带 / 模板 上同时分化，这五个维度各自都应出一条参数建议；
-- 场景与 CTA 全为未标注 → 按 pickBestGroup 既有纪律不出建议（夹具不绕过门槛）。
-- 这些内容没有成片产物（video 为 NULL）：统一内容视图默认口径不放行，页面 B 行数不变；
-- 时间取 45 天前：落在推荐默认 90 天窗口内、看板 7/30 天窗口外，页面 A 的 15,000 等既有数字不受影响。
DELETE FROM match_decision WHERE batch_id = 'testfixbatch';
DELETE FROM video_metrics WHERE publish_record_id LIKE 'testfixpub%';
DELETE FROM import_row WHERE batch_id = 'testfixbatch';
DELETE FROM import_batch WHERE id = 'testfixbatch';
DELETE FROM content_features WHERE content_id LIKE 'testfix%';
DELETE FROM publish_records WHERE id LIKE 'testfixpub%';
DELETE FROM contents WHERE id LIKE 'testfix%';

INSERT INTO contents (id, template, title, level, target_duration, content, words, style, voice, status, created_at, updated_at) VALUES
('testfix01','scene_word','夹具：疑问句开场高表现 01','CET4',45,'[]','[]','{}','{}','completed',NOW() - INTERVAL 45 DAY,NOW() - INTERVAL 45 DAY),
('testfix02','scene_word','夹具：疑问句开场高表现 02','CET4',45,'[]','[]','{}','{}','completed',NOW() - INTERVAL 45 DAY,NOW() - INTERVAL 45 DAY),
('testfix03','scene_word','夹具：疑问句开场高表现 03','CET4',45,'[]','[]','{}','{}','completed',NOW() - INTERVAL 45 DAY,NOW() - INTERVAL 45 DAY),
('testfix04','scene_word','夹具：疑问句开场高表现 04','CET4',45,'[]','[]','{}','{}','completed',NOW() - INTERVAL 45 DAY,NOW() - INTERVAL 45 DAY),
('testfix05','scene_word','夹具：疑问句开场高表现 05','CET4',45,'[]','[]','{}','{}','completed',NOW() - INTERVAL 45 DAY,NOW() - INTERVAL 45 DAY),
('testfix06','scene_word','夹具：疑问句开场高表现 06','CET4',45,'[]','[]','{}','{}','completed',NOW() - INTERVAL 45 DAY,NOW() - INTERVAL 45 DAY),
('testfix07','scene_word','夹具：疑问句开场高表现 07','CET4',45,'[]','[]','{}','{}','completed',NOW() - INTERVAL 45 DAY,NOW() - INTERVAL 45 DAY),
('testfix08','scene_word','夹具：疑问句开场高表现 08','CET4',45,'[]','[]','{}','{}','completed',NOW() - INTERVAL 45 DAY,NOW() - INTERVAL 45 DAY),
('testfix09','word_card','夹具：平铺开场低表现 09','CET4',75,'[]','[]','{}','{}','completed',NOW() - INTERVAL 45 DAY,NOW() - INTERVAL 45 DAY),
('testfix10','word_card','夹具：平铺开场低表现 10','CET4',75,'[]','[]','{}','{}','completed',NOW() - INTERVAL 45 DAY,NOW() - INTERVAL 45 DAY),
('testfix11','word_card','夹具：平铺开场低表现 11','CET4',75,'[]','[]','{}','{}','completed',NOW() - INTERVAL 45 DAY,NOW() - INTERVAL 45 DAY),
('testfix12','word_card','夹具：平铺开场低表现 12','CET4',75,'[]','[]','{}','{}','completed',NOW() - INTERVAL 45 DAY,NOW() - INTERVAL 45 DAY),
('testfix13','word_card','夹具：平铺开场低表现 13','CET4',75,'[]','[]','{}','{}','completed',NOW() - INTERVAL 45 DAY,NOW() - INTERVAL 45 DAY),
('testfix14','word_card','夹具：平铺开场低表现 14','CET4',75,'[]','[]','{}','{}','completed',NOW() - INTERVAL 45 DAY,NOW() - INTERVAL 45 DAY),
('testfix15','word_card','夹具：平铺开场低表现 15','CET4',75,'[]','[]','{}','{}','completed',NOW() - INTERVAL 45 DAY,NOW() - INTERVAL 45 DAY),
('testfix16','word_card','夹具：平铺开场低表现 16','CET4',75,'[]','[]','{}','{}','completed',NOW() - INTERVAL 45 DAY,NOW() - INTERVAL 45 DAY),
('testfix17','word_card','夹具：平铺开场低表现 17','CET4',75,'[]','[]','{}','{}','completed',NOW() - INTERVAL 45 DAY,NOW() - INTERVAL 45 DAY),
('testfix18','word_card','夹具：平铺开场低表现 18','CET4',75,'[]','[]','{}','{}','completed',NOW() - INTERVAL 45 DAY,NOW() - INTERVAL 45 DAY);

INSERT INTO publish_records (id, content_id, video_asset_id, platform, platform_video_id, publish_title, publish_time, publish_time_source, publish_status, created_at, updated_at) VALUES
('testfixpub01','testfix01',NULL,'小红书','749900000000000001','夹具发布 01',NOW() - INTERVAL 45 DAY,'PLATFORM_IMPORTED','published',NOW() - INTERVAL 45 DAY,NOW() - INTERVAL 45 DAY),
('testfixpub02','testfix02',NULL,'小红书','749900000000000002','夹具发布 02',NOW() - INTERVAL 45 DAY,'PLATFORM_IMPORTED','published',NOW() - INTERVAL 45 DAY,NOW() - INTERVAL 45 DAY),
('testfixpub03','testfix03',NULL,'小红书','749900000000000003','夹具发布 03',NOW() - INTERVAL 45 DAY,'PLATFORM_IMPORTED','published',NOW() - INTERVAL 45 DAY,NOW() - INTERVAL 45 DAY),
('testfixpub04','testfix04',NULL,'小红书','749900000000000004','夹具发布 04',NOW() - INTERVAL 45 DAY,'PLATFORM_IMPORTED','published',NOW() - INTERVAL 45 DAY,NOW() - INTERVAL 45 DAY),
('testfixpub05','testfix05',NULL,'小红书','749900000000000005','夹具发布 05',NOW() - INTERVAL 45 DAY,'PLATFORM_IMPORTED','published',NOW() - INTERVAL 45 DAY,NOW() - INTERVAL 45 DAY),
('testfixpub06','testfix06',NULL,'小红书','749900000000000006','夹具发布 06',NOW() - INTERVAL 45 DAY,'PLATFORM_IMPORTED','published',NOW() - INTERVAL 45 DAY,NOW() - INTERVAL 45 DAY),
('testfixpub07','testfix07',NULL,'小红书','749900000000000007','夹具发布 07',NOW() - INTERVAL 45 DAY,'PLATFORM_IMPORTED','published',NOW() - INTERVAL 45 DAY,NOW() - INTERVAL 45 DAY),
('testfixpub08','testfix08',NULL,'小红书','749900000000000008','夹具发布 08',NOW() - INTERVAL 45 DAY,'PLATFORM_IMPORTED','published',NOW() - INTERVAL 45 DAY,NOW() - INTERVAL 45 DAY),
('testfixpub09','testfix09',NULL,'小红书','749900000000000009','夹具发布 09',NOW() - INTERVAL 45 DAY,'PLATFORM_IMPORTED','published',NOW() - INTERVAL 45 DAY,NOW() - INTERVAL 45 DAY),
('testfixpub10','testfix10',NULL,'小红书','749900000000000010','夹具发布 10',NOW() - INTERVAL 45 DAY,'PLATFORM_IMPORTED','published',NOW() - INTERVAL 45 DAY,NOW() - INTERVAL 45 DAY),
('testfixpub11','testfix11',NULL,'小红书','749900000000000011','夹具发布 11',NOW() - INTERVAL 45 DAY,'PLATFORM_IMPORTED','published',NOW() - INTERVAL 45 DAY,NOW() - INTERVAL 45 DAY),
('testfixpub12','testfix12',NULL,'小红书','749900000000000012','夹具发布 12',NOW() - INTERVAL 45 DAY,'PLATFORM_IMPORTED','published',NOW() - INTERVAL 45 DAY,NOW() - INTERVAL 45 DAY),
('testfixpub13','testfix13',NULL,'小红书','749900000000000013','夹具发布 13',NOW() - INTERVAL 45 DAY,'PLATFORM_IMPORTED','published',NOW() - INTERVAL 45 DAY,NOW() - INTERVAL 45 DAY),
('testfixpub14','testfix14',NULL,'小红书','749900000000000014','夹具发布 14',NOW() - INTERVAL 45 DAY,'PLATFORM_IMPORTED','published',NOW() - INTERVAL 45 DAY,NOW() - INTERVAL 45 DAY),
('testfixpub15','testfix15',NULL,'小红书','749900000000000015','夹具发布 15',NOW() - INTERVAL 45 DAY,'PLATFORM_IMPORTED','published',NOW() - INTERVAL 45 DAY,NOW() - INTERVAL 45 DAY),
('testfixpub16','testfix16',NULL,'小红书','749900000000000016','夹具发布 16',NOW() - INTERVAL 45 DAY,'PLATFORM_IMPORTED','published',NOW() - INTERVAL 45 DAY,NOW() - INTERVAL 45 DAY),
('testfixpub17','testfix17',NULL,'小红书','749900000000000017','夹具发布 17',NOW() - INTERVAL 45 DAY,'PLATFORM_IMPORTED','published',NOW() - INTERVAL 45 DAY,NOW() - INTERVAL 45 DAY),
('testfixpub18','testfix18',NULL,'小红书','749900000000000018','夹具发布 18',NOW() - INTERVAL 45 DAY,'PLATFORM_IMPORTED','published',NOW() - INTERVAL 45 DAY,NOW() - INTERVAL 45 DAY);

INSERT INTO content_features (content_id, template, level, duration, segment_count, knowledge_point_count, speech_rate, hook, field_sources) VALUES
('testfix01','scene_word','CET4',45,6,6,1.15,'question','{"template":"PLATFORM_PRODUCTION","level":"PLATFORM_PRODUCTION","duration":"PLATFORM_PRODUCTION","segment_count":"PLATFORM_PRODUCTION","speech_rate":"PLATFORM_PRODUCTION","knowledge_point_count":"PLATFORM_PRODUCTION","hook":"USER_INPUT"}'),
('testfix02','scene_word','CET4',45,6,6,1.15,'question','{"template":"PLATFORM_PRODUCTION","level":"PLATFORM_PRODUCTION","duration":"PLATFORM_PRODUCTION","segment_count":"PLATFORM_PRODUCTION","speech_rate":"PLATFORM_PRODUCTION","knowledge_point_count":"PLATFORM_PRODUCTION","hook":"USER_INPUT"}'),
('testfix03','scene_word','CET4',45,6,6,1.15,'question','{"template":"PLATFORM_PRODUCTION","level":"PLATFORM_PRODUCTION","duration":"PLATFORM_PRODUCTION","segment_count":"PLATFORM_PRODUCTION","speech_rate":"PLATFORM_PRODUCTION","knowledge_point_count":"PLATFORM_PRODUCTION","hook":"USER_INPUT"}'),
('testfix04','scene_word','CET4',45,6,6,1.15,'question','{"template":"PLATFORM_PRODUCTION","level":"PLATFORM_PRODUCTION","duration":"PLATFORM_PRODUCTION","segment_count":"PLATFORM_PRODUCTION","speech_rate":"PLATFORM_PRODUCTION","knowledge_point_count":"PLATFORM_PRODUCTION","hook":"USER_INPUT"}'),
('testfix05','scene_word','CET4',45,6,6,1.15,'question','{"template":"PLATFORM_PRODUCTION","level":"PLATFORM_PRODUCTION","duration":"PLATFORM_PRODUCTION","segment_count":"PLATFORM_PRODUCTION","speech_rate":"PLATFORM_PRODUCTION","knowledge_point_count":"PLATFORM_PRODUCTION","hook":"USER_INPUT"}'),
('testfix06','scene_word','CET4',45,6,6,1.15,'question','{"template":"PLATFORM_PRODUCTION","level":"PLATFORM_PRODUCTION","duration":"PLATFORM_PRODUCTION","segment_count":"PLATFORM_PRODUCTION","speech_rate":"PLATFORM_PRODUCTION","knowledge_point_count":"PLATFORM_PRODUCTION","hook":"USER_INPUT"}'),
('testfix07','scene_word','CET4',45,6,6,1.15,'question','{"template":"PLATFORM_PRODUCTION","level":"PLATFORM_PRODUCTION","duration":"PLATFORM_PRODUCTION","segment_count":"PLATFORM_PRODUCTION","speech_rate":"PLATFORM_PRODUCTION","knowledge_point_count":"PLATFORM_PRODUCTION","hook":"USER_INPUT"}'),
('testfix08','scene_word','CET4',45,6,6,1.15,'question','{"template":"PLATFORM_PRODUCTION","level":"PLATFORM_PRODUCTION","duration":"PLATFORM_PRODUCTION","segment_count":"PLATFORM_PRODUCTION","speech_rate":"PLATFORM_PRODUCTION","knowledge_point_count":"PLATFORM_PRODUCTION","hook":"USER_INPUT"}'),
('testfix09','word_card','CET4',75,14,14,0.95,'mistake','{"template":"PLATFORM_PRODUCTION","level":"PLATFORM_PRODUCTION","duration":"PLATFORM_PRODUCTION","segment_count":"PLATFORM_PRODUCTION","speech_rate":"PLATFORM_PRODUCTION","knowledge_point_count":"PLATFORM_PRODUCTION","hook":"USER_INPUT"}'),
('testfix10','word_card','CET4',75,14,14,0.95,'mistake','{"template":"PLATFORM_PRODUCTION","level":"PLATFORM_PRODUCTION","duration":"PLATFORM_PRODUCTION","segment_count":"PLATFORM_PRODUCTION","speech_rate":"PLATFORM_PRODUCTION","knowledge_point_count":"PLATFORM_PRODUCTION","hook":"USER_INPUT"}'),
('testfix11','word_card','CET4',75,14,14,0.95,'mistake','{"template":"PLATFORM_PRODUCTION","level":"PLATFORM_PRODUCTION","duration":"PLATFORM_PRODUCTION","segment_count":"PLATFORM_PRODUCTION","speech_rate":"PLATFORM_PRODUCTION","knowledge_point_count":"PLATFORM_PRODUCTION","hook":"USER_INPUT"}'),
('testfix12','word_card','CET4',75,14,14,0.95,'mistake','{"template":"PLATFORM_PRODUCTION","level":"PLATFORM_PRODUCTION","duration":"PLATFORM_PRODUCTION","segment_count":"PLATFORM_PRODUCTION","speech_rate":"PLATFORM_PRODUCTION","knowledge_point_count":"PLATFORM_PRODUCTION","hook":"USER_INPUT"}'),
('testfix13','word_card','CET4',75,14,14,0.95,'mistake','{"template":"PLATFORM_PRODUCTION","level":"PLATFORM_PRODUCTION","duration":"PLATFORM_PRODUCTION","segment_count":"PLATFORM_PRODUCTION","speech_rate":"PLATFORM_PRODUCTION","knowledge_point_count":"PLATFORM_PRODUCTION","hook":"USER_INPUT"}'),
('testfix14','word_card','CET4',75,14,14,0.95,'mistake','{"template":"PLATFORM_PRODUCTION","level":"PLATFORM_PRODUCTION","duration":"PLATFORM_PRODUCTION","segment_count":"PLATFORM_PRODUCTION","speech_rate":"PLATFORM_PRODUCTION","knowledge_point_count":"PLATFORM_PRODUCTION","hook":"USER_INPUT"}'),
('testfix15','word_card','CET4',75,14,14,0.95,'mistake','{"template":"PLATFORM_PRODUCTION","level":"PLATFORM_PRODUCTION","duration":"PLATFORM_PRODUCTION","segment_count":"PLATFORM_PRODUCTION","speech_rate":"PLATFORM_PRODUCTION","knowledge_point_count":"PLATFORM_PRODUCTION","hook":"USER_INPUT"}'),
('testfix16','word_card','CET4',75,14,14,0.95,'mistake','{"template":"PLATFORM_PRODUCTION","level":"PLATFORM_PRODUCTION","duration":"PLATFORM_PRODUCTION","segment_count":"PLATFORM_PRODUCTION","speech_rate":"PLATFORM_PRODUCTION","knowledge_point_count":"PLATFORM_PRODUCTION","hook":"USER_INPUT"}'),
('testfix17','word_card','CET4',75,14,14,0.95,'mistake','{"template":"PLATFORM_PRODUCTION","level":"PLATFORM_PRODUCTION","duration":"PLATFORM_PRODUCTION","segment_count":"PLATFORM_PRODUCTION","speech_rate":"PLATFORM_PRODUCTION","knowledge_point_count":"PLATFORM_PRODUCTION","hook":"USER_INPUT"}'),
('testfix18','word_card','CET4',75,14,14,0.95,'mistake','{"template":"PLATFORM_PRODUCTION","level":"PLATFORM_PRODUCTION","duration":"PLATFORM_PRODUCTION","segment_count":"PLATFORM_PRODUCTION","speech_rate":"PLATFORM_PRODUCTION","knowledge_point_count":"PLATFORM_PRODUCTION","hook":"USER_INPUT"}');

INSERT INTO import_batch (id, filename, file_size, file_hash, platform, row_count, data_granularity, granularity_evidence, headers, field_detection, status)
VALUES ('testfixbatch','小红书创作者后台_导入夹具.csv',2048,'testfix-import-hash','小红书',18,'work_level_strong',
        JSON_OBJECT('basis','作品ID 列存在且 18 行全部非空'), JSON_ARRAY('作品ID','完播率'), JSON_ARRAY(), 'committed');

INSERT INTO import_row (batch_id, `row_number`, raw_data, normalized_data, data_granularity, match_status) VALUES
('testfixbatch',1,JSON_OBJECT('作品ID','749900000000000001','完播率','50%'),JSON_OBJECT('completion_rate',0.50),'work_level_strong','confirmed'),
('testfixbatch',2,JSON_OBJECT('作品ID','749900000000000002','完播率','51%'),JSON_OBJECT('completion_rate',0.51),'work_level_strong','confirmed'),
('testfixbatch',3,JSON_OBJECT('作品ID','749900000000000003','完播率','52%'),JSON_OBJECT('completion_rate',0.52),'work_level_strong','confirmed'),
('testfixbatch',4,JSON_OBJECT('作品ID','749900000000000004','完播率','53%'),JSON_OBJECT('completion_rate',0.53),'work_level_strong','confirmed'),
('testfixbatch',5,JSON_OBJECT('作品ID','749900000000000005','完播率','54%'),JSON_OBJECT('completion_rate',0.54),'work_level_strong','confirmed'),
('testfixbatch',6,JSON_OBJECT('作品ID','749900000000000006','完播率','55%'),JSON_OBJECT('completion_rate',0.55),'work_level_strong','confirmed'),
('testfixbatch',7,JSON_OBJECT('作品ID','749900000000000007','完播率','56%'),JSON_OBJECT('completion_rate',0.56),'work_level_strong','confirmed'),
('testfixbatch',8,JSON_OBJECT('作品ID','749900000000000008','完播率','57%'),JSON_OBJECT('completion_rate',0.57),'work_level_strong','confirmed'),
('testfixbatch',9,JSON_OBJECT('作品ID','749900000000000009','完播率','20%'),JSON_OBJECT('completion_rate',0.20),'work_level_strong','confirmed'),
('testfixbatch',10,JSON_OBJECT('作品ID','749900000000000010','完播率','21%'),JSON_OBJECT('completion_rate',0.21),'work_level_strong','confirmed'),
('testfixbatch',11,JSON_OBJECT('作品ID','749900000000000011','完播率','22%'),JSON_OBJECT('completion_rate',0.22),'work_level_strong','confirmed'),
('testfixbatch',12,JSON_OBJECT('作品ID','749900000000000012','完播率','23%'),JSON_OBJECT('completion_rate',0.23),'work_level_strong','confirmed'),
('testfixbatch',13,JSON_OBJECT('作品ID','749900000000000013','完播率','24%'),JSON_OBJECT('completion_rate',0.24),'work_level_strong','confirmed'),
('testfixbatch',14,JSON_OBJECT('作品ID','749900000000000014','完播率','25%'),JSON_OBJECT('completion_rate',0.25),'work_level_strong','confirmed'),
('testfixbatch',15,JSON_OBJECT('作品ID','749900000000000015','完播率','26%'),JSON_OBJECT('completion_rate',0.26),'work_level_strong','confirmed'),
('testfixbatch',16,JSON_OBJECT('作品ID','749900000000000016','完播率','27%'),JSON_OBJECT('completion_rate',0.27),'work_level_strong','confirmed'),
('testfixbatch',17,JSON_OBJECT('作品ID','749900000000000017','完播率','28%'),JSON_OBJECT('completion_rate',0.28),'work_level_strong','confirmed'),
('testfixbatch',18,JSON_OBJECT('作品ID','749900000000000018','完播率','29%'),JSON_OBJECT('completion_rate',0.29),'work_level_strong','confirmed');

INSERT INTO video_metrics (publish_record_id, metric_name, metric_value, source_type, source_field, data_date, is_estimated, metadata) VALUES
('testfixpub01','completion_rate',0.50,'CREATOR_IMPORT','完播率',DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 45 DAY), '%Y-%m-%d'),0,'{"batch_id":"testfixbatch","import_row":1,"matched_by":"platform_work_id_exact"}'),
('testfixpub02','completion_rate',0.51,'CREATOR_IMPORT','完播率',DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 45 DAY), '%Y-%m-%d'),0,'{"batch_id":"testfixbatch","import_row":2,"matched_by":"platform_work_id_exact"}'),
('testfixpub03','completion_rate',0.52,'CREATOR_IMPORT','完播率',DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 45 DAY), '%Y-%m-%d'),0,'{"batch_id":"testfixbatch","import_row":3,"matched_by":"platform_work_id_exact"}'),
('testfixpub04','completion_rate',0.53,'CREATOR_IMPORT','完播率',DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 45 DAY), '%Y-%m-%d'),0,'{"batch_id":"testfixbatch","import_row":4,"matched_by":"platform_work_id_exact"}'),
('testfixpub05','completion_rate',0.54,'CREATOR_IMPORT','完播率',DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 45 DAY), '%Y-%m-%d'),0,'{"batch_id":"testfixbatch","import_row":5,"matched_by":"platform_work_id_exact"}'),
('testfixpub06','completion_rate',0.55,'CREATOR_IMPORT','完播率',DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 45 DAY), '%Y-%m-%d'),0,'{"batch_id":"testfixbatch","import_row":6,"matched_by":"platform_work_id_exact"}'),
('testfixpub07','completion_rate',0.56,'CREATOR_IMPORT','完播率',DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 45 DAY), '%Y-%m-%d'),0,'{"batch_id":"testfixbatch","import_row":7,"matched_by":"platform_work_id_exact"}'),
('testfixpub08','completion_rate',0.57,'CREATOR_IMPORT','完播率',DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 45 DAY), '%Y-%m-%d'),0,'{"batch_id":"testfixbatch","import_row":8,"matched_by":"platform_work_id_exact"}'),
('testfixpub09','completion_rate',0.20,'CREATOR_IMPORT','完播率',DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 45 DAY), '%Y-%m-%d'),0,'{"batch_id":"testfixbatch","import_row":9,"matched_by":"platform_work_id_exact"}'),
('testfixpub10','completion_rate',0.21,'CREATOR_IMPORT','完播率',DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 45 DAY), '%Y-%m-%d'),0,'{"batch_id":"testfixbatch","import_row":10,"matched_by":"platform_work_id_exact"}'),
('testfixpub11','completion_rate',0.22,'CREATOR_IMPORT','完播率',DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 45 DAY), '%Y-%m-%d'),0,'{"batch_id":"testfixbatch","import_row":11,"matched_by":"platform_work_id_exact"}'),
('testfixpub12','completion_rate',0.23,'CREATOR_IMPORT','完播率',DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 45 DAY), '%Y-%m-%d'),0,'{"batch_id":"testfixbatch","import_row":12,"matched_by":"platform_work_id_exact"}'),
('testfixpub13','completion_rate',0.24,'CREATOR_IMPORT','完播率',DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 45 DAY), '%Y-%m-%d'),0,'{"batch_id":"testfixbatch","import_row":13,"matched_by":"platform_work_id_exact"}'),
('testfixpub14','completion_rate',0.25,'CREATOR_IMPORT','完播率',DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 45 DAY), '%Y-%m-%d'),0,'{"batch_id":"testfixbatch","import_row":14,"matched_by":"platform_work_id_exact"}'),
('testfixpub15','completion_rate',0.26,'CREATOR_IMPORT','完播率',DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 45 DAY), '%Y-%m-%d'),0,'{"batch_id":"testfixbatch","import_row":15,"matched_by":"platform_work_id_exact"}'),
('testfixpub16','completion_rate',0.27,'CREATOR_IMPORT','完播率',DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 45 DAY), '%Y-%m-%d'),0,'{"batch_id":"testfixbatch","import_row":16,"matched_by":"platform_work_id_exact"}'),
('testfixpub17','completion_rate',0.28,'CREATOR_IMPORT','完播率',DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 45 DAY), '%Y-%m-%d'),0,'{"batch_id":"testfixbatch","import_row":17,"matched_by":"platform_work_id_exact"}'),
('testfixpub18','completion_rate',0.29,'CREATOR_IMPORT','完播率',DATE_FORMAT(DATE_SUB(NOW(), INTERVAL 45 DAY), '%Y-%m-%d'),0,'{"batch_id":"testfixbatch","import_row":18,"matched_by":"platform_work_id_exact"}');

INSERT INTO match_decision (import_row_id, batch_id, match_status, matched_video_id, match_method, decision_type, operator) VALUES
((SELECT id FROM import_row WHERE batch_id='testfixbatch' AND `row_number`=1),'testfixbatch','confirmed','testfixpub01','platform_work_id_exact','operator_confirm','local'),
((SELECT id FROM import_row WHERE batch_id='testfixbatch' AND `row_number`=2),'testfixbatch','confirmed','testfixpub02','platform_work_id_exact','operator_confirm','local'),
((SELECT id FROM import_row WHERE batch_id='testfixbatch' AND `row_number`=3),'testfixbatch','confirmed','testfixpub03','platform_work_id_exact','operator_confirm','local'),
((SELECT id FROM import_row WHERE batch_id='testfixbatch' AND `row_number`=4),'testfixbatch','confirmed','testfixpub04','platform_work_id_exact','operator_confirm','local'),
((SELECT id FROM import_row WHERE batch_id='testfixbatch' AND `row_number`=5),'testfixbatch','confirmed','testfixpub05','platform_work_id_exact','operator_confirm','local'),
((SELECT id FROM import_row WHERE batch_id='testfixbatch' AND `row_number`=6),'testfixbatch','confirmed','testfixpub06','platform_work_id_exact','operator_confirm','local'),
((SELECT id FROM import_row WHERE batch_id='testfixbatch' AND `row_number`=7),'testfixbatch','confirmed','testfixpub07','platform_work_id_exact','operator_confirm','local'),
((SELECT id FROM import_row WHERE batch_id='testfixbatch' AND `row_number`=8),'testfixbatch','confirmed','testfixpub08','platform_work_id_exact','operator_confirm','local'),
((SELECT id FROM import_row WHERE batch_id='testfixbatch' AND `row_number`=9),'testfixbatch','confirmed','testfixpub09','platform_work_id_exact','operator_confirm','local'),
((SELECT id FROM import_row WHERE batch_id='testfixbatch' AND `row_number`=10),'testfixbatch','confirmed','testfixpub10','platform_work_id_exact','operator_confirm','local'),
((SELECT id FROM import_row WHERE batch_id='testfixbatch' AND `row_number`=11),'testfixbatch','confirmed','testfixpub11','platform_work_id_exact','operator_confirm','local'),
((SELECT id FROM import_row WHERE batch_id='testfixbatch' AND `row_number`=12),'testfixbatch','confirmed','testfixpub12','platform_work_id_exact','operator_confirm','local'),
((SELECT id FROM import_row WHERE batch_id='testfixbatch' AND `row_number`=13),'testfixbatch','confirmed','testfixpub13','platform_work_id_exact','operator_confirm','local'),
((SELECT id FROM import_row WHERE batch_id='testfixbatch' AND `row_number`=14),'testfixbatch','confirmed','testfixpub14','platform_work_id_exact','operator_confirm','local'),
((SELECT id FROM import_row WHERE batch_id='testfixbatch' AND `row_number`=15),'testfixbatch','confirmed','testfixpub15','platform_work_id_exact','operator_confirm','local'),
((SELECT id FROM import_row WHERE batch_id='testfixbatch' AND `row_number`=16),'testfixbatch','confirmed','testfixpub16','platform_work_id_exact','operator_confirm','local'),
((SELECT id FROM import_row WHERE batch_id='testfixbatch' AND `row_number`=17),'testfixbatch','confirmed','testfixpub17','platform_work_id_exact','operator_confirm','local'),
((SELECT id FROM import_row WHERE batch_id='testfixbatch' AND `row_number`=18),'testfixbatch','confirmed','testfixpub18','platform_work_id_exact','operator_confirm','local');

-- ── 批次三夹具：一条可分配的 draft 实验 + 分配台账（1 已绑定 / 2 未绑定），另加一条已取消的实验 ──
-- 用途：让「评估以生成前分配为准」与「新建页只列可分配实验」在真实页面上可断言，
-- 且 E2E 自己不发写请求（台账状态由夹具固定，重复灌库收敛到同一形状）。
-- 已取消那条用来钉反例：选择器不得把它列成可参与对象。
DELETE FROM experiment_assignments WHERE experiment_id IN ('testexpdraft1', 'testexpcancel');
DELETE FROM experiments WHERE id IN ('testexpdraft1', 'testexpcancel');
INSERT INTO experiments (id, variable, variant_a, variant_b, control_variables, target_metric, status, created_at, updated_at) VALUES
('testexpdraft1','hook',JSON_OBJECT('label','提问','contentIds',JSON_ARRAY('test0001scene')),JSON_OBJECT('label','平铺','contentIds',JSON_ARRAY()),JSON_OBJECT('note','同一账号同窗口，只差开场方式'),'completion_rate','draft',NOW() - INTERVAL 3 DAY,NOW() - INTERVAL 3 DAY),
('testexpcancel','template',JSON_OBJECT('label','情景背词','contentIds',JSON_ARRAY()),JSON_OBJECT('label','单词卡片','contentIds',JSON_ARRAY()),NULL,'completion_rate','cancelled',NOW() - INTERVAL 3 DAY,NOW() - INTERVAL 3 DAY);

INSERT INTO experiment_assignments (id, experiment_id, content_id, variant, assignment_method, assigned_params, final_params, assigned_at, bound_at, created_at, updated_at) VALUES
('testexpa1','testexpdraft1','test0001scene','A','operator_selected',JSON_OBJECT('variable','hook','variantLabel','提问'),JSON_OBJECT('generation',JSON_OBJECT('template','scene_word','level','CET4')),NOW() - INTERVAL 2 DAY,NOW() - INTERVAL 2 DAY,NOW() - INTERVAL 2 DAY,NOW() - INTERVAL 2 DAY),
('testexpa2','testexpdraft1',NULL,'B','operator_selected',JSON_OBJECT('variable','hook','variantLabel','平铺'),NULL,NOW() - INTERVAL 1 DAY,NULL,NOW() - INTERVAL 1 DAY,NOW() - INTERVAL 1 DAY),
('testexpa3','testexpdraft1',NULL,'B','operator_selected',JSON_OBJECT('variable','hook','variantLabel','平铺'),NULL,NOW(),NULL,NOW(),NOW());
