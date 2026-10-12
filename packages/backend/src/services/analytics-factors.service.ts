/**
 * 内容因子分析服务 — 页面 D（需求 §十一 页面 D、§十四 统计口径、§十五 分组原则）
 *
 * 纪律：
 * - 早期以分组统计为主（中位数/均值/样本数），不过上机器学习；model_version 固定
 *   "group-stats-v1"，不冒充模型
 * - 每个分组必须同时给 sampleCount；组内**非估算**样本 <8 标 lowSample（防 1~2 条视频误判）
 * - 行动门槛只数真实值：isEstimated=1 的指标（如窗口归因涨粉）计入展示样本，
 *   但不计入 realSampleCount（docs/22 §6.1：估算值不满足 actionable 门槛）
 * - 统计范围必须成文：scope 记录平台与时间窗口。跨平台混合的样本集不可比，
 *   因此不允许产出参数改动建议（docs/22 §6.2 把「跨平台混合」列为 data_readiness 成因）
 * - 结果差异是「关联」不是「因果」（§十四），响应 note 明示
 * - 未标注维度归入「未标注」桶，不剔除样本（避免幸存者偏差）
 * - 留档显式化（批次 5B，2026-09-26）：GET 链路纯读不落库；analysis_result 快照（§八.7）
 *   仅在显式 POST /factors「重算并留档」时写入，写失败报错不静默（GET 不得有隐蔽写副作用）
 */
import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import { analysisResults } from "../db/schema";
import {
  type VideoRowData,
  durationBandOf,
  loadVideoRowsForScope,
  medianOf,
} from "./analytics-dashboard.service";

/** 分组建议的最小真实样本数：低于此值只给数据准备建议（§十四，唯一事实源） */
export const MIN_GROUP_SAMPLES = 8;

/** 可分析目标指标（canonical 名；比率类优先） */
export const FACTOR_METRICS = [
  "play_count",
  "effective_play_rate_2s",
  "watch_rate_5s",
  "completion_rate",
  "avg_watch_ratio",
  "like_rate",
  "comment_rate",
  "share_rate",
  "engagement_rate",
  "profile_visit_rate",
] as const;
export type FactorMetric = (typeof FACTOR_METRICS)[number];

/** 可分析生产因子维度 */
export const FACTOR_DIMENSIONS = [
  "hook",
  "scene",
  "contentFormat",
  "emotion",
  "ctaType",
  "template",
  "level",
  "durationBand",
  "speechRateBand",
  "segmentCountBand",
  "voice",
  "bgm",
  "subtitleType",
  "promptVersion",
  "publishHourBand",
] as const;
export type FactorDimension = (typeof FACTOR_DIMENSIONS)[number];

export const DEFAULT_FACTOR_DIMENSIONS: FactorDimension[] = [
  "hook",
  "scene",
  "durationBand",
  "template",
];

/** 分组统计口径版本（Phase 5 引入真实模型前唯一版本） */
export const FACTORS_MODEL_VERSION = "group-stats-v1";

const UNLABELED = "未标注";

function speechRateBand(rate: number | null): string | null {
  if (rate === null || !Number.isFinite(rate)) return null;
  if (rate < 0.9) return "慢（<0.9×）";
  if (rate <= 1.1) return "正常（0.9~1.1×）";
  return "快（>1.1×）";
}

function segmentCountBand(count: number | null): string | null {
  if (count === null || !Number.isFinite(count)) return null;
  if (count <= 3) return "少（≤3段）";
  if (count <= 6) return "中（4~6段）";
  return "多（≥7段）";
}

function publishHourBand(row: VideoRowData): string | null {
  const at = row.publishTime ?? row.createdAt;
  const hour = at.getUTCHours();
  if (hour < 6) return "凌晨 0-6 时";
  if (hour < 12) return "上午 6-12 时";
  if (hour < 18) return "下午 12-18 时";
  return "晚间 18-24 时";
}

