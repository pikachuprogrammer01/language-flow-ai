/**
 * 推荐采纳与证据链服务（docs/22 §4.2 / §5.2，批次二）
 *
 * 两条纪律决定本文件的存在：
 * 1. 建议不能停在「系统说了什么」——必须能回放到「哪一次统计、哪些视频、哪些导入行、
 *    哪个原始字段」，否则用户无法判断该不该信。
 * 2. 采纳不能停在「点了按钮」——必须留下**用户最终提交的参数**，
 *    不然效果对比永远在拿建议值当实际值。
 *
 * 硬约束：建议值、预填值、最终值三者分开存；生成失败只留未绑定记录，不伪造 content_id；
 * 证据缺失如实返回 evidence_unavailable，绝不用别的数据拼一个看起来完整的证据。
 */
import { randomUUID } from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import {
  analysisResults,
  contentFeatures,
  contents,
  importBatch,
  importRow,
  matchDecision,
  publishRecords,
  recommendationApplications,
  recommendations,
  videoMetrics,
} from "../db/schema";
import type { MetricSourceType, PublishTimeSource } from "../lib/analytics-taxonomy";

function makeApplicationId(): string {
  return `recapp_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

// ── 采纳记录（建议 → 预填 → 最终参数 → 新内容） ──

export type ApplicationRecordResult =
  | { kind: "created"; id: string; targetMetric: string; analysisResultId: number | null }
  | { kind: "recommendation-not-found" };

/**
 * 用户点「使用推荐参数创建」时落一条采纳记录。
 * suggestedParams 从建议行当场读出（不信任前端回传），prefillParams 是页面装入的形态。
 */
export async function recordRecommendationApplication(input: {
  recommendationId: string;
  prefillParams: Record<string, unknown>;
}): Promise<ApplicationRecordResult> {
  const [rec] = await db
    .select({
      id: recommendations.id,
      recommendation: recommendations.recommendation,
      sourceMetric: recommendations.sourceMetric,
      analysisResultId: recommendations.analysisResultId,
    })
    .from(recommendations)
    .where(eq(recommendations.id, input.recommendationId))
    .limit(1);
  if (!rec) return { kind: "recommendation-not-found" };
  const id = makeApplicationId();
  await db.insert(recommendationApplications).values({
    id,
    recommendationId: rec.id,
    contentId: null,
    suggestedParams: rec.recommendation,
    prefillParams: input.prefillParams,
    finalParams: null,
    targetMetric: rec.sourceMetric,
    analysisResultId: rec.analysisResultId,
    acceptedAt: new Date(),
    appliedAt: null,
  });
  return {
    kind: "created",
    id,
    targetMetric: rec.sourceMetric,
    analysisResultId: rec.analysisResultId,
  };
}

export type ApplicationBindResult = "bound" | "not-found" | "already-bound" | "content-not-found";

/**
 * 生成成功后绑定内容与最终参数。
 *
 * 已绑定的记录不再改写（一次采纳对应一次生成；重渲染不该覆盖首次事实）。
 * 内容不存在时拒绝绑定——宁缺勿假，留 NULL 就是「采纳了但没生成成功」。
 */
export async function bindRecommendationApplication(
  id: string,
  bind: { contentId: string; finalParams: Record<string, unknown> },
): Promise<ApplicationBindResult> {
  const [existing] = await db
    .select({ id: recommendationApplications.id, appliedAt: recommendationApplications.appliedAt })
    .from(recommendationApplications)
    .where(eq(recommendationApplications.id, id))
    .limit(1);
  if (!existing) return "not-found";
  if (existing.appliedAt !== null) return "already-bound";
  const [content] = await db
    .select({ id: contents.id })
    .from(contents)
    .where(eq(contents.id, bind.contentId))
    .limit(1);
  if (!content) return "content-not-found";
  await db
    .update(recommendationApplications)
    .set({
      contentId: bind.contentId,
      finalParams: bind.finalParams,
      appliedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(recommendationApplications.id, id));
  return "bound";
}

/** 一条内容的采纳回放（新建页/详情页回答「这集是按哪条建议生成的吗」） */
export async function listApplicationsByContent(contentId: string) {
  const rows = await db
    .select()
    .from(recommendationApplications)
    .where(eq(recommendationApplications.contentId, contentId))
    .orderBy(asc(recommendationApplications.acceptedAt));
  return rows.map((r) => ({
    id: r.id,
    recommendationId: r.recommendationId,
    suggestedParams: r.suggestedParams,
    prefillParams: r.prefillParams,
    finalParams: r.finalParams,
    targetMetric: r.targetMetric,
    analysisResultId: r.analysisResultId,
    acceptedAt: r.acceptedAt.toISOString(),
    appliedAt: r.appliedAt ? r.appliedAt.toISOString() : null,
  }));
}

// ── 证据链 ──

export interface EvidenceMetricCell {
  value: number;
  sourceType: MetricSourceType;
  sourceField: string | null;
  dataDate: string | null;
  isEstimated: boolean;
  /** 来源批次与原始行号：这两个为 null 表示该值不是导入来的（如平台计算派生/人工录入） */
  batchId: string | null;
  importRowNumber: number | null;
  matchedBy: string | null;
}

export interface EvidenceVideo {
  recordId: string;
  contentId: string;
  title: string;
  platform: string;
  platformVideoId: string | null;
  publishStatus: string;
  publishTime: string | null;
  publishTimeSource: PublishTimeSource | null;
  videoAssetId: string | null;
  metrics: Record<string, EvidenceMetricCell>;
  /** 生产参数（content_features）与字段级来源；null = 该行还没落特征 */
  features: Record<string, unknown> | null;
  fieldSources: Record<string, string> | null;
  /** 审计档案可用性与其中实际存在的输入键（有就列，没有就说没有，不猜） */
  auditAvailable: boolean;
  auditInputKeys: string[];
}

export interface EvidenceImportRow {
  batchId: string;
  rowNumber: number;
  filename: string | null;
  batchPlatform: string | null;
  batchStatus: string | null;
  /** 原始整行（import_row.raw_data 永久保留，这里原样给出） */
  rawData: unknown;
  matchStatus: string | null;
  decisionType: string | null;
}

export interface RecommendationEvidence {
  recommendationId: string;
  recommendationType: string;
  recommendation: unknown;
  reason: string;
  targetMetric: string;
  sourceSampleCount: number;
  analysisResultId: number | null;
  /** traceable=证据齐；evidence_unavailable=如实说明缺哪一环 */
  status: "traceable" | "evidence_unavailable";
  unavailableReasons: string[];
  snapshot: {
    analysisType: string;
    modelVersion: string;
    computedAt: string;
    scope: unknown;
    /** 快照里的分组统计（含 recordIds）；只保留与本建议相关的那一组于 groups 字段 */
    accountMedian: number | null;
    accountSampleCount: number | null;
    accountRealSampleCount: number | null;
  } | null;
  groups: {
    dimension: string;
    value: string;
    sampleCount: number;
    realSampleCount: number;
    median: number | null;
    mean: number | null;
    recordIds: string[];
  }[];
  videos: EvidenceVideo[];
  importRows: EvidenceImportRow[];
}

/** null = 推荐本身不存在（路由回 404）；status=evidence_unavailable 是「有建议但证据缺一环」 */
export async function getRecommendationEvidence(
  recommendationId: string,
): Promise<RecommendationEvidence | null> {
  const [rec] = await db
    .select()
    .from(recommendations)
    .where(eq(recommendations.id, recommendationId))
    .limit(1);
  if (!rec) return null;
  const base: RecommendationEvidence = {
    recommendationId: rec.id,
    recommendationType: rec.recommendationType,
    recommendation: rec.recommendation,
    reason: rec.reason,
    targetMetric: rec.sourceMetric,
    sourceSampleCount: rec.sourceSampleCount,
    analysisResultId: rec.analysisResultId,
    status: "traceable",
    unavailableReasons: [],
    snapshot: null,
    groups: [],
    videos: [],
    importRows: [],
  };
  const snapshot =
    rec.analysisResultId === null
      ? null
      : await db
          .select()
          .from(analysisResults)
          .where(eq(analysisResults.id, rec.analysisResultId))
          .limit(1);
  if (rec.analysisResultId !== null && (snapshot?.length ?? 0) === 0) {
    // 引用了快照但快照行不在：这是断链，比「没有快照」更该被看见
    return {
      ...base,
      status: "evidence_unavailable",
      unavailableReasons: [`引用的因子快照 analysis_result#${rec.analysisResultId} 不存在`],
    };
  }
  if (!snapshot?.[0]) {
    return {
      ...base,
      status: "evidence_unavailable",
      unavailableReasons: ["该建议产出时尚未留档因子快照，无法回放分组统计与参与样本"],
    };
  }
  return assembleEvidence(rec, snapshot[0]);
}

