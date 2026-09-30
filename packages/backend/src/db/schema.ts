// Drizzle ORM 表定义
// 表结构详见 SPEC.md §十

import {
  date,
  datetime,
  double,
  float,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import { METRIC_SOURCE_TYPES } from "../lib/analytics-taxonomy";

// ── 视频内容表 ──
export const contents = mysqlTable(
  "contents",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    template: mysqlEnum("template", ["scene_word", "word_card", "quiz"]).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    level: mysqlEnum("level", ["CET4", "CET6"]).notNull(),
    targetDuration: int("target_duration").notNull(),
    content: json("content").notNull(),
    words: json("words").notNull(),
    style: json("style").notNull(),
    voice: json("voice").notNull(),
    audio: json("audio"),
    video: json("video"),
    /** 生成审计档案（PRD 10.1.4）：输入/候选词/重试历史/修改日志 */
    audit: json("audit"),
    status: mysqlEnum("status", [
      "draft",
      "ai_generating",
      "content_ready",
      "tts_processing",
      "audio_ready",
      "video_rendering",
      "completed",
      "failed",
    ])
      .notNull()
      .default("draft"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => [index("idx_status").on(table.status)],
);

// ── 视频上传标记表 ──
// 表示某个视频文件已上传到外部平台（一个视频可多条标记，即多个平台）
export const uploadMarks = mysqlTable(
  "upload_marks",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    /** 关联的任务 id（contents 表；重新渲染后文件名变化，标记按任务归属保证一致） */
    taskId: varchar("task_id", { length: 32 }),
    /** 关联的视频文件名（uploads/video/ 下的文件名，如 xxx.mp4） */
    videoFilename: varchar("video_filename", { length: 100 }).notNull(),
    /** 上传平台（前端下拉：抖音/小红书/视频号/B站/快手/其他；存 varchar 不锁死枚举，加平台免迁移） */
    platform: varchar("platform", { length: 50 }).notNull(),
    /** 作品链接（可选） */
    url: varchar("url", { length: 500 }),
    /** 备注（可选） */
    note: varchar("note", { length: 500 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    index("idx_upload_marks_video_filename").on(table.videoFilename),
    index("idx_upload_marks_task_id").on(table.taskId),
  ],
);

// ── 视频分析/发布元数据表 ──
// 与 contents 解耦，避免改变既有 ContentDTO；一条内容最多一份分析配置。
export const videoAnalytics = mysqlTable("video_analytics", {
  contentId: varchar("content_id", { length: 32 })
    .primaryKey()
    .references(() => contents.id, { onDelete: "cascade" }),
  storyTopic: varchar("story_topic", { length: 255 }),
  // mode:"date" 保 JS Date 语义（与既有 toISOString/insert 代码一致）；datetime 免 timestamp 2038 上限与会话时区隐式转换
  publishAt: datetime("publish_at", { mode: "date" }),
  coverUrl: varchar("cover_url", { length: 500 }),
  allowSave: int("allow_save").notNull().default(0),
  customParams: json("custom_params"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
});

// ── 四六级词库表 ──
export const cetWords = mysqlTable(
  "cet_words",
  {
    id: int("id").autoincrement().primaryKey(),
    word: varchar("word", { length: 100 }).notNull(),
    meaning: varchar("meaning", { length: 500 }).notNull(),
    level: mysqlEnum("level", ["CET4", "CET6"]).notNull(),
    frequency: float("frequency").default(0),
  },
  (table) => [index("idx_level_freq").on(table.level, table.frequency)],
);

// ══ 以下为视频数据分析模块表（docs/17，migration 0007）══

// ── 发布记录表：生产→发布→分析的统一 ID 链路中枢（需求 §七） ──
// 平台侧作品 ID 与 platform 构成唯一约束；禁止按标题模糊匹配维护关系。
export const publishRecords = mysqlTable(
  "publish_records",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    contentId: varchar("content_id", { length: 32 })
      .notNull()
      .references(() => contents.id, { onDelete: "cascade" }),
    /** 视频资产标识 = uploads/video/ 下文件名（contents.video.url 的 basename） */
    videoAssetId: varchar("video_asset_id", { length: 100 }),
    /** 发布平台（抖音/快手/…；与 upload_marks.platform 同口径自由文本，加平台免迁移） */
    platform: varchar("platform", { length: 50 }).notNull(),
    /** 平台侧作品 ID（抖音 = item_id）；导入匹配与 sync 的主键 */
    platformVideoId: varchar("platform_video_id", { length: 100 }),
    publishTitle: varchar("publish_title", { length: 255 }),
    publishTime: datetime("publish_time", { mode: "date" }),
    coverUrl: varchar("cover_url", { length: 500 }),
    publishStatus: mysqlEnum("publish_status", ["scheduled", "published", "deleted"])
      .notNull()
      .default("published"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    index("idx_publish_records_content_id").on(table.contentId),
    uniqueIndex("uq_publish_records_platform_video").on(table.platform, table.platformVideoId),
  ],
);

// ── 视频指标表（最新值）：每个值必须携带完整 provenance（需求 §六） ──
export const videoMetrics = mysqlTable(
  "video_metrics",
  {
    id: int("id").autoincrement().primaryKey(),
    publishRecordId: varchar("publish_record_id", { length: 32 })
      .notNull()
      .references(() => publishRecords.id, { onDelete: "cascade" }),
    /** canonical 指标名（lib/analytics-taxonomy 注册表，不写死外部字段） */
    metricName: varchar("metric_name", { length: 64 }).notNull(),
    metricValue: double("metric_value").notNull(),
    sourceType: mysqlEnum("source_type", METRIC_SOURCE_TYPES).notNull(),
    /** 来源原始字段名（如抖音导出列名），供溯源展示 */
    sourceField: varchar("source_field", { length: 100 }),
    /** 数据所属日期（累计值可为空；string 模式免会话时区转换，直接存 YYYY-MM-DD） */
    dataDate: date("data_date", { mode: "string" }),
    fetchedAt: timestamp("fetched_at").notNull().defaultNow(),
    /** 估算值标记（0/1）：账号级粉丝归因等必须置 1，不得伪装真实归因 */
    isEstimated: int("is_estimated").notNull().default(0),
    confidence: float("confidence"),
    metadata: json("metadata"),
  },
  (table) => [
    uniqueIndex("uq_video_metrics_record_name").on(table.publishRecordId, table.metricName),
    index("idx_video_metrics_record").on(table.publishRecordId),
  ],
);

// ── 视频指标每日快照：支持 D0/D1/D2/D3/D7/D14/D30 增长观察（需求 §八.3） ──
export const videoMetricDaily = mysqlTable(
  "video_metric_daily",
  {
    id: int("id").autoincrement().primaryKey(),
    publishRecordId: varchar("publish_record_id", { length: 32 })
      .notNull()
      .references(() => publishRecords.id, { onDelete: "cascade" }),
    metricName: varchar("metric_name", { length: 64 }).notNull(),
    metricValue: double("metric_value").notNull(),
    sourceType: mysqlEnum("source_type", METRIC_SOURCE_TYPES).notNull(),
    sourceField: varchar("source_field", { length: 100 }),
    /** 快照日（必填，故列不空；string 模式存 YYYY-MM-DD） */
    dataDate: date("data_date", { mode: "string" }).notNull(),
    fetchedAt: timestamp("fetched_at").notNull().defaultNow(),
    isEstimated: int("is_estimated").notNull().default(0),
    confidence: float("confidence"),
    metadata: json("metadata"),
  },
  (table) => [
    uniqueIndex("uq_video_metric_daily_record_name_date").on(
      table.publishRecordId,
      table.metricName,
      table.dataDate,
    ),
    index("idx_video_metric_daily_date").on(table.dataDate),
  ],
);

// ── 账号每日聚合指标（需求 §八.4）：账号级数据，不归因到单视频 ──
export const creatorMetricDaily = mysqlTable(
  "creator_metric_daily",
  {
    platform: varchar("platform", { length: 50 }).notNull(),
    statDate: date("stat_date", { mode: "string" }).notNull(),
    playIncrement: int("play_increment"),
    likeIncrement: int("like_increment"),
    commentIncrement: int("comment_increment"),
    shareIncrement: int("share_increment"),
    profileUV: int("profile_uv"),
    newFans: int("new_fans"),
    totalFans: int("total_fans"),
    // 账号级漏斗与发布节奏（创作者后台全量指标导出，2026-09-24 扩展；账号级口径不得冒充视频级）
    bounceRate2s: double("bounce_rate_2s"),
    watchRate5s: double("watch_rate_5s"),
    avgWatchTime: double("avg_watch_time"),
    postCount: int("post_count"),
    coverClickRate: double("cover_click_rate"),
    sourceType: mysqlEnum("source_type", METRIC_SOURCE_TYPES).notNull(),
    fetchedAt: timestamp("fetched_at").notNull().defaultNow(),
    metadata: json("metadata"),
  },
  (table) => [primaryKey({ columns: [table.platform, table.statDate] })],
);

// ── 内容特征表（Production Feature 落库，需求 §五A/§八.5） ──
// 生产可直取字段一律从 ContentDTO/audit 提取（PLATFORM_PRODUCTION）；
// hook/scene 等生产阶段未建模的标签允许人工录入（USER_INPUT），字段级来源记入 field_sources。
export const contentFeatures = mysqlTable("content_features", {
  contentId: varchar("content_id", { length: 32 })
    .primaryKey()
    .references(() => contents.id, { onDelete: "cascade" }),
  template: mysqlEnum("template", ["scene_word", "word_card", "quiz"]).notNull(),
  level: mysqlEnum("level", ["CET4", "CET6"]).notNull(),
  /** 实际成片时长（秒，video/audio 产物事实） */
  duration: double("duration"),
  /** 知识点数（= words 去重汇总词数） */
  knowledgePointCount: int("knowledge_point_count"),
  /** 人物数（生产阶段未建模，人工/AI 补充） */
  characterCount: int("character_count"),
  /** 对白/段落数（scene_word 段数；word_card 卡数；quiz 题数） */
  dialogueCount: int("dialogue_count"),
  segmentCount: int("segment_count"),
  /** 语速倍率（voice.speed） */
  speechRate: float("speech_rate"),
  voiceId: varchar("voice_id", { length: 100 }),
  bgm: varchar("bgm", { length: 500 }),
  /** 字幕类型（当前渲染器统一默认样式；预留扩展） */
  subtitleType: varchar("subtitle_type", { length: 32 }),
  /** 镜头数（渲染器事实：scene_word 含片头为 1+segments；其余每条目 1 镜头） */
  shotCount: int("shot_count"),
  introEffect: int("intro_effect"),
  introTopic: varchar("intro_topic", { length: 255 }),
  /** Prompt 版本（audit 留痕可得则填，否则 null，不猜测） */
  promptVersion: varchar("prompt_version", { length: 32 }),
  rendererVersion: varchar("renderer_version", { length: 32 }),
  // ── 以下字段生产阶段未建模，仅 USER_INPUT / AI_EXTRACTED 来源 ──
  scene: varchar("scene", { length: 32 }),
  hook: varchar("hook", { length: 32 }),
  contentFormat: varchar("content_format", { length: 32 }),
  emotion: varchar("emotion", { length: 32 }),
  ctaType: varchar("cta_type", { length: 32 }),
  ctaStartTime: int("cta_start_time"),
  /** 字段级来源映射 { field: sourceType }（需求 §六：每个值可溯源） */
  fieldSources: json("field_sources"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
});

// ── 内容时间轴表（需求 §八.6 video_segment，Phase 3） ──
// 段落时长为生产口径派生（TTS 按段拼接，时长按字符数权重 allocateDurations 分配）；
// 非逐帧实测切换点，行级 source_type 如实标注派生属性，不伪造真实留存对齐。
export const videoSegments = mysqlTable(
  "video_segments",
  {
    id: int("id").autoincrement().primaryKey(),
    contentId: varchar("content_id", { length: 32 })
      .notNull()
      .references(() => contents.id, { onDelete: "cascade" }),
    /** 段序（0-based；片头占第 0 段，未启用片头时从正文起） */
    idx: int("idx").notNull(),
    startTime: double("start_time").notNull(),
    endTime: double("end_time").notNull(),
    /** intro | story_segment | word_card | quiz_question */
    segmentType: varchar("segment_type", { length: 32 }).notNull(),
    /** 台词/文本（scene_word 段文本；word_card 词+释义+例句；quiz 题干） */
    dialogue: varchar("dialogue", { length: 2000 }),
    /** 本段知识点（词汇/题目对应词，逗号连接） */
    knowledgePoint: varchar("knowledge_point", { length: 500 }),
    // 以下三项生产未建模，仅人工/AI 补充（与 content_features 同口径）
    scene: varchar("scene", { length: 32 }),
    emotion: varchar("emotion", { length: 32 }),
    shotType: varchar("shot_type", { length: 32 }),
    sourceType: mysqlEnum("source_type", METRIC_SOURCE_TYPES).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    uniqueIndex("uq_video_segments_content_idx").on(table.contentId, table.idx),
    index("idx_video_segments_content").on(table.contentId),
  ],
);

// ── 分析结果表（需求 §八.7 analysis_result，Phase 3 因子分析留痕） ──
// 追加式快照：每次 /factors 计算落一行，供 Phase 5 模型训练回看与结果可解释（§十二）。
export const analysisResults = mysqlTable(
  "analysis_result",
  {
    id: int("id").autoincrement().primaryKey(),
    /** 分析类型（factors:completion_rate 等） */
    analysisType: varchar("analysis_type", { length: 64 }).notNull(),
    /** 分析对象（null=账号级；否则 content_id） */
    subjectId: varchar("subject_id", { length: 32 }),
    result: json("result").notNull(),
    /** 证据（参与样本 recordId 清单与总样本量，可解释性） */
    evidence: json("evidence"),
    confidence: float("confidence"),
    /** 计算口径版本（分组统计为 group-stats-v1，不冒充模型） */
    modelVersion: varchar("model_version", { length: 32 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("idx_analysis_result_type").on(table.analysisType, table.subjectId)],
);

// ── 生产建议表（需求 §八.8 recommendation，Phase 4 优化闭环） ──
// 记录平台给出的下一条生产建议及其采纳回路：accepted/applied_to_content_id 让
// 「建议是否被采用、采用后效果是否提升」可回答（§八.8）。
export const recommendations = mysqlTable(
  "recommendations",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    /** hook / scene / duration / knowledge_points / speech_rate / cta / template / structure / data_readiness */
    recommendationType: varchar("recommendation_type", { length: 32 }).notNull(),
    /** 建议内容 { value, label, params? }（如 {value:"mistake", label:"错误示范"}） */
    recommendation: json("recommendation").notNull(),
    /** 推荐理由（基于哪个指标分组统计、样本情况；可解释，§十二） */
    reason: varchar("reason", { length: 500 }).notNull(),
    /** 依据样本数（分组统计的 n；低样本不出参数建议，§十四） */
    sourceSampleCount: int("source_sample_count").notNull(),
    /** 判定依据的 canonical 指标 */
    sourceMetric: varchar("source_metric", { length: 64 }).notNull(),
    confidence: float("confidence"),
    /** NULL=待处理 · 1=已采纳 · 0=已忽略（采纳回路） */
    accepted: int("accepted"),
    /** 采纳后新建的内容 id（采用后效果对比的接入点） */
    appliedToContentId: varchar("applied_to_content_id", { length: 32 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    index("idx_recommendations_type").on(table.recommendationType),
    index("idx_recommendations_applied").on(table.appliedToContentId),
  ],
);

// ── 内容实验表（需求 §八.9 experiment，Phase 6 A/B 实验预留实体） ──
// 一次实验 = 一个变量 × 两个变体 × 内容分组；evaluate 用发布指标做分组对比。
// 纪律：小样本只给描述统计不下结论（§十四）；结论字段永远标注「相关非因果」。
export const experiments = mysqlTable(
  "experiments",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    /** 实验变量：hook / template / duration / structure / prompt_version / cta / voice ... */
    variable: varchar("variable", { length: 32 }).notNull(),
    /** 变体 A { label, contentIds[] } */
    variantA: json("variant_a").notNull(),
    /** 变体 B { label, contentIds[] } */
    variantB: json("variant_b").notNull(),
    /** 控制变量说明（除实验变量外保持一致的维度） */
    controlVariables: json("control_variables"),
    /** 目标指标（canonical 名，默认完播率） */
    targetMetric: varchar("target_metric", { length: 64 }).notNull().default("completion_rate"),
    startAt: datetime("start_at", { mode: "date" }),
    endAt: datetime("end_at", { mode: "date" }),
    status: mysqlEnum("status", ["draft", "running", "completed", "cancelled"])
      .notNull()
      .default("draft"),
    /** evaluate 结果快照（分组中位/差值/样本数/lowSample/非因果声明） */
    result: json("result"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => [index("idx_experiments_status").on(table.status)],
);

// ══ 以下为平台数据导入·四步精准匹配表（docs/17 §数据导入，migration 0008）══
// 纪律：导入数据永远经 import_batch/import_row 中间层，禁止 CSV/XLSX 直写 video_analytics；
// raw_data 永久保留；匹配只走确定性规则（lib/import-matcher），禁止 LLM 猜归属。

/** 数据粒度三态：作品级强标识 / 作品级弱标识 / 账号日汇总（账号日级禁止进入作品级匹配） */
export const IMPORT_DATA_GRANULARITIES = [
  "work_level_strong",
  "work_level_weak",
  "account_day_level",
] as const;

/** 行匹配状态六态（禁止新增意义重复的状态） */
export const IMPORT_ROW_MATCH_STATUSES = [
  "unique_match",
  "conflict",
  "unmatched",
  "account_day_level",
  "confirmed",
  "ignored",
] as const;

/** 确定性匹配方法（优先级 1→6，强证据压制弱证据；title_exact_plus_time 为 2026-09-28 用户裁决的双证据自动入库档） */
export const IMPORT_MATCH_METHODS = [
  "platform_work_id_exact",
  "work_url_id",
  "title_exact_plus_time",
  "account_publish_time",
  "account_date_title",
  "account_date_title_duration",
] as const;

// ── 导入批次表：一次上传 = 一个批次，可追溯、可回滚 ──
export const importBatch = mysqlTable(
  "import_batch",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    filename: varchar("filename", { length: 255 }).notNull(),
    fileSize: int("file_size").notNull(),
    /** 文件内容 sha256：重复导入检测（与既有 committed 批次撞号 → preflight 阻断） */
    fileHash: varchar("file_hash", { length: 64 }).notNull(),
    /** 批次声明平台（抖音/快手/视频号…；自由文本与 publish_records.platform 同口径） */
    platform: varchar("platform", { length: 50 }).notNull(),
    rowCount: int("row_count").notNull(),
    dataGranularity: mysqlEnum("data_granularity", IMPORT_DATA_GRANULARITIES).notNull(),
    /** 粒度判定依据（命中列/ID 非空占比/是否含作品维度），UI 必须可解释 */
    granularityEvidence: json("granularity_evidence").notNull(),
    /** 原始表头 */
    headers: json("headers").notNull(),
    /** 列下标 → canonical 角色映射（platform_work_id/work_url/account/publish_time/title/...） */
    fieldDetection: json("field_detection").notNull(),
    /** STEP2 匹配规则快照（账号/平台映射、时区、容差、标题标准化、相似度阈值） */
    matchRules: json("match_rules"),
    status: mysqlEnum("status", [
      "draft",
      "granularity_confirmed",
      "rules_set",
      "prematched",
      "preflight_ok",
      "committed",
      "rolled_back",
      "cancelled",
    ])
      .notNull()
      .default("draft"),
    /** 提交摘要 { workLevel, accountDayLevel, ignored, external, perRow? } */
    commitSummary: json("commit_summary"),
    /** 被覆盖指标旧值快照（回滚依据；null=本批新插入，回滚即删除） */
    commitPreimage: json("commit_preimage"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
  },
  (table) => [
    index("idx_import_batch_status").on(table.status),
    index("idx_import_batch_file_hash").on(table.fileHash),
  ],
);

// ── 导入行表：原始整行永久保留 ──
export const importRow = mysqlTable(
  "import_row",
  {
    id: int("id").autoincrement().primaryKey(),
    batchId: varchar("batch_id", { length: 32 })
      .notNull()
      .references(() => importBatch.id, { onDelete: "cascade" }),
    /** 1-based，对应表格行序 */
    rowNumber: int("row_number").notNull(),
    /** 原始整行 { 列名: 原值 }，导入后永不删改 */
    rawData: json("raw_data").notNull(),
    /** 字段识别后的标准数据 { platformWorkId?, workUrl?, account?, publishTime?, title?, views?, ... } */
    normalizedData: json("normalized_data").notNull(),
    dataGranularity: mysqlEnum("data_granularity", IMPORT_DATA_GRANULARITIES).notNull(),
    matchStatus: mysqlEnum("match_status", IMPORT_ROW_MATCH_STATUSES).notNull(),
    /** preflight 行级校验结果 */
    validationStatus: mysqlEnum("validation_status", ["pending", "ok", "warning", "error"])
      .notNull()
      .default("pending"),
  },
  (table) => [
    uniqueIndex("uq_import_row_batch_number").on(table.batchId, table.rowNumber),
    index("idx_import_row_batch_status").on(table.batchId, table.matchStatus),
  ],
);

// ── 匹配候选表：一行可产生多个候选；一个 import_row 可关联多个 video ──
export const matchCandidate = mysqlTable(
  "match_candidate",
  {
    id: int("id").autoincrement().primaryKey(),
    importRowId: int("import_row_id")
      .notNull()
      .references(() => importRow.id, { onDelete: "cascade" }),
    /** 系统视频 = 发布记录 id（publish_records.id）；候选是引擎产物，随批次重跑级联重建 */
    videoId: varchar("video_id", { length: 32 })
      .notNull()
      .references(() => publishRecords.id, { onDelete: "cascade" }),
    matchMethod: mysqlEnum("match_method", IMPORT_MATCH_METHODS).notNull(),
    matchScore: float("match_score").notNull(),
    /** 结构化匹配证据（platformWorkIdExact/accountExact/publishTimeDiffSeconds/titleSimilarity…），禁止裸分数 */
    evidence: json("evidence").notNull(),
    /** 1=最强证据；冲突时全部并列展示，系统绝不自动选最高分 */
    rank: int("rank").notNull(),
  },
  (table) => [
    uniqueIndex("uq_match_candidate_row_video").on(table.importRowId, table.videoId),
    index("idx_match_candidate_row").on(table.importRowId, table.rank),
  ],
);

// ── 匹配裁决表：一行一条最终决定（系统建议或人工裁决），可追溯 operator/confirmed_at ──
export const matchDecision = mysqlTable(
  "match_decision",
  {
    importRowId: int("import_row_id")
      .primaryKey()
      .references(() => importRow.id, { onDelete: "cascade" }),
    batchId: varchar("batch_id", { length: 32 })
      .notNull()
      .references(() => importBatch.id, { onDelete: "cascade" }),
    matchStatus: mysqlEnum("match_status", IMPORT_ROW_MATCH_STATUSES).notNull(),
    /** 确认归属的系统视频（publish_records.id）；不设 FK——发布记录删除不抹掉裁决历史，提交时服务端校验存在性 */
    matchedVideoId: varchar("matched_video_id", { length: 32 }),
    /** 最终生效证据 */
    matchMethod: mysqlEnum("match_method", IMPORT_MATCH_METHODS),
    confidence: float("confidence"),
    decisionType: mysqlEnum("decision_type", [
      "system_auto", // 系统建议（unique_match 预选）
      "operator_confirm", // 人工确认（批量/单条）
      "operator_assign", // 人工指定归属（冲突选择/搜索绑定）
      "operator_external", // 标记外部视频（不落作品指标）
      "operator_account_day", // 保存为账号日级数据
      "operator_ignore", // 忽略本行
    ])
      .notNull()
      .default("system_auto"),
    /** 操作者（本机无认证，固定 local，字段留位供未来接入） */
    operator: varchar("operator", { length: 100 }).notNull().default("local"),
    confirmedAt: datetime("confirmed_at", { mode: "date" }),
    /** 扩展信息（external 行的平台标题/账号留档、批量操作幂等键等） */
    metadata: json("metadata"),
  },
  (table) => [index("idx_match_decision_batch").on(table.batchId, table.matchStatus)],
);