/** 纯函数：取样本在某维度上的分组值（null=该维度无有效值 → 未标注桶） */
export function dimensionValueOf(row: VideoRowData, dim: FactorDimension): string {
  switch (dim) {
    case "durationBand":
      return durationBandOf(row.durationSec) ?? UNLABELED;
    case "speechRateBand":
      return speechRateBand(row.speechRate) ?? UNLABELED;
    case "segmentCountBand":
      return segmentCountBand(row.segmentCount) ?? UNLABELED;
    case "publishHourBand":
      return publishHourBand(row) ?? UNLABELED;
    default: {
      const value = row[dim === "voice" ? "voiceId" : dim];
      return typeof value === "string" && value.length > 0 ? value : UNLABELED;
    }
  }
}

export interface FactorGroup {
  value: string;
  /** 有该指标值的样本数（含估算值；如实展示覆盖面） */
  sampleCount: number;
  /** 非估算真实样本数——行动门槛只认这个（docs/22 §6.1） */
  realSampleCount: number;
  median: number | null;
  mean: number | null;
  /** 组中位 − 账号整体中位（比率类由前端换算百分点；关联≠因果） */
  diff: number | null;
  /** 以 realSampleCount 判定：估算值凑不出可行动组 */
  lowSample: boolean;
  /** 证据链：参与本组统计的发布记录 id（推荐证据接口按此回连指标与导入行） */
  recordIds: string[];
}

export interface FactorDimensionResult {
  dimension: FactorDimension;
  groups: FactorGroup[];
}

/**
 * 统计范围（docs/22 §6.1）：同平台 + 同时间窗口 + 同 canonical 指标才可比。
 * null 表示「没有限定」，不是「全部混在一起也算一个范围」——跨平台/null 平台
 * 只用于观察，不得据此出参数改动建议。
 */
export interface FactorScope {
  platform: string | null;
  windowDays: number | null;
}

export const DEFAULT_FACTOR_SCOPE: FactorScope = { platform: null, windowDays: null };

export interface FactorAnalysisPayload {
  metric: FactorMetric;
  accountMedian: number | null;
  accountSampleCount: number;
  /** 账号整体口径的非估算真实样本数 */
  accountRealSampleCount: number;
  dimensions: FactorDimensionResult[];
  /** 本次统计范围（平台/窗口），响应必须自述口径 */
  scope: FactorScope;
  /** 样本集是否跨平台（跨平台 → 不可出行动建议） */
  mixedPlatform: boolean;
  /** 参与统计的平台清单（口径自述与 data_readiness 文案都用它，不写「多个平台」这种含糊话） */
  platforms: string[];
  note: string;
}

/** 纯函数：分组统计（中位数/均值/样本数；缺目标指标的样本不计入该指标统计） */
export function computeFactorGroups(
  rows: VideoRowData[],
  metric: FactorMetric,
  dimensions: FactorDimension[],
  scope: FactorScope = DEFAULT_FACTOR_SCOPE,
): FactorAnalysisPayload {
  const samples = rows.flatMap((r) => {
    const cell = r.cells[metric];
    if (!cell) return [];
    return [{ recordId: r.recordId, value: cell.value, isEstimated: cell.isEstimated }];
  });
  const accountMedian = medianOf(samples.map((s) => s.value));
  const groups = dimensions.map<FactorDimensionResult>((dim) => {
    const buckets = new Map<string, typeof samples>();
    for (const row of rows) {
      const cell = row.cells[metric];
      if (!cell) continue;
      const sample = { recordId: row.recordId, value: cell.value, isEstimated: cell.isEstimated };
      const key = dimensionValueOf(row, dim);
      buckets.set(key, [...(buckets.get(key) ?? []), sample]);
    }
    const list: FactorGroup[] = [...buckets.entries()]
      .map(([value, list]) => {
        const median = medianOf(list.map((s) => s.value));
        const realSamples = list.filter((s) => !s.isEstimated);
        return {
          value,
          sampleCount: list.length,
          realSampleCount: realSamples.length,
          median,
          mean: list.length === 0 ? null : list.reduce((a, b) => a + b.value, 0) / list.length,
          diff: median !== null && accountMedian !== null ? median - accountMedian : null,
          lowSample: realSamples.length < MIN_GROUP_SAMPLES,
          recordIds: list.map((s) => s.recordId),
        };
      })
      .sort((a, b) => b.sampleCount - a.sampleCount);
    return { dimension: dim, groups: list };
  });
  const platformsInSample = [...new Set(rows.map((r) => r.platform))].sort();
  const mixedPlatform = platformsInSample.length > 1;
  return {
    metric,
    accountMedian,
    accountSampleCount: samples.length,
    accountRealSampleCount: samples.filter((s) => !s.isEstimated).length,
    dimensions: groups,
    scope,
    mixedPlatform,
    platforms: platformsInSample,
    note: mixedPlatform
      ? `样本跨 ${platformsInSample.length} 个平台（${platformsInSample.join("、")}），口径不可比：分组统计仅供观察，不作为参数改动依据；相关性非因果（需求 §十四/§十五）`
      : `分组统计为相关性观察，不构成因果结论；非估算样本数 <${MIN_GROUP_SAMPLES} 的组仅供参考（需求 §十四/§十五）`,
  };
}

