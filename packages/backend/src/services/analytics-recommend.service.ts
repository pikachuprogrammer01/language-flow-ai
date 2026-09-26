/**
 * 生产优化建议服务 — Phase 4 优化闭环（需求 §八.8 / §十六 / §十七）
 *
 * 纪律：
 * - 建议从因子分组统计派生（computeFactorGroups），仅当分组样本数 ≥ MIN_GROUP_SAMPLES(8)
 *   才产出参数建议（§十四 小样本不下结论）；样本不足时产出 data_readiness 建议（如实）
 * - 每条建议必携 reason（哪个指标、组中位 vs 账号中位、样本数）与 sourceSampleCount（§十二 可解释）
 * - 「复用成功结构」从 video_segment 真实派生骨架（结构序列 + 时长占比），不复制内容（§十七）
 * - accepted / applied_to_content_id 构成采纳回路（§八.8：建议是否被采用、采用后效果是否提升）
 */
import { randomUUID } from "node:crypto";
import { count, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { recommendations, type videoSegments } from "../db/schema";
import { loadAllVideoRows } from "./analytics-dashboard.service";
import {
  type FactorDimension,
  type FactorGroup,
  type FactorMetric,
  computeFactorGroups,
} from "./analytics-factors.service";
import { loadContentSegments } from "./analytics-segment.service";

/** 分组建议的最小样本数（低于此值只给数据准备建议，§十四） */
export const MIN_GROUP_SAMPLES = 8;

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
}

/** 纯函数：从分组中挑最优（剔除「未标注」桶与低样本组；中位数最高，同值取样本多者） */
export function pickBestGroup(groups: FactorGroup[]): FactorGroup | null {
  const eligible = groups.filter((g) => g.value !== "未标注" && !g.lowSample && g.median !== null);
  if (eligible.length === 0) return null;
  return (
    [...eligible].sort(
      (a, b) => (b.median ?? 0) - (a.median ?? 0) || b.sampleCount - a.sampleCount,
    )[0] ?? null
  );
}

/** 纯函数：由发布样本行构建建议清单（无合格分组 → data_readiness 诚实建议） */
export function buildRecommendations(
  rows: Parameters<typeof computeFactorGroups>[0],
  metric: FactorMetric = RECOMMEND_SOURCE_METRIC as FactorMetric,
): RecommendationDraft[] {
  const payload = computeFactorGroups(
    rows,
    metric,
    RECOMMEND_DIMENSIONS.map((d) => d.dim),
  );
  const drafts: RecommendationDraft[] = [];
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
      reason: `${label}「${valueLabelOf(best.value)}」组 ${metric} 中位 ${(best.median * 100).toFixed(1)}%（账号中位 ${((payload.accountMedian ?? 0) * 100).toFixed(1)}%，差 ${diffText}，n=${best.sampleCount}）`,
      sourceSampleCount: best.sampleCount,
      sourceMetric: metric,
      confidence: best.sampleCount >= 15 ? 0.7 : 0.5,
    });
  }
  if (drafts.length === 0) {
    drafts.push({
      recommendationType: "data_readiness",
      recommendation: {
        value: "import_more",
        label: "继续导入创作者数据并标注场景/Hook",
        kindLabel: "数据准备",
      },
      reason: `有 ${payload.accountSampleCount} 条样本带 ${metric}，但无分组达到最小样本量 ${MIN_GROUP_SAMPLES}：样本不足时不出参数建议（需求 §十四）`,
      sourceSampleCount: payload.accountSampleCount,
      sourceMetric: metric,
      confidence: null,
    });
  }
  return drafts;
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

/** 重新生成建议：清空待处理建议 → 按最新数据落新建议（已采纳/已忽略的历史保留） */
export async function generateRecommendations(): Promise<number> {
  const rows = await loadAllVideoRows();
  const drafts = buildRecommendations(rows);
  await db.delete(recommendations).where(isNull(recommendations.accepted));
  if (drafts.length > 0) {
    await db.insert(recommendations).values(
      drafts.map((d) => ({
        id: makeRecommendationId(),
        ...d,
        accepted: null,
        appliedToContentId: null,
      })),
    );
  }
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
      applied: Number(c.total) - Number(c.applied),
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
