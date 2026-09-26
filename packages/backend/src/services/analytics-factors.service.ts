/**
 * 内容因子分析服务 — 页面 D（需求 §十一 页面 D、§十四 统计口径、§十五 分组原则）
 *
 * 纪律：
 * - 早期以分组统计为主（中位数/均值/样本数），不过上机器学习；model_version 固定
 *   "group-stats-v1"，不冒充模型
 * - 每个分组必须同时给 sampleCount；组内样本 <8 标 lowSample（防 1~2 条视频误判）
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
  loadAllVideoRows,
  medianOf,
} from "./analytics-dashboard.service";

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
  sampleCount: number;
  median: number | null;
  mean: number | null;
  /** 组中位 − 账号整体中位（比率类由前端换算百分点；关联≠因果） */
  diff: number | null;
  lowSample: boolean;
}

export interface FactorDimensionResult {
  dimension: FactorDimension;
  groups: FactorGroup[];
}

export interface FactorAnalysisPayload {
  metric: FactorMetric;
  accountMedian: number | null;
  accountSampleCount: number;
  dimensions: FactorDimensionResult[];
  note: string;
}

/** 纯函数：分组统计（中位数/均值/样本数；缺目标指标的样本不计入该指标统计） */
export function computeFactorGroups(
  rows: VideoRowData[],
  metric: FactorMetric,
  dimensions: FactorDimension[],
): FactorAnalysisPayload {
  const values = rows
    .map((r) => r.cells[metric]?.value)
    .filter((v): v is number => v !== undefined);
  const accountMedian = medianOf(values);
  const groups = dimensions.map<FactorDimensionResult>((dim) => {
    const buckets = new Map<string, number[]>();
    for (const row of rows) {
      const cell = row.cells[metric];
      if (!cell) continue;
      const key = dimensionValueOf(row, dim);
      buckets.set(key, [...(buckets.get(key) ?? []), cell.value]);
    }
    const list: FactorGroup[] = [...buckets.entries()]
      .map(([value, list]) => {
        const median = medianOf(list);
        return {
          value,
          sampleCount: list.length,
          median,
          mean: list.length === 0 ? null : list.reduce((a, b) => a + b, 0) / list.length,
          diff: median !== null && accountMedian !== null ? median - accountMedian : null,
          lowSample: list.length < 8,
        };
      })
      .sort((a, b) => b.sampleCount - a.sampleCount);
    return { dimension: dim, groups: list };
  });
  return {
    metric,
    accountMedian,
    accountSampleCount: values.length,
    dimensions: groups,
    note: "分组统计为相关性观察，不构成因果结论；样本数 <8 的组仅供参考（需求 §十四/§十五）",
  };
}

/** 因子分析编排（只读，批次 5B）：装载 → 分组统计 → 返回，不产生任何写库副作用 */
export async function getFactorAnalysis(query: {
  metric: FactorMetric;
  dimensions: FactorDimension[];
}): Promise<FactorAnalysisPayload & { computedAt: string }> {
  const rows = await loadAllVideoRows();
  const payload = computeFactorGroups(rows, query.metric, query.dimensions);
  return { ...payload, computedAt: new Date().toISOString() };
}

/** 显式重算并留档（POST /factors）：分组统计落 analysis_result 快照；写失败抛错由路由回 500，不再静默 */
export async function persistFactorAnalysis(query: {
  metric: FactorMetric;
  dimensions: FactorDimension[];
}): Promise<FactorAnalysisPayload & { computedAt: string }> {
  const rows = await loadAllVideoRows();
  const payload = computeFactorGroups(rows, query.metric, query.dimensions);
  await db.insert(analysisResults).values({
    analysisType: `factors:${query.metric}`,
    subjectId: null,
    result: payload,
    evidence: {
      totalRecords: rows.length,
      metricSamples: payload.accountSampleCount,
      recordIds: rows.map((r) => r.recordId),
    },
    modelVersion: FACTORS_MODEL_VERSION,
  });
  return { ...payload, computedAt: new Date().toISOString() };
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