/**
 * 因子分析编排（只读，批次 5B）：按范围装载 → 分组统计 → 返回，不产生任何写库副作用。
 * scope 省略 = 全平台全历史（响应会自述 mixedPlatform，推荐层据此拒绝出参数建议）。
 */
export async function getFactorAnalysis(query: {
  metric: FactorMetric;
  dimensions: FactorDimension[];
  scope?: FactorScope;
}): Promise<FactorAnalysisPayload & { computedAt: string }> {
  const scope = query.scope ?? DEFAULT_FACTOR_SCOPE;
  const rows = await loadVideoRowsForScope(scope);
  const payload = computeFactorGroups(rows, query.metric, query.dimensions, scope);
  return { ...payload, computedAt: new Date().toISOString() };
}

/**
 * 落一条因子快照并取回自增 id（推荐层要把「建议出自哪次统计」钉在这里，
 * 否则证据只能靠时间猜）。事务内 max(id)：MySQL 的 drizzle insert 没有 returning，
 * 而 insert_id() 跨连接池取线会错；本仓为单写者形态。
 */
export async function saveFactorSnapshot(input: {
  payload: FactorAnalysisPayload;
  evidence: Record<string, unknown>;
}): Promise<number> {
  return await db.transaction(async (tx) => {
    await tx.insert(analysisResults).values({
      analysisType: `factors:${input.payload.metric}`,
      subjectId: null,
      result: input.payload,
      evidence: input.evidence,
      modelVersion: FACTORS_MODEL_VERSION,
    });
    const [last] = await tx
      .select({ id: analysisResults.id })
      .from(analysisResults)
      .orderBy(desc(analysisResults.id))
      .limit(1);
    const id = last?.id;
    if (id === undefined) throw new Error("因子快照写入后未取到 analysis_result.id");
    return id;
  });
}

/**
 * 显式重算并留档（POST /factors）：分组统计落 analysis_result 快照；写失败抛错由路由回 500，不再静默。
 * 返回快照 id：推荐层据此把建议与证据锚定到具体一次统计。
 */
export async function persistFactorAnalysis(query: {
  metric: FactorMetric;
  dimensions: FactorDimension[];
  scope?: FactorScope;
}): Promise<FactorAnalysisPayload & { computedAt: string; analysisResultId: number }> {
  const scope = query.scope ?? DEFAULT_FACTOR_SCOPE;
  const rows = await loadVideoRowsForScope(scope);
  const payload = computeFactorGroups(rows, query.metric, query.dimensions, scope);
  const analysisResultId = await saveFactorSnapshot({
    payload,
    evidence: {
      totalRecords: rows.length,
      metricSamples: payload.accountSampleCount,
      realMetricSamples: payload.accountRealSampleCount,
      scope,
      dimensions: query.dimensions,
      recordIds: rows.map((r) => r.recordId),
    },
  });
  return { ...payload, computedAt: new Date().toISOString(), analysisResultId };
}

/** 最近一次因子分析快照（可解释性回看；无历史返回 null） */
export async function loadLatestFactorSnapshot(metric: FactorMetric) {
  const rows = await db
    .select()
    .from(analysisResults)
    .where(eq(analysisResults.analysisType, `factors:${metric}`))
    .orderBy(desc(analysisResults.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    analysisType: row.analysisType,
    result: row.result,
    evidence: row.evidence,
    modelVersion: row.modelVersion,
    createdAt: row.createdAt.toISOString(),
  };
}