type RecommendationRow = typeof recommendations.$inferSelect;
type SnapshotRow = typeof analysisResults.$inferSelect;

interface SnapshotPayload {
  metric?: string;
  accountMedian?: number | null;
  accountSampleCount?: number;
  accountRealSampleCount?: number;
  scope?: unknown;
  dimensions?: {
    dimension: string;
    groups: {
      value: string;
      sampleCount: number;
      realSampleCount?: number;
      median?: number | null;
      mean?: number | null;
      recordIds?: string[];
    }[];
  }[];
}

/** 建议类型 → 分组维度（与建议生成侧同一张表，避免两处各写一份映射） */
const TYPE_TO_DIMENSION: Record<string, string> = {
  hook: "hook",
  scene: "scene",
  duration: "durationBand",
  knowledge_points: "segmentCountBand",
  speech_rate: "speechRateBand",
  cta: "ctaType",
  template: "template",
};

function matchedGroups(rec: RecommendationRow, payload: SnapshotPayload) {
  const dimension = TYPE_TO_DIMENSION[rec.recommendationType];
  const value = (rec.recommendation as { value?: unknown } | null)?.value;
  const dims = payload.dimensions ?? [];
  return dims
    .filter((d) => (dimension ? d.dimension === dimension : true))
    .flatMap((d) =>
      d.groups
        .filter((g) => (dimension ? g.value === value : true))
        .map((g) => ({
          dimension: d.dimension,
          value: g.value,
          sampleCount: g.sampleCount,
          realSampleCount: g.realSampleCount ?? g.sampleCount,
          median: g.median ?? null,
          mean: g.mean ?? null,
          recordIds: g.recordIds ?? [],
        })),
    );
}

