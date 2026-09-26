/**
 * 数据分析展示层纯函数 — 标签中文化 / 无数据语义 / 趋势图几何 / 漏斗可比性
 * 口径来源：docs/17 §三（指标必须可溯源）与 §八（Empty State：无数据 ≠ 0，不得显示 0%）
 * 视图层只做格式化，不在此计算任何业务指标（核心指标一律后端产出，需求 §二十四）
 */
import type { FactorDimensionName, FunnelStageView, FunnelStepRateState } from "../api/client";

// ── 来源标签（source_type → 展示名；抖音官方 API 通道已砍除，不保留 DOUYIN_* 映射） ──

export const SOURCE_TYPE_LABEL: Record<string, string> = {
  CREATOR_IMPORT: "创作者导入",
  PLATFORM_PRODUCTION: "生产参数",
  PLATFORM_CALCULATED: "平台计算",
  AI_EXTRACTED: "AI 提取",
  USER_INPUT: "手动录入",
};

export function sourceLabel(sourceType: string | null | undefined): string {
  if (!sourceType) return "未知来源";
  return SOURCE_TYPE_LABEL[sourceType] ?? sourceType;
}

// ── Empty State 原因（需求 §二十六：暂无数据 + 标识原因） ──

export const EMPTY_REASON_LABEL: Record<string, string> = {
  not_published: "尚未创建发布记录",
  not_imported: "创作者尚未导入数据",
  missing_rate_or_plays: "缺少播放量或对应比例",
  no_records: "窗口内没有发布记录",
  no_metrics: "已发布但尚未导入任何指标",
  no_publish_record: "该视频还没有发布记录",
  no_group_data: "同类分组暂无样本",
  content_not_found: "内容不存在",
  platform_unavailable: "平台暂不提供该字段",
  low_sample: "样本不足",
};

export function emptyReasonLabel(reason: string | null | undefined): string {
  if (!reason) return "";
  return EMPTY_REASON_LABEL[reason] ?? reason;
}

// ── 数值格式化（null 一律渲染「暂无数据」，绝不渲染 0） ──

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "暂无数据";
  return Math.round(value).toLocaleString("zh-CN");
}

