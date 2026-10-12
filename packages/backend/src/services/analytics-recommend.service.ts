/**
 * 生产优化建议服务 — Phase 4 优化闭环（需求 §八.8 / §十六 / §十七）+ 批次二证据链（docs/22 §6）
 *
 * 纪律：
 * - 建议从因子分组统计派生（computeFactorGroups）；行动门槛数的是**非估算真实样本**
 *   （realSampleCount ≥ MIN_GROUP_SAMPLES），估算值（如窗口归因涨粉）凑不出建议
 * - 样本集跨平台时拒绝出参数改动建议（口径不可比），只给 data_readiness（docs/22 §6.2）
 * - 每条建议必携 reason（哪个平台、哪个窗口、哪个指标、组中位 vs 账号中位、真实样本数）
 *   与 sourceSampleCount / sourceMetric / analysisResultId（§十二 可解释 + 证据可回放）
 * - 「复用成功结构」从 video_segment 真实派生骨架（结构序列 + 时长占比），不复制内容（§十七）
 * - accepted / applied_to_content_id 构成采纳回路；最终参数落在 recommendation_applications
 */
import { randomUUID } from "node:crypto";
import { count, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { publishRecords, recommendations, type videoSegments } from "../db/schema";
import { loadVideoRowsForScope } from "./analytics-dashboard.service";
import {
  DEFAULT_FACTOR_SCOPE,
  type FactorAnalysisPayload,
  type FactorDimension,
  type FactorGroup,
  type FactorMetric,
  type FactorScope,
  MIN_GROUP_SAMPLES,
  computeFactorGroups,
  saveFactorSnapshot,
} from "./analytics-factors.service";
import { loadContentSegments } from "./analytics-segment.service";

/** 建议判定的主指标（完播率——内容质量综合代理；多指标可后续扩展） */
export const RECOMMEND_SOURCE_METRIC = "completion_rate";

const RECOMMEND_DIMENSIONS: { dim: FactorDimension; type: string; label: string }[] = [
  { dim: "hook", type: "hook", label: "推荐 Hook" },
  { dim: "scene", type: "scene", label: "推荐场景" },
  { dim: "durationBand", type: "duration", label: "推荐时长带" },
  { dim: "segmentCountBand", type: "knowledge_points", label: "推荐段落/知识点密度" },
  { dim: "speechRateBand", type: "speech_rate", label: "推荐语速" },
  { dim: "ctaType", type: "cta", label: "推荐 CTA" },
  { dim: "template", type: "template", label: "推荐模板" },
];

/** 维度取值中文标签（建议展示用；与前端选项同源枚举） */
const VALUE_LABELS: Record<string, string> = {
  mistake: "错误示范",
  warning: "警告提醒",
  question: "提问",
  conflict: "冲突",
  curiosity: "悬念",
  quiz: "选择题",
  pain_point: "痛点",
  counter_intuitive: "反常识",
  identity: "身份认同",
  result_first: "结果先行",
  restaurant: "餐厅",
  airport: "机场",
  hotel: "酒店",
  workplace: "职场",
  interview: "面试",
  shopping: "购物",
  hospital: "医院",
  school: "学校",
  travel: "旅行",
  dating: "约会",
  social: "社交",
  daily_life: "日常生活",
  scene_word: "情景背词",
  word_card: "单词卡片",
  quiz_question: "选择题",
  lt_15: "<15s",
  "15_30": "15~30s",
  "30_60": "30~60s",
  "60_120": "60~120s",
  gte_120: "≥120s",
};

export function valueLabelOf(value: string): string {
  return VALUE_LABELS[value] ?? value;
}

export interface RecommendationDraft {
  recommendationType: string;
  recommendation: { value: string; label: string; kindLabel: string };
  reason: string;
  sourceSampleCount: number;
  sourceMetric: string;
  confidence: number | null;
  /** actionable=可据此改参数；data_readiness=只说还缺什么数据，不给参数改动结论 */
  kind: "actionable" | "data_readiness";
}

/**
 * 纯函数：从分组中挑最优（剔除「未标注」桶与低真实样本组；中位数最高，同值取样本多者）。
 *
 * lowSample 由 computeFactorGroups 按**非估算**样本判定，所以估算值堆不出可行动组。
 */
export function pickBestGroup(groups: FactorGroup[]): FactorGroup | null {
  const eligible = groups.filter((g) => g.value !== "未标注" && !g.lowSample && g.median !== null);
  if (eligible.length === 0) return null;
  return (
    [...eligible].sort(
      (a, b) => (b.median ?? 0) - (a.median ?? 0) || b.realSampleCount - a.realSampleCount,
    )[0] ?? null
  );
}

/** 范围文案（建议必须自述口径，否则用户无法判断这条建议是从哪些数据来的） */
export function scopeTextOf(scope: FactorScope): string {
  const platform = scope.platform ?? "未限定平台";
  const window = scope.windowDays === null ? "全部历史" : `近 ${scope.windowDays} 天`;
  return `${platform} · ${window}`;
}

/**
 * 纯函数：由已算好的因子分组结果出建议清单。
 * 拆成两层（分组 → 建议）是为了让生成链路能复用同一份分组结果做留档快照，
 * 而不是算两遍统计再指望它们恰好一致。
 *
 * 拒绝出参数建议的情形（docs/22 §6.2，一律转 data_readiness）：
 * 1. 样本集跨平台——播放/完播口径不同，合并出来的组不代表任何真实平台；
 * 2. 没有任何组达到 MIN_GROUP_SAMPLES 个非估算真实样本。
 * 未指定 days 时窗口即「全部历史」——它同样是**一个**被明示的窗口，
 * 不违反「同窗口」（真正的风险是把不同观察长度的数据混进一组）。
 */
export function recommendDraftsFromPayload(payload: FactorAnalysisPayload): RecommendationDraft[] {
  const scopeText = scopeTextOf(payload.scope);
  const drafts: RecommendationDraft[] = [];
  if (!payload.mixedPlatform) {
    for (const { dim, type, label } of RECOMMEND_DIMENSIONS) {
      const result = payload.dimensions.find((d) => d.dimension === dim);
      if (!result) continue;
      const best = pickBestGroup(result.groups);
      if (!best || best.median === null) continue;
      const diff = best.median - (payload.accountMedian ?? 0);
      const diffText = payload.accountMedian === null ? "—" : `${(diff * 100).toFixed(1)}pp`;
      drafts.push({
        recommendationType: type,
        recommendation: { value: best.value, label: valueLabelOf(best.value), kindLabel: label },
        reason: `${scopeText} · ${label}「${valueLabelOf(best.value)}」组 ${payload.metric} 中位 ${(best.median * 100).toFixed(1)}%（同范围中位 ${((payload.accountMedian ?? 0) * 100).toFixed(1)}%，差 ${diffText}，真实样本 n=${best.realSampleCount}/共 ${best.sampleCount} 条）。这是同范围观察到的关联，不是因果结论`,
        sourceSampleCount: best.realSampleCount,
        sourceMetric: payload.metric,
        confidence: best.realSampleCount >= 15 ? 0.7 : 0.5,
        kind: "actionable",
      });
    }
  }
  if (drafts.length === 0) {
    const estimated = payload.accountSampleCount - payload.accountRealSampleCount;
    const detail = payload.mixedPlatform
      ? `样本跨 ${payload.platforms.join("、")} 共 ${payload.platforms.length} 个平台，口径不可比，需按单平台分别统计`
      : `有 ${payload.accountRealSampleCount} 条真实样本带 ${payload.metric}${estimated > 0 ? `（另有 ${estimated} 条为估算值，不计入行动门槛）` : ""}，但无分组达到最小真实样本量 ${MIN_GROUP_SAMPLES}`;
    drafts.push({
      recommendationType: "data_readiness",
      recommendation: {
        value: "import_more",
        // 文案带平台：建议是按平台分别生成的，「还缺数据」也必须点名缺哪个平台，
        // 否则多平台账号会看到几张一模一样的卡，分不清在说谁
        label: `${payload.scope.platform ?? ""}继续导入创作者数据并标注场景/Hook`,
        kindLabel: "数据准备",
      },
      reason: `${scopeText} · ${detail}：样本不足时不出参数建议（需求 §十四）`,
      sourceSampleCount: payload.accountRealSampleCount,
      sourceMetric: payload.metric,
      confidence: null,
      kind: "data_readiness",
    });
  }
  return drafts;
}

/** 纯函数：由发布样本行构建建议清单（跨平台 / 小样本 → 只有 data_readiness） */
export function buildRecommendations(
  rows: Parameters<typeof computeFactorGroups>[0],
  metric: FactorMetric = RECOMMEND_SOURCE_METRIC as FactorMetric,
  scope: FactorScope = DEFAULT_FACTOR_SCOPE,
): RecommendationDraft[] {
  return recommendDraftsFromPayload(
    computeFactorGroups(
      rows,
      metric,
      RECOMMEND_DIMENSIONS.map((d) => d.dim),
      scope,
    ),
  );
}

export interface StructureSkeletonItem {
  idx: number;
  segmentType: string;
  label: string;
  startTime: number;
  endTime: number;
  durationShare: number;
  knowledgePoint: string | null;
}

/** 纯函数：段落 → 可复用结构骨架（时间序列与占比；换主题/场景/词汇时保留结构，§十七） */
export function buildStructureSkeleton(
  segments: Pick<
    typeof videoSegments.$inferSelect,
    "idx" | "segmentType" | "startTime" | "endTime" | "knowledgePoint"
  >[],
  totalDuration: number,
): StructureSkeletonItem[] {
  if (segments.length === 0 || totalDuration <= 0) return [];
  let bodyIndex = 0;
  return segments.map((s) => {
    if (s.segmentType !== "intro") bodyIndex += 1;
    return {
      idx: s.idx,
      segmentType: s.segmentType,
      label: s.segmentType === "intro" ? "片头" : `正文第 ${bodyIndex} 段`,
      startTime: s.startTime,
      endTime: s.endTime,
      durationShare: Math.round(((s.endTime - s.startTime) / totalDuration) * 1000) / 1000,
      knowledgePoint: s.knowledgePoint,
    };
  });
}

// ── 编排（io） ──

function makeRecommendationId(): string {
  return `rec_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

/**
 * 建议默认统计窗口（天）。滚动窗口必须是一个明示的数字，否则分组集会随每天导入漂移，
 * 同一条建议昨天成立今天不成立，用户无法复现（docs/22 §6.1「同时间窗口」）。
 */
export const DEFAULT_RECOMMEND_WINDOW_DAYS = 90;

/** 账号实际发到过哪些平台（推荐按平台分别生成，绝不把两个平台的样本混成一个组） */
async function platformsInAccount(): Promise<string[]> {
  const rows = await db
    .select({ platform: publishRecords.platform })
    .from(publishRecords)
    .groupBy(publishRecords.platform);
  return rows.map((r) => r.platform);
}

/**
 * 重新生成建议：清空待处理建议 → 按最新数据逐平台落新建议（已采纳/已忽略的历史保留）。
 *
 * 每条建议都先留一份因子快照，再把 analysis_result_id 钉在建议上：
 * 证据接口据此回放「哪一次统计、哪些视频、哪些导入行」，不靠时间戳猜。
 * 账号还没有任何发布记录时，只留一条无快照的 data_readiness（不伪造一次统计）。
 */
export async function generateRecommendations(): Promise<number> {
  const platforms = await platformsInAccount();
  const drafts: RecommendationDraft[] = [];
  const snapshotIds: (number | null)[] = [];
  for (const platform of platforms) {
    const scope: FactorScope = { platform, windowDays: DEFAULT_RECOMMEND_WINDOW_DAYS };
    const rows = await loadVideoRowsForScope(scope);
    const payload = computeFactorGroups(
      rows,
      RECOMMEND_SOURCE_METRIC as FactorMetric,
      RECOMMEND_DIMENSIONS.map((d) => d.dim),
      scope,
    );
    const analysisResultId = await saveFactorSnapshot({
      payload,
      evidence: {
        totalRecords: rows.length,
        metricSamples: payload.accountSampleCount,
        realMetricSamples: payload.accountRealSampleCount,
        scope,
        dimensions: RECOMMEND_DIMENSIONS.map((d) => d.dim),
        recordIds: rows.map((r) => r.recordId),
      },
    });
    for (const draft of recommendDraftsFromPayload(payload)) {
      drafts.push(draft);
      snapshotIds.push(analysisResultId);
    }
  }
  if (drafts.length === 0) {
    drafts.push({
      recommendationType: "data_readiness",
      recommendation: {
        value: "import_more",
        label: "先在数据接入登记发布记录并导入指标",
        kindLabel: "数据准备",
      },
      reason: `账号还没有可用于分析的发布记录（${scopeTextOf({ platform: null, windowDays: DEFAULT_RECOMMEND_WINDOW_DAYS })}）：没有真实样本时不出任何参数建议`,
      sourceSampleCount: 0,
      sourceMetric: RECOMMEND_SOURCE_METRIC,
      confidence: null,
      kind: "data_readiness",
    });
    snapshotIds.push(null);
  }
  await db.delete(recommendations).where(isNull(recommendations.accepted));
  // 逐字段落库（不 spread draft）：draft.kind 是给纯函数用例判定建议类型的，不是列，
  // 多塞一个键进 insert 会让运行时报 Unknown column
  await db.insert(recommendations).values(
    drafts.map((d, i) => ({
      id: makeRecommendationId(),
      recommendationType: d.recommendationType,
      recommendation: d.recommendation,
      reason: d.reason,
      sourceSampleCount: d.sourceSampleCount,
      sourceMetric: d.sourceMetric,
      confidence: d.confidence,
      analysisResultId: snapshotIds[i] ?? null,
      accepted: null,
      appliedToContentId: null,
    })),
  );
  return drafts.length;
}

export interface RecommendationView {
  id: string;
  recommendationType: string;
  recommendation: unknown;
  reason: string;
  sourceSampleCount: number;
  sourceMetric: string;
  confidence: number | null;
  accepted: boolean | null;
  appliedToContentId: string | null;
  createdAt: string;
}

function toView(row: typeof recommendations.$inferSelect): RecommendationView {
  return {
    id: row.id,
    recommendationType: row.recommendationType,
    recommendation: row.recommendation,
    reason: row.reason,
    sourceSampleCount: row.sourceSampleCount,
    sourceMetric: row.sourceMetric,
    confidence: row.confidence,
    accepted: row.accepted === null ? null : row.accepted === 1,
    appliedToContentId: row.appliedToContentId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** 建议清单（pending 在前，其余按时间倒序）+ 采纳回路汇总 */
export async function listRecommendations(): Promise<{
  items: RecommendationView[];
  summary: { total: number; pending: number; accepted: number; rejected: number; applied: number };
}> {
  const rows = await db
    .select()
    .from(recommendations)
    .orderBy(desc(recommendations.createdAt))
    .limit(100);
  const counts = await db
    .select({
      total: count(),
      pending: sql<number>`sum(case when ${recommendations.accepted} is null then 1 else 0 end)`,
      accepted: sql<number>`sum(case when ${recommendations.accepted} = 1 then 1 else 0 end)`,
      rejected: sql<number>`sum(case when ${recommendations.accepted} = 0 then 1 else 0 end)`,
      applied: sql<number>`sum(case when ${recommendations.appliedToContentId} is not null then 1 else 0 end)`,
    })
    .from(recommendations);
  const c = counts[0] ?? { total: 0, pending: 0, accepted: 0, rejected: 0, applied: 0 };
  return {
    items: rows.map(toView),
    summary: {
      total: Number(c.total),
      pending: Number(c.pending),
      accepted: Number(c.accepted),
      rejected: Number(c.rejected),
      // applied = 真的回写过 appliedToContentId 的条数（历史上这里写成 total-applied，
      // 于是页面把「一条都没产出」显示成「已产出 N 条」）
      applied: Number(c.applied),
    },
  };
}

/** 采纳/忽略决策与效果回路写入 */
export async function decideRecommendation(
  id: string,
  decision: { accepted: boolean; appliedToContentId?: string | null },
): Promise<RecommendationView | null> {
  const rows = await db.select().from(recommendations).where(eq(recommendations.id, id)).limit(1);
  const existing = rows[0];
  if (!existing) return null;
  await db
    .update(recommendations)
    .set({
      accepted: decision.accepted ? 1 : 0,
      ...(decision.appliedToContentId !== undefined
        ? { appliedToContentId: decision.appliedToContentId }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(recommendations.id, id));
  const updated = await db
    .select()
    .from(recommendations)
    .where(eq(recommendations.id, id))
    .limit(1);
  return updated[0] ? toView(updated[0]) : null;
}

/** 单视频可复用结构骨架（§十七；无段落 → null 由路由回 not_derived） */
export async function getVideoStructure(contentId: string): Promise<{
  skeleton: StructureSkeletonItem[];
  totalDuration: number | null;
} | null> {
  const segments = await loadContentSegments(contentId);
  if (segments.length === 0) return null;
  const total = segments[segments.length - 1]?.endTime ?? null;
  if (total === null) return null;
  return { skeleton: buildStructureSkeleton(segments, total), totalDuration: total };
}