async function assembleEvidence(
  rec: RecommendationRow,
  snap: SnapshotRow,
): Promise<RecommendationEvidence> {
  const payload = (snap.result ?? {}) as SnapshotPayload;
  const groups = matchedGroups(rec, payload);
  const recordIds = [...new Set(groups.flatMap((g) => g.recordIds))];
  const head: RecommendationEvidence = {
    recommendationId: rec.id,
    recommendationType: rec.recommendationType,
    recommendation: rec.recommendation,
    reason: rec.reason,
    targetMetric: rec.sourceMetric,
    sourceSampleCount: rec.sourceSampleCount,
    analysisResultId: snap.id,
    status: "traceable",
    unavailableReasons: [],
    snapshot: {
      analysisType: snap.analysisType,
      modelVersion: snap.modelVersion,
      computedAt: snap.createdAt.toISOString(),
      scope: payload.scope ?? null,
      accountMedian: payload.accountMedian ?? null,
      accountSampleCount: payload.accountSampleCount ?? null,
      accountRealSampleCount: payload.accountRealSampleCount ?? null,
    },
    groups,
    videos: [],
    importRows: [],
  };
  if (groups.length === 0 || recordIds.length === 0) {
    // data_readiness 类建议按设计不对应任何分组（它说的是「还不够出建议」），
    // 依据就是快照里的整体样本量——这是可回放的证据，不是断链
    const isReadiness = rec.recommendationType === "data_readiness";
    return {
      ...head,
      status: isReadiness ? "traceable" : "evidence_unavailable",
      unavailableReasons: [
        isReadiness
          ? `数据准备类建议不对应分组；依据为快照的整体样本量口径（真实样本 ${payload.accountRealSampleCount ?? 0} 条 / 覆盖 ${payload.accountSampleCount ?? 0} 条）`
          : "快照里找不到与该建议匹配的分组，或该分组没有参与样本记录",
      ],
    };
  }
  const rows = await db
    .select({
      recordId: publishRecords.id,
      contentId: publishRecords.contentId,
      title: contents.title,
      contentStatus: contents.status,
      audit: contents.audit,
      platform: publishRecords.platform,
      platformVideoId: publishRecords.platformVideoId,
      publishStatus: publishRecords.publishStatus,
      publishTime: publishRecords.publishTime,
      publishTimeSource: publishRecords.publishTimeSource,
      videoAssetId: publishRecords.videoAssetId,
    })
    .from(publishRecords)
    .innerJoin(contents, eq(contents.id, publishRecords.contentId))
    .where(inArray(publishRecords.id, recordIds));
  const contentIds = [...new Set(rows.map((r) => r.contentId))];
  const [metrics, features] = await Promise.all([
    db
      .select({
        publishRecordId: videoMetrics.publishRecordId,
        metricName: videoMetrics.metricName,
        metricValue: videoMetrics.metricValue,
        sourceType: videoMetrics.sourceType,
        sourceField: videoMetrics.sourceField,
        dataDate: videoMetrics.dataDate,
        isEstimated: videoMetrics.isEstimated,
        metadata: videoMetrics.metadata,
      })
      .from(videoMetrics)
      .where(inArray(videoMetrics.publishRecordId, recordIds)),
    db.select().from(contentFeatures).where(inArray(contentFeatures.contentId, contentIds)),
  ]);
  const cellsByRecord = groupMetricCells(metrics);
  const featureByContent = new Map(features.map((f) => [f.contentId, f]));
  const videos = rows.map<EvidenceVideo>((r) => {
    const feature = featureByContent.get(r.contentId);
    const audit = asRecord(r.audit);
    const auditInput = asRecord(audit?.input);
    return {
      recordId: r.recordId,
      contentId: r.contentId,
      title: r.title,
      platform: r.platform,
      platformVideoId: r.platformVideoId,
      publishStatus: r.publishStatus,
      publishTime: r.publishTime ? r.publishTime.toISOString() : null,
      publishTimeSource: r.publishTimeSource,
      videoAssetId: r.videoAssetId,
      metrics: cellsByRecord.get(r.recordId) ?? {},
      features: feature ? featureViewOf(feature) : null,
      fieldSources: (feature?.fieldSources as Record<string, string> | undefined) ?? null,
      auditAvailable: audit !== null,
      auditInputKeys: auditInput ? Object.keys(auditInput) : [],
    };
  });
  const importRows = await loadImportProvenance(metrics);
  const missing = importRows.missingProvenanceRecords;
  const reasons: string[] = [];
  if (missing.length > 0) {
    reasons.push(
      `${missing.length} 条记录的指标行没有 batch_id/import_row 留痕（人工录入或平台计算），只能追到字段名层级`,
    );
  }
  return {
    ...head,
    videos,
    importRows: importRows.rows,
    unavailableReasons: reasons,
    // 部分缺 provenance 不算整条证据不可用：能追到哪一层就说到哪一层
    status: "traceable",
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

type FeatureRow = typeof contentFeatures.$inferSelect;

/** 只外露分析用得上的生产字段，且带上字段级来源（哪个值是生产事实、哪个是人工标的） */
function featureViewOf(f: FeatureRow): Record<string, unknown> {
  return {
    template: f.template,
    level: f.level,
    duration: f.duration,
    knowledgePointCount: f.knowledgePointCount,
    segmentCount: f.segmentCount,
    dialogueCount: f.dialogueCount,
    speechRate: f.speechRate,
    voiceId: f.voiceId,
    bgm: f.bgm,
    subtitleType: f.subtitleType,
    shotCount: f.shotCount,
    introEffect: f.introEffect,
    promptVersion: f.promptVersion,
    rendererVersion: f.rendererVersion,
    hook: f.hook,
    scene: f.scene,
    contentFormat: f.contentFormat,
    emotion: f.emotion,
    ctaType: f.ctaType,
  };
}

function groupMetricCells(
  metrics: {
    publishRecordId: string;
    metricName: string;
    metricValue: number;
    sourceType: MetricSourceType;
    sourceField: string | null;
    dataDate: string | null;
    isEstimated: number;
    metadata: unknown;
  }[],
): Map<string, Record<string, EvidenceMetricCell>> {
  const byRecord = new Map<string, Record<string, EvidenceMetricCell>>();
  for (const m of metrics) {
    const meta = asRecord(m.metadata);
    const cells = byRecord.get(m.publishRecordId) ?? {};
    cells[m.metricName] = {
      value: m.metricValue,
      sourceType: m.sourceType,
      sourceField: m.sourceField,
      dataDate: m.dataDate,
      isEstimated: m.isEstimated === 1,
      batchId: typeof meta?.batch_id === "string" ? meta.batch_id : null,
      importRowNumber: typeof meta?.import_row === "number" ? meta.import_row : null,
      matchedBy: typeof meta?.matched_by === "string" ? meta.matched_by : null,
    };
    byRecord.set(m.publishRecordId, cells);
  }
  return byRecord;
}

/** 指标行 → 导入批次与原始行（含裁决方式）；返回缺留痕的记录 id 供上层如实说明 */
async function loadImportProvenance(
  metrics: {
    publishRecordId: string;
    metadata: unknown;
  }[],
): Promise<{ rows: EvidenceImportRow[]; missingProvenanceRecords: string[] }> {
  const keys = new Map<string, { batchId: string; rowNumber: number }>();
  const missing: string[] = [];
  for (const m of metrics) {
    const meta = asRecord(m.metadata);
    const batchId = typeof meta?.batch_id === "string" ? meta.batch_id : null;
    const rowNumber = typeof meta?.import_row === "number" ? meta.import_row : null;
    if (batchId === null || rowNumber === null) {
      if (!missing.includes(m.publishRecordId)) missing.push(m.publishRecordId);
      continue;
    }
    keys.set(`${batchId}#${rowNumber}`, { batchId, rowNumber });
  }
  if (keys.size === 0) return { rows: [], missingProvenanceRecords: missing };
  const pairs = [...keys.values()];
  // metadata 只存 (batch_id, import_row 行号)，没存导入行自增 id → 按批次一次取回再本地筛
  const [resolved, decisions] = await Promise.all([
    fetchRowsByKeys(pairs),
    db
      .select()
      .from(matchDecision)
      .where(inArray(matchDecision.batchId, [...new Set(pairs.map((p) => p.batchId))])),
  ]);
  const decisionByRowId = new Map(decisions.map((d) => [d.importRowId, d]));
  return {
    rows: resolved.map((r) => ({
      batchId: r.batchId,
      rowNumber: r.rowNumber,
      filename: r.filename,
      batchPlatform: r.batchPlatform,
      batchStatus: r.batchStatus,
      rawData: r.rawData,
      matchStatus: r.matchStatus,
      decisionType: decisionByRowId.get(r.id)?.decisionType ?? null,
    })),
    missingProvenanceRecords: missing,
  };
}

/** 按 (batch_id, row_number) 组合回查原始行；raw_data 永久保留，这里原样取出 */
async function fetchRowsByKeys(pairs: { batchId: string; rowNumber: number }[]) {
  const wanted = new Set(pairs.map((p) => `${p.batchId}#${p.rowNumber}`));
  const rows = await db
    .select({
      id: importRow.id,
      batchId: importRow.batchId,
      rowNumber: importRow.rowNumber,
      rawData: importRow.rawData,
      matchStatus: importRow.matchStatus,
      filename: importBatch.filename,
      batchPlatform: importBatch.platform,
      batchStatus: importBatch.status,
    })
    .from(importRow)
    .innerJoin(importBatch, eq(importBatch.id, importRow.batchId))
    .where(inArray(importRow.batchId, [...new Set(pairs.map((p) => p.batchId))]))
    .orderBy(asc(importRow.batchId), asc(importRow.rowNumber));
  return rows.filter((r) => wanted.has(`${r.batchId}#${r.rowNumber}`));
}