export function formatRate(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "暂无数据";
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatSeconds(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "暂无数据";
  return `${value.toFixed(1)}s`;
}

/** 环比变化：±xx.x%；无对比数据 → — （不是 0%） */
export function formatChange(pct: number | null | undefined): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return "—";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${(pct * 100).toFixed(1)}%`;
}

/** 比例差按百分点呈现（+11.0pp）；计数差直接千分位 */
export function formatDiff(diff: number | null | undefined, unit: string): string {
  if (diff === null || diff === undefined || !Number.isFinite(diff)) return "—";
  const sign = diff > 0 ? "+" : "";
  if (unit === "rate") return `${sign}${(diff * 100).toFixed(1)}pp`;
  if (unit === "seconds") return `${sign}${diff.toFixed(1)}s`;
  return `${sign}${Math.round(diff).toLocaleString("zh-CN")}`;
}

// ── 趋势图几何（SVG 折线；缺日无点不补 0，需求 §二十二） ──

export interface TrendXY {
  date: string;
  value: number;
}
export interface TrendGeometry {
  /** SVG polyline 点串（"x1,y1 x2,y2 …"）；少于 2 点为空串（单点用 dots 呈现） */
  line: string;
  dots: { cx: number; cy: number; date: string; value: number }[];
}

/**
 * 把时间序列映射到 width×height 画布（上下留 pad 防贴边）。
 * x 按日期线性分布；y 按值域 min→max 线性；全部同值时居中，不夸大为满幅。
 */
export function trendGeometry(
  points: TrendXY[],
  width = 560,
  height = 160,
  pad = 12,
): TrendGeometry {
  if (points.length === 0) return { line: "", dots: [] };
  const times = points.map((p) => new Date(`${p.date}T00:00:00Z`).getTime());
  const minT = Math.min(...times);
  const maxT = Math.max(...times);
  const values = points.map((p) => p.value);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const dots = points.map((p, index) => {
    const t = times[index] ?? minT;
    const x = maxT === minT ? pad + innerW / 2 : pad + ((t - minT) / (maxT - minT)) * innerW;
    const y =
      maxV === minV ? pad + innerH / 2 : pad + (1 - (p.value - minV) / (maxV - minV)) * innerH;
    return {
      cx: Math.round(x * 100) / 100,
      cy: Math.round(y * 100) / 100,
      date: p.date,
      value: p.value,
    };
  });
  return { line: dots.map((d) => `${d.cx},${d.cy}`).join(" "), dots };
}

/** 漏斗条宽度（占比 0~1 → 百分比字符串；无数据 0 宽但文案走 emptyReason） */
export function funnelBarWidth(share: number | null): string {
  if (share === null || !Number.isFinite(share)) return "0%";
  return `${Math.max(2, Math.min(100, share * 100)).toFixed(1)}%`;
}

// ── 漏斗逐级转化可比性（审查批次 1B：绝不截断百分比掩盖口径错位，不可比就诚实展示） ──

export const STEP_RATE_HINT: Record<Exclude<FunnelStepRateState, "computed">, string> = {
  first: "",
  "coverage-mismatch": "与上一阶段覆盖的记录不同，不计算逐级转化",
  inverted: "来源数据口径倒挂（如完播率高于 5 秒观看率），不计算逐级转化",
  missing: "相邻阶段缺少可比数据",
  standalone: "账号级独立指标，不在观看漏斗链路",
};

/** 条形内转化文案：仅 computed 给百分比；不可比一律「—」（配 funnelStepHint 说明原因） */
export function funnelStepRateText(
  stage: Pick<FunnelStageView, "stepRate" | "stepRateState">,
): string {
  return stage.stepRateState === "computed" && stage.stepRate !== null
    ? formatRate(stage.stepRate)
    : "—";
}

export function funnelStepHint(stage: Pick<FunnelStageView, "stepRateState">): string {
  if (stage.stepRateState === "computed") return "";
  return STEP_RATE_HINT[stage.stepRateState];
}

/** 覆盖/折算基数文案：让用户看见每个阶段到底算了多少条记录/多少次播放 */
export function funnelCoverageText(
  stage: Pick<FunnelStageView, "kind" | "coverageCount" | "windowRecordCount" | "basisPlays">,
): string {
  if (stage.kind === "creator") return `窗口内 ${stage.coverageCount} 天导入`;
  const base = `覆盖 ${stage.coverageCount}/${stage.windowRecordCount} 条记录`;
  if (stage.kind === "rate" && stage.basisPlays !== null) {
    return `${base} · 基于 ${Math.round(stage.basisPlays)} 次播放折算`;
  }
  return base;
}

// ── 内容标签选项（与后端 lib/analytics-taxonomy.ts 同源枚举；后端 zod 为准，此处仅供选择器展示） ──

export const SCENE_OPTIONS: { value: string; label: string }[] = [
  { value: "restaurant", label: "餐厅" },
  { value: "airport", label: "机场" },
  { value: "hotel", label: "酒店" },
  { value: "workplace", label: "职场" },
  { value: "interview", label: "面试" },
  { value: "shopping", label: "购物" },
  { value: "hospital", label: "医院" },
  { value: "school", label: "学校" },
  { value: "travel", label: "旅行" },
  { value: "dating", label: "约会" },
  { value: "social", label: "社交" },
  { value: "daily_life", label: "日常生活" },
];

export const HOOK_OPTIONS: { value: string; label: string }[] = [
  { value: "mistake", label: "错误示范" },
  { value: "warning", label: "警告提醒" },
  { value: "question", label: "提问" },
  { value: "conflict", label: "冲突" },
  { value: "curiosity", label: "悬念" },
  { value: "quiz", label: "选择题" },
  { value: "pain_point", label: "痛点" },
  { value: "counter_intuitive", label: "反常识" },
  { value: "identity", label: "身份认同" },
  { value: "result_first", label: "结果先行" },
];

// ── 因子分析选项（与后端 analytics-factors.service 白名单同源） ──

export const FACTOR_METRIC_OPTIONS: { value: string; label: string; unit: "count" | "rate" }[] = [
  { value: "completion_rate", label: "完播率", unit: "rate" },
  { value: "effective_play_rate_2s", label: "2秒有效播放率", unit: "rate" },
  { value: "watch_rate_5s", label: "5秒观看率", unit: "rate" },
  { value: "avg_watch_ratio", label: "平均观看比例", unit: "rate" },
  { value: "like_rate", label: "点赞率", unit: "rate" },
  { value: "comment_rate", label: "评论率", unit: "rate" },
  { value: "share_rate", label: "分享率", unit: "rate" },
  { value: "engagement_rate", label: "互动率", unit: "rate" },
  { value: "profile_visit_rate", label: "主页访问率", unit: "rate" },
  { value: "play_count", label: "播放量", unit: "count" },
];

export const FACTOR_DIMENSION_OPTIONS: { value: FactorDimensionName; label: string }[] = [
  { value: "hook", label: "Hook" },
  { value: "scene", label: "场景" },
  { value: "contentFormat", label: "内容形态" },
  { value: "emotion", label: "情绪" },
  { value: "ctaType", label: "CTA" },
  { value: "template", label: "模板" },
  { value: "level", label: "词汇等级" },
  { value: "durationBand", label: "时长带" },
  { value: "speechRateBand", label: "语速带" },
  { value: "segmentCountBand", label: "段落数带" },
  { value: "voice", label: "音色" },
  { value: "bgm", label: "背景音乐" },
  { value: "subtitleType", label: "字幕形式" },
  { value: "promptVersion", label: "Prompt 版本" },
  { value: "publishHourBand", label: "发布时段" },
];

export const SEGMENT_TYPE_LABEL: Record<string, string> = {
  intro: "片头",
  story_segment: "故事段",
  word_card: "单词卡",
  quiz_question: "选择题",
};

/** canonical 名缺行时的中文兑底（已导入指标一律用后端 label，保证单一事实源） */
export const METRIC_FALLBACK_LABEL: Record<string, string> = {
  play_count: "播放量",
  effective_play_rate_2s: "2秒有效播放率",
  watch_rate_5s: "5秒观看率",
  completion_rate: "完播率",
  avg_watch_time: "平均播放时长",
  avg_watch_ratio: "平均观看比例",
  like_rate: "点赞率",
  comment_rate: "评论率",
  share_rate: "分享率",
  profile_visit_count: "主页访问数",
  new_fan_count: "新增粉丝（视频级）",
};

// ── 页面 C 展示清单（与后端 canonical 目录同源命名；缺失即「暂无数据」） ──

export const OVERVIEW_METRICS = [
  "play_count",
  "effective_play_rate_2s",
  "watch_rate_5s",
  "completion_rate",
  "avg_watch_time",
  "avg_watch_ratio",
  "like_rate",
  "comment_rate",
  "share_rate",
  "profile_visit_count",
  "new_fan_count",
] as const;

/** 视频列表指标列（canonical → 表头文案与格式化器名） */
export const VIDEO_LIST_COLUMNS: {
  key: (typeof OVERVIEW_METRICS)[number];
  label: string;
  kind: "count" | "rate" | "seconds";
  sort?: "play" | "completion" | "engagement" | "fans";
}[] = [
  { key: "play_count", label: "播放", kind: "count", sort: "play" },
  { key: "effective_play_rate_2s", label: "2秒", kind: "rate" },
  { key: "watch_rate_5s", label: "5秒", kind: "rate" },
  { key: "avg_watch_time", label: "平均播放", kind: "seconds" },
  { key: "completion_rate", label: "完播", kind: "rate", sort: "completion" },
  { key: "like_rate", label: "点赞率", kind: "rate" },
  { key: "comment_rate", label: "评论率", kind: "rate" },
  { key: "share_rate", label: "分享率", kind: "rate" },
  { key: "new_fan_count", label: "涨粉", kind: "count", sort: "fans" },
];

export function formatByKind(
  value: number | null | undefined,
  kind: "count" | "rate" | "seconds",
): string {
  if (kind === "rate") return formatRate(value);
  if (kind === "seconds") return formatSeconds(value);
  return formatCount(value);
}
