/**
 * 数据分析模块 · 领域目录（canonical 指标注册表 + 内容标签体系 + 数据源约束）
 * 依据：docs/17_视频数据分析模块设计.md（源需求：视频数据分析模块需求 §五~§十、§二十二）
 *
 * 数据源决策（用户 2026-09-24）：抖音开放平台数据通道已砍除（需企业资质，本项目不具备）：
 * - source_type 不保留 DOUYIN_* 枚举值，封死将来误用可能
 * - 外部绩效数据唯一入口 = Creator Import（创作者后台导出）/ 手动录入
 *
 * 真实性约束（需求 §二十二）：
 * - 每个 canonical 指标声明 availability：
 *   AVAILABLE     = 已接入数据源可直接取得（当前无）
 *   IMPORT_ONLY   = 只能创作者后台导出/手动录入
 *   DERIVED       = 平台由已有指标计算（除零/缺输入 → null，绝不落 0）
 *   FUTURE        = 预留能力，当前无任何来源
 * - source_type 五值全集（需求 §六），每条指标行必须携带来源；
 *   前端展示指标必须带来源标签，绝不让用户误认为数据来自平台官方接口。
 */

// ── 指标来源（video_metrics.source_type / content_features.field_sources 共用） ──

export const METRIC_SOURCE_TYPES = [
  "CREATOR_IMPORT",
  "PLATFORM_PRODUCTION",
  "PLATFORM_CALCULATED",
  "AI_EXTRACTED",
  "USER_INPUT",
] as const;

export type MetricSourceType = (typeof METRIC_SOURCE_TYPES)[number];

/** Creator Import / 手动录入允许声明的来源白名单 */
export const IMPORTABLE_SOURCE_TYPES = ["CREATOR_IMPORT", "USER_INPUT"] as const;

// ── canonical 指标目录 ──

export type MetricAvailability = "AVAILABLE" | "IMPORT_ONLY" | "DERIVED" | "FUTURE";
export type MetricUnit = "count" | "rate" | "seconds";

export interface CanonicalMetric {
  /** 稳定机器名（入库 metric_name），snake_case */
  name: string;
  /** 中文展示名 */
  label: string;
  unit: MetricUnit;
  availability: MetricAvailability;
  /** DERIVED 时的计算公式说明（可解释性，需求 §十二） */
  formula?: string;
  /** 该指标是否可由 Creator Import 写入 */
  importable: boolean;
  /** 备注：视频级归因限制等诚实声明 */
  note?: string;
}

export const CANONICAL_METRICS = [
  {
    name: "play_count",
    label: "播放量",
    unit: "count",
    availability: "IMPORT_ONLY",
    importable: true,
  },
  {
    name: "like_count",
    label: "点赞量",
    unit: "count",
    availability: "IMPORT_ONLY",
    importable: true,
  },
  {
    name: "comment_count",
    label: "评论量",
    unit: "count",
    availability: "IMPORT_ONLY",
    importable: true,
  },
  {
    name: "share_count",
    label: "分享/转发量",
    unit: "count",
    availability: "IMPORT_ONLY",
    importable: true,
  },
  {
    name: "collect_count",
    label: "收藏量",
    unit: "count",
    availability: "IMPORT_ONLY",
    importable: true,
  },
  {
    name: "bounce_rate_2s",
    label: "2秒跳出率",
    unit: "rate",
    availability: "IMPORT_ONLY",
    importable: true,
    note: "仅创作者后台可得",
  },
  {
    name: "watch_rate_5s",
    label: "5秒观看率",
    unit: "rate",
    availability: "IMPORT_ONLY",
    importable: true,
    note: "以创作者后台导出字段为准，字段名映射不写死",
  },
  {
    name: "avg_watch_time",
    label: "平均播放时长",
    unit: "seconds",
    availability: "IMPORT_ONLY",
    importable: true,
  },
  {
    name: "completion_rate",
    label: "完播率",
    unit: "rate",
    availability: "IMPORT_ONLY",
    importable: true,
  },
  {
    name: "profile_visit_count",
    label: "主页访问数",
    unit: "count",
    availability: "IMPORT_ONLY",
    importable: true,
  },
  {
    name: "new_fan_count",
    label: "新增粉丝（视频级）",
    unit: "count",
    availability: "IMPORT_ONLY",
    importable: true,
    note: "账号日新增粉丝不得直接宣称为单视频归因；导入时若为估算值必须携带 isEstimated 标记（需求 §五C）",
  },
  {
    name: "effective_play_rate_2s",
    label: "2秒有效播放率",
    unit: "rate",
    availability: "DERIVED",
    formula: "1 - bounce_rate_2s",
    importable: false,
  },
  {
    name: "like_rate",
    label: "点赞率",
    unit: "rate",
    availability: "DERIVED",
    formula: "like_count / play_count",
    importable: false,
  },
  {
    name: "comment_rate",
    label: "评论率",
    unit: "rate",
    availability: "DERIVED",
    formula: "comment_count / play_count",
    importable: false,
  },
  {
    name: "share_rate",
    label: "分享率",
    unit: "rate",
    availability: "DERIVED",
    formula: "share_count / play_count",
    importable: false,
  },
  {
    name: "collect_rate",
    label: "收藏率",
    unit: "rate",
    availability: "DERIVED",
    formula: "collect_count / play_count",
    importable: false,
  },
  {
    name: "engagement_rate",
    label: "互动率",
    unit: "rate",
    availability: "DERIVED",
    formula: "(like_count + comment_count + share_count) / play_count",
    importable: false,
  },
  {
    name: "avg_watch_ratio",
    label: "平均观看比例",
    unit: "rate",
    availability: "DERIVED",
    formula: "avg_watch_time / 视频时长（production 事实）",
    importable: false,
  },
  {
    name: "profile_visit_rate",
    label: "主页访问率",
    unit: "rate",
    availability: "DERIVED",
    formula: "profile_visit_count / play_count",
    importable: false,
  },
  {
    name: "traffic_source_distribution",
    label: "流量来源结构",
    unit: "count",
    availability: "FUTURE",
    importable: false,
    note: "预留：推荐页/搜索/主页流量占比，依赖创作者导出字段",
  },
] as const satisfies readonly CanonicalMetric[];

export type CanonicalMetricName = (typeof CANONICAL_METRICS)[number]["name"];

const METRIC_BY_NAME = new Map<string, CanonicalMetric>(CANONICAL_METRICS.map((m) => [m.name, m]));

export function findCanonicalMetric(name: string): CanonicalMetric | undefined {
  return METRIC_BY_NAME.get(name);
}

export function isImportableMetric(name: string): boolean {
  return METRIC_BY_NAME.get(name)?.importable ?? false;
}

/** 全部 DERIVED 指标名（导入落库后由平台统一重算，需求 §五C/§二十四） */
export function derivedMetricNames(): string[] {
  return CANONICAL_METRICS.filter((m) => m.availability === "DERIVED").map((m) => m.name);
}

// ── 账号日聚合字段目录（creator_metric_daily 列级白名单，与视频级 canonical 指标分开：口径不同不互串） ──

export interface CreatorDailyField {
  /** 入库列名（camelCase → snake_case 列） */
  name: string;
  label: string;
  unit: MetricUnit;
  /** 账号级口径声明（展示层必携，不得冒充视频级） */
  note?: string;
}

export const CREATOR_DAILY_FIELDS = [
  { name: "playIncrement", label: "播放量（当日）", unit: "count" },
  { name: "likeIncrement", label: "点赞量（当日）", unit: "count" },
  { name: "commentIncrement", label: "评论量（当日）", unit: "count" },
  { name: "shareIncrement", label: "分享量（当日）", unit: "count" },
  { name: "profileUV", label: "主页访问（当日）", unit: "count" },
  { name: "newFans", label: "新增粉丝（当日）", unit: "count" },
  { name: "totalFans", label: "粉丝总数", unit: "count" },
  {
    name: "bounceRate2s",
    label: "2秒跳出率",
    unit: "rate",
    note: "账号级加权值，非单视频实测",
  },
  {
    name: "watchRate5s",
    label: "5秒完播率",
    unit: "rate",
    note: "账号级加权值，非单视频实测",
  },
  { name: "avgWatchTime", label: "平均播放时长", unit: "seconds", note: "账号级均值" },
  { name: "postCount", label: "投稿量（当日）", unit: "count" },
  {
    name: "coverClickRate",
    label: "封面点击率",
    unit: "rate",
    note: "曝光→点击，漏斗首环（账号级）",
  },
] as const satisfies readonly CreatorDailyField[];

export type CreatorDailyFieldName = (typeof CREATOR_DAILY_FIELDS)[number]["name"];

const CREATOR_DAILY_FIELD_BY_NAME = new Map<string, CreatorDailyField>(
  CREATOR_DAILY_FIELDS.map((f) => [f.name, f]),
);

export function isCreatorDailyField(name: string): boolean {
  return CREATOR_DAILY_FIELD_BY_NAME.has(name);
}

// ── 内容标签体系（需求 §十，scene_word 优先；可扩展，不锁死） ──

export const SCENE_TAXONOMY = [
  "restaurant",
  "airport",
  "hotel",
  "workplace",
  "interview",
  "shopping",
  "hospital",
  "school",
  "travel",
  "dating",
  "social",
  "daily_life",
] as const;

export const HOOK_TAXONOMY = [
  "mistake",
  "warning",
  "question",
  "conflict",
  "curiosity",
  "quiz",
  "pain_point",
  "counter_intuitive",
  "identity",
  "result_first",
] as const;

export const CONTENT_FORMAT_TAXONOMY = [
  "scenario_dialogue",
  "scenario_teaching",
  "pure_teaching",
  "mistake_correction",
  "quiz",
  "shadowing",
  "vocabulary",
  "story",
] as const;

export const EMOTION_TAXONOMY = [
  "funny",
  "awkward",
  "surprise",
  "conflict",
  "warm",
  "tense",
  "curious",
] as const;

export const CTA_TAXONOMY = [
  "follow_series",
  "follow_account",
  "like_comment",
  "next_teaser",
  "collect_save",
  "none",
] as const;

export type FeatureField =
  | "scene"
  | "hook"
  | "contentFormat"
  | "emotion"
  | "ctaType"
  | "ctaStartTime";

/** 允许人工录入/AI 提取覆盖的特征字段（其余字段一律来自生产数据，需求 §五A） */
export const MANUAL_FEATURE_FIELDS: readonly FeatureField[] = [
  "scene",
  "hook",
  "contentFormat",
  "emotion",
  "ctaType",
  "ctaStartTime",
];

export const FEATURE_TAXONOMY_BY_FIELD: Partial<Record<FeatureField, readonly string[]>> = {
  scene: SCENE_TAXONOMY,
  hook: HOOK_TAXONOMY,
  contentFormat: CONTENT_FORMAT_TAXONOMY,
  emotion: EMOTION_TAXONOMY,
  ctaType: CTA_TAXONOMY,
};
