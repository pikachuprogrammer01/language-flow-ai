/**
 * 平台数据导入·四步精准匹配 — 批次生命周期服务
 * draft → granularity_confirmed → rules_set → prematched → preflight_ok → committed → rolled_back
 * 纪律：
 * - 匹配只调 lib/import-matcher 确定性引擎，零 LLM；
 * - account_day_level 批次绝不进入作品级匹配路径，assign 直接拒绝（红线）；
 * - raw_data 永久保留；提交经 import_batch/import_row 中间层，只写 video_metrics/creator_metric_daily
 *   （复用 analytics-metrics 单一口径），禁止直写 video_analytics；
 * - 提交前服务端重跑 preflight，落 commit_preimage 快照支持整批回滚。
 */
import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "../db";
import {
  IMPORT_ROW_MATCH_STATUSES,
  contents,
  creatorMetricDaily,
  importBatch,
  importRow,
  matchCandidate,
  matchDecision,
  publishRecords,
  videoMetricDaily,
  videoMetrics,
} from "../db/schema";
import {
  type FieldDetectionEntry,
  type ImportDataGranularity,
  type ImportFieldRole,
  detectFieldRoles,
  determineGranularity,
} from "../lib/import-granularity";
import {
  DEFAULT_MATCH_RULES,
  type EngineImportRow,
  type EngineVideo,
  type ImportMatchRules,
  matchImportRows,
  parseTimeToEpoch,
  summarizeEstimate,
} from "../lib/import-matcher";
import {
  type PreflightInput,
  type PreflightReport,
  runPreflightChecks,
} from "../lib/import-preflight";
import {
  mapCreatorDailyRow,
  mapImportRow,
  recomputeDerivedMetrics,
  upsertCreatorDailyRow,
  writeMetricRows,
} from "./analytics-metrics.service";

// ── 角色 → canonical 指标 / 账号日字段（单一口径映射） ──

const ROLE_TO_METRIC: Partial<Record<ImportFieldRole, string>> = {
  views: "play_count",
  likes: "like_count",
  comments: "comment_count",
  shares: "share_count",
  completion_rate: "completion_rate",
  // 合集导出扩展（2026-09-28）；封面点击率无作品级 canonical，不列入→提交时按未映射诚实跳过
  watch_rate_5s: "watch_rate_5s",
  bounce_rate_2s: "bounce_rate_2s",
  avg_watch_time: "avg_watch_time",
  collect_count: "collect_count",
  profile_visit_count: "profile_visit_count",
  fans_increment: "new_fan_count",
};

const ROLE_TO_DAILY: Partial<Record<ImportFieldRole, string>> = {
  views: "playIncrement",
  likes: "likeIncrement",
  comments: "commentIncrement",
  shares: "shareIncrement",
  watch_rate_5s: "watchRate5s",
  bounce_rate_2s: "bounceRate2s",
  avg_watch_time: "avgWatchTime",
  profile_visit_count: "profileUV",
  fans_increment: "newFans",
};

const GRANULARITY_ORDER: Record<ImportDataGranularity, number> = {
  work_level_strong: 0,
  work_level_weak: 1,
  account_day_level: 2,
};

/** 行级标准数据（normalized_data 的形态） */
interface NormalizedRow {
  platformWorkId: string | null;
  workUrl: string | null;
  account: string | null;
  publishTime: string | null;
  date: string | null;
  title: string | null;
  durationSec: number | null;
  platform: string | null;
  /** 指标列的原始表头（值留在 raw_data 里，提交时按 canonical/daily 映射清洗） */
  metricHeaders: string[];
  /** 播放量列的原始表头（列表展示用） */
  viewsHeader: string | null;
}

function makeBatchId(): string {
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  return `imp_${ymd}_${randomBytes(3).toString("hex")}`;
}

/** "00:58" / "1:02:03" / "58" / "58s" → 秒；不中 null（不猜） */
export function parseDurationCell(raw: string): number | null {
  const t = raw.trim().replace(/s$/i, "").replace(/秒$/, "");
  if (t === "") return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const parts = t.split(":").map((p) => Number(p));
  if (parts.some((p) => Number.isNaN(p) || p < 0)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

/** 表头/行 → 每行 { rawData, normalized }（字段识别结果驱动，纯搬运无推断） */
export function normalizeImportRows(
  headers: readonly string[],
  rows: readonly string[][],
  detection: readonly FieldDetectionEntry[],
  batchPlatform: string,
): { rawData: Record<string, string>; normalized: NormalizedRow }[] {
  const roleOf = (role: ImportFieldRole): number =>
    detection.find((d) => d.role === role)?.col ?? -1;
  const cols = {
    platformWorkId: roleOf("platform_work_id"),
    workUrl: roleOf("work_url"),
    account: roleOf("account"),
    publishTime: roleOf("publish_time"),
    date: roleOf("date"),
    title: roleOf("title"),
    duration: roleOf("duration"),
  };
  const metricHeaders = detection
    .filter(
      (d) =>
        d.role !== null &&
        (ROLE_TO_METRIC[d.role as ImportFieldRole] !== undefined ||
          ROLE_TO_DAILY[d.role as ImportFieldRole] !== undefined),
    )
    .map((d) => d.header);
  const viewsHeader = detection.find((d) => d.role === "views")?.header ?? null;
  return rows.map((cells) => {
    const rawData: Record<string, string> = {};
    headers.forEach((h, i) => {
      rawData[h.trim() === "" ? `col_${i}` : h.trim()] = (cells[i] ?? "").trim();
    });
    const pick = (col: number): string | null =>
      col >= 0 ? (cells[col] ?? "").trim() || null : null;
    return {
      rawData,
      normalized: {
        platformWorkId: pick(cols.platformWorkId),
        workUrl: pick(cols.workUrl),
        account: pick(cols.account),
        publishTime: pick(cols.publishTime),
        date: pick(cols.date),
        title: pick(cols.title),
        durationSec:
          pick(cols.duration) !== null ? parseDurationCell(pick(cols.duration) ?? "") : null,
        platform: batchPlatform,
        metricHeaders,
        viewsHeader,
      },
    };
  });
}

// ── 批次创建与查询 ──

export interface CreateBatchInput {
  filename: string;
  fileSize: number;
  fileHash: string;
  platform: string;
  headers: string[];
  rows: string[][];
  /** 用户手改的 列下标→角色（null=不导入）；缺省走自动识别 */
  fieldOverride?: Record<string, ImportFieldRole | null>;
}

export type CreateBatchResult =
  | {
      kind: "created";
      batchId: string;
      granularity: ImportDataGranularity;
      granularityEvidence: ReturnType<typeof determineGranularity>["evidence"];
      fieldDetection: FieldDetectionEntry[];
      summary: {
        rowCount: number;
        accountCount: number;
        dateFrom: string | null;
        dateTo: string | null;
      };
      preview: string[][];
    }
  | { kind: "empty" };

export async function createImportBatch(input: CreateBatchInput): Promise<CreateBatchResult> {
  if (input.rows.length === 0) return { kind: "empty" };
  let detection = detectFieldRoles(input.headers, input.rows[0] ?? []);
  if (input.fieldOverride) {
    detection = detection.map((d) => {
      const override = input.fieldOverride?.[String(d.col)];
      return override === undefined ? d : { ...d, role: override };
    });
  }
  const gran = determineGranularity(detection, input.rows);
  const prepared = normalizeImportRows(input.headers, input.rows, detection, input.platform);
  const batchId = makeBatchId();
  await db.transaction(async (tx) => {
    await tx.insert(importBatch).values({
      id: batchId,
      filename: input.filename,
      fileSize: input.fileSize,
      fileHash: input.fileHash,
      platform: input.platform,
      rowCount: prepared.length,
      dataGranularity: gran.granularity,
      granularityEvidence: gran.evidence,
      headers: input.headers,
      fieldDetection: detection,
      status: "draft",
    });
    for (let i = 0; i < prepared.length; i += 500) {
      const chunk = prepared.slice(i, i + 500);
      await tx.insert(importRow).values(
        chunk.map((p, j) => ({
          batchId,
          rowNumber: i + j + 1,
          rawData: p.rawData,
          normalizedData: p.normalized,
          dataGranularity: gran.granularity,
          // 初始态：粒度即终态（账号日级）或待匹配（unmatched 占位，预匹配后刷新）
          matchStatus:
            gran.granularity === "account_day_level"
              ? ("account_day_level" as const)
              : ("unmatched" as const),
        })),
      );
    }
  });
  const accounts = new Set(
    prepared.map((p) => p.normalized.account).filter((a): a is string => a !== null),
  );
  const dates = prepared
    .map((p) => p.normalized.date ?? p.normalized.publishTime?.slice(0, 10) ?? null)
    .filter((d): d is string => d !== null)
    .sort();
  return {
    kind: "created",
    batchId,
    granularity: gran.granularity,
    granularityEvidence: gran.evidence,
    fieldDetection: detection,
    summary: {
      rowCount: prepared.length,
      accountCount: accounts.size,
      dateFrom: dates[0] ?? null,
      dateTo: dates[dates.length - 1] ?? null,
    },
    preview: input.rows.slice(0, 10),
  };
}

export interface BatchStats {
  uniqueMatch: number;
  conflict: number;
  unmatched: number;
  accountDayLevel: number;
  confirmed: number;
  ignored: number;
}

export interface BatchView {
  id: string;
  filename: string;
  fileSize: number;
  fileHash: string;
  platform: string;
  rowCount: number;
  dataGranularity: ImportDataGranularity;
  granularityEvidence: unknown;
  headers: unknown;
  fieldDetection: unknown;
  matchRules: ImportMatchRules | null;
  status: string;
  stats: BatchStats;
  /** 概要统计（账号数量/日期范围）：刷新后 UI 仍展示 STEP1 要求的全部指标 */
  summary: {
    rowCount: number;
    accountCount: number;
    dateFrom: string | null;
    dateTo: string | null;
  };
  commitSummary: unknown;
  createdAt: string;
  completedAt: string | null;
}

async function loadStats(batchId: string): Promise<BatchStats> {
  const rows = await db
    .select({ s: importRow.matchStatus, n: sql<number>`count(*)` })
    .from(importRow)
    .where(eq(importRow.batchId, batchId))
    .groupBy(importRow.matchStatus);
  const stats: BatchStats = {
    uniqueMatch: 0,
    conflict: 0,
    unmatched: 0,
    accountDayLevel: 0,
    confirmed: 0,
    ignored: 0,
  };
  for (const r of rows) {
    if (r.s === "unique_match") stats.uniqueMatch = Number(r.n);
    else if (r.s === "conflict") stats.conflict = Number(r.n);
    else if (r.s === "unmatched") stats.unmatched = Number(r.n);
    else if (r.s === "account_day_level") stats.accountDayLevel = Number(r.n);
    else if (r.s === "confirmed") stats.confirmed = Number(r.n);
    else stats.ignored = Number(r.n);
  }
  return stats;
}

export async function getBatchView(batchId: string): Promise<BatchView | null> {
  const [b] = await db.select().from(importBatch).where(eq(importBatch.id, batchId)).limit(1);
  if (!b) return null;
  // 概要聚合（JSON 列取账号/日期）：一次 SQL，不拉全行
  // 坑：JSON_UNQUOTE(JSON_EXTRACT(col,'$.x')) 对 JSON null 返回字符串 'null' 而非 SQL NULL，必须 NULLIF 双重归一
  const dateExpr = sql`coalesce(nullif(nullif(json_unquote(json_extract(${importRow.normalizedData}, '$.date')), 'null'), ''), substring(json_unquote(json_extract(${importRow.normalizedData}, '$.publishTime')), 1, 10))`;
  const [agg] = await db
    .select({
      accountCount: sql<number>`count(distinct nullif(nullif(json_unquote(json_extract(${importRow.normalizedData}, '$.account')), 'null'), ''))`,
      dateFrom: sql<string | null>`min(${dateExpr})`,
      dateTo: sql<string | null>`max(${dateExpr})`,
    })
    .from(importRow)
    .where(eq(importRow.batchId, batchId));
  return {
    id: b.id,
    filename: b.filename,
    fileSize: b.fileSize,
    fileHash: b.fileHash,
    platform: b.platform,
    rowCount: b.rowCount,
    dataGranularity: b.dataGranularity,
    granularityEvidence: b.granularityEvidence,
    headers: b.headers,
    fieldDetection: b.fieldDetection,
    matchRules: (b.matchRules as ImportMatchRules | null) ?? null,
    status: b.status,
    stats: await loadStats(batchId),
    summary: {
      rowCount: b.rowCount,
      accountCount: Number(agg?.accountCount ?? 0),
      dateFrom: (agg?.dateFrom as string | null) ?? null,
      dateTo: (agg?.dateTo as string | null) ?? null,
    },
    commitSummary: b.commitSummary,
    createdAt: b.createdAt.toISOString(),
    completedAt: b.completedAt?.toISOString() ?? null,
  };
}

export async function listImportBatches(): Promise<BatchView[]> {
  const rows = await db
    .select({ id: importBatch.id })
    .from(importBatch)
    .orderBy(desc(importBatch.createdAt))
    .limit(50);
  const views: BatchView[] = [];
  for (const r of rows) {
    const v = await getBatchView(r.id);
    if (v) views.push(v);
  }
  return views;
}

export type DeleteBatchResult = { kind: "deleted" } | { kind: "not-found" } | { kind: "committed" };

export async function deleteImportBatch(batchId: string): Promise<DeleteBatchResult> {
  const [b] = await db.select().from(importBatch).where(eq(importBatch.id, batchId)).limit(1);
  if (!b) return { kind: "not-found" };
  if (b.status === "committed") return { kind: "committed" }; // 已提交批次只能回滚，不许抹掉审计
  await db.delete(importBatch).where(eq(importBatch.id, batchId)); // 行/候选/裁决级联删除
  return { kind: "deleted" };
}

// ── STEP 1 → 2：粒度确认（只允许降级，禁止把账号日级升格为作品级） ──

export type ConfirmGranularityResult =
  | { kind: "ok"; granularity: ImportDataGranularity }
  | { kind: "not-found" }
  | { kind: "upgrade-denied"; current: ImportDataGranularity; requested: ImportDataGranularity }
  | { kind: "invalid-state"; status: string };

export async function confirmGranularity(
  batchId: string,
  requested: ImportDataGranularity,
): Promise<ConfirmGranularityResult> {
  const [b] = await db.select().from(importBatch).where(eq(importBatch.id, batchId)).limit(1);
  if (!b) return { kind: "not-found" };
  if (b.status !== "draft" && b.status !== "granularity_confirmed") {
    return { kind: "invalid-state", status: b.status };
  }
  if (GRANULARITY_ORDER[requested] < GRANULARITY_ORDER[b.dataGranularity]) {
    return { kind: "upgrade-denied", current: b.dataGranularity, requested };
  }
  await db
    .update(importBatch)
    .set({ dataGranularity: requested, status: "granularity_confirmed" })
    .where(eq(importBatch.id, batchId));
  await db
    .update(importRow)
    .set({ dataGranularity: requested })
    .where(eq(importRow.batchId, batchId));
  if (requested === "account_day_level") {
    // 降级到账号日级：已产生的系统态全部重置为该终态（人工裁决由 rematch 门控把关）
    await db
      .update(importRow)
      .set({ matchStatus: "account_day_level" })
      .where(eq(importRow.batchId, batchId));
  }
  return { kind: "ok", granularity: requested };
}

// ── STEP 2：规则保存 + dry-run 预估 ──

export type SaveRulesResult =
  | {
      kind: "ok";
      estimate: ReturnType<typeof summarizeEstimate>;
      granularity: ImportDataGranularity;
    }
  | { kind: "not-found" }
  | { kind: "invalid-state"; status: string };

export async function saveRules(
  batchId: string,
  rules: ImportMatchRules,
): Promise<SaveRulesResult> {
  const [b] = await db.select().from(importBatch).where(eq(importBatch.id, batchId)).limit(1);
  if (!b) return { kind: "not-found" };
  if (!["granularity_confirmed", "rules_set", "prematched", "preflight_ok"].includes(b.status)) {
    return { kind: "invalid-state", status: b.status };
  }
  await db
    .update(importBatch)
    .set({ matchRules: rules, status: "rules_set" })
    .where(eq(importBatch.id, batchId));
  const estimate = await estimateBatch(batchId, rules);
  return { kind: "ok", estimate, granularity: b.dataGranularity };
}

/** dry-run：只算不写（保存规则时的预估统计） */
async function estimateBatch(batchId: string, rules: ImportMatchRules) {
  const rows = await loadRowsInternal(batchId);
  const zero = {
    total: rows.length,
    expectStrongMatch: 0,
    expectManualConfirm: 0,
    expectUnmatched: 0,
  };
  if (rows.length === 0 || rows[0].dataGranularity === "account_day_level") return zero;
  const videos = await loadEngineVideos();
  const output = matchImportRows(rows.map(toEngineRow), videos, rules, rows[0].dataGranularity);
  return summarizeEstimate(output);
}

// ── STEP 3：预匹配 / 重新匹配 ──

export type PrematchResult =
  | { kind: "ok"; stats: BatchStats }
  | { kind: "not-found" }
  | { kind: "needs-confirmation"; operatorDecisions: number }
  | { kind: "invalid-state"; status: string };

type RowMatchStatus = (typeof IMPORT_ROW_MATCH_STATUSES)[number];

interface LoadedRow {
  id: number;
  rowNumber: number;
  matchStatus: RowMatchStatus;
  dataGranularity: ImportDataGranularity;
  rawData: Record<string, string>;
  normalized: NormalizedRow;
}

async function loadRowsInternal(batchId: string): Promise<LoadedRow[]> {
  const rows = await db
    .select()
    .from(importRow)
    .where(eq(importRow.batchId, batchId))
    .orderBy(importRow.rowNumber);
  return rows.map((r) => ({
    id: r.id,
    rowNumber: r.rowNumber,
    matchStatus: r.matchStatus,
    dataGranularity: r.dataGranularity,
    rawData: r.rawData as Record<string, string>,
    normalized: r.normalizedData as NormalizedRow,
  }));
}

function toEngineRow(r: LoadedRow): EngineImportRow {
  return {
    rowNumber: r.rowNumber,
    platformWorkId: r.normalized.platformWorkId,
    workUrl: r.normalized.workUrl,
    account: r.normalized.account,
    publishTime: r.normalized.publishTime,
    date: r.normalized.date,
    title: r.normalized.title,
    durationSec: r.normalized.durationSec,
    platform: r.normalized.platform,
  };
}

/** 引擎候选视频 = 未删除且已绑定平台作品 ID 的发布记录（未绑定记录不参与自动匹配，仅可人工搜索绑定） */
async function loadEngineVideos(): Promise<EngineVideo[]> {
  const rows = await db
    .select({
      id: publishRecords.id,
      platform: publishRecords.platform,
      platformVideoId: publishRecords.platformVideoId,
      publishTime: publishRecords.publishTime,
      publishTitle: publishRecords.publishTitle,
      contentTitle: contents.title,
      video: contents.video,
      audio: contents.audio,
    })
    .from(publishRecords)
    .innerJoin(contents, eq(publishRecords.contentId, contents.id))
    .where(
      and(
        ne(publishRecords.publishStatus, "deleted"),
        // 空串也视为未绑定（MySQL IS NOT NULL 不排空串）：未绑定作品 ID 的记录不参与自动匹配
        sql`${publishRecords.platformVideoId} IS NOT NULL AND ${publishRecords.platformVideoId} <> ''`,
      ),
    );
  return rows.map((r) => ({
    videoId: r.id,
    platform: r.platform,
    platformVideoId: r.platformVideoId,
    publishTime: r.publishTime,
    title: r.publishTitle ?? r.contentTitle,
    durationSec: durationOf(r.video, r.audio),
  }));
}

function durationOf(video: unknown, audio: unknown): number | null {
  for (const meta of [video, audio]) {
    if (meta && typeof meta === "object" && "duration" in meta) {
      const d = Number((meta as { duration?: unknown }).duration);
      if (Number.isFinite(d) && d > 0) return d;
    }
  }
  return null;
}

export async function prematchBatch(batchId: string, force = false): Promise<PrematchResult> {
  const [b] = await db.select().from(importBatch).where(eq(importBatch.id, batchId)).limit(1);
  if (!b) return { kind: "not-found" };
  if (!["rules_set", "prematched", "preflight_ok"].includes(b.status)) {
    return { kind: "invalid-state", status: b.status };
  }
  if (!force) {
    const [op] = await db
      .select({ n: sql<number>`count(*)` })
      .from(matchDecision)
      .where(
        and(eq(matchDecision.batchId, batchId), ne(matchDecision.decisionType, "system_auto")),
      );
    if (Number(op?.n ?? 0) > 0) {
      return { kind: "needs-confirmation", operatorDecisions: Number(op?.n ?? 0) };
    }
  }
  const rules = (b.matchRules as ImportMatchRules | null) ?? DEFAULT_MATCH_RULES;
  const rows = await loadRowsInternal(batchId);
  await db.transaction(async (tx) => {
    const rowIds = rows.map((r) => r.id);
    if (rowIds.length > 0) {
      await tx.delete(matchCandidate).where(inArray(matchCandidate.importRowId, rowIds));
      await tx.delete(matchDecision).where(inArray(matchDecision.importRowId, rowIds));
    }
    if (b.dataGranularity === "account_day_level") {
      // 账号日批次：不产候选，全部行直接终态（只能"保存为账号日级/忽略"，UI 无归属按钮）
      await tx
        .update(importRow)
        .set({ matchStatus: "account_day_level" })
        .where(eq(importRow.batchId, batchId));
    } else {
      const videos = await loadEngineVideos();
      const output = matchImportRows(rows.map(toEngineRow), videos, rules, b.dataGranularity);
      const statusByNumber = new Map(output.results.map((r) => [r.rowNumber, r]));
      for (const row of rows) {
        const result = statusByNumber.get(row.rowNumber);
        const status = result?.status ?? "unmatched";
        await tx.update(importRow).set({ matchStatus: status }).where(eq(importRow.id, row.id));
        for (const c of result?.candidates ?? []) {
          await tx.insert(matchCandidate).values({
            importRowId: row.id,
            videoId: c.videoId,
            matchMethod: c.matchMethod,
            matchScore: c.matchScore,
            evidence: c.evidence,
            rank: c.rank,
          });
        }
      }
    }
    await tx.update(importBatch).set({ status: "prematched" }).where(eq(importBatch.id, batchId));
  });
  return { kind: "ok", stats: await loadStats(batchId) };
}

// ── STEP 3：列表与详情 ──

export interface RowListItem {
  rowId: number;
  rowNumber: number;
  imported: {
    date: string | null;
    platform: string | null;
    account: string | null;
    title: string | null;
    platformWorkId: string | null;
    views: string | null;
  };
  matched: {
    videoId: string;
    videoTitle: string;
    coverUrl: string | null;
    publishTime: string | null;
    durationSec: number | null;
  } | null;
  matchStatus: string;
  decisionType: string | null;
  matchMethod: string | null;
  candidateCount: number;
  evidenceSummary: string[];
}

/** evidence → 人话摘要（列表行用；详情面板由前端按结构化字段逐条渲染） */
export function evidenceSummaryOf(e: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (e.platformWorkIdExact === true) out.push("作品 ID 一致");
  if (e.workUrlIdExact === true) out.push("URL 解析 ID 一致");
  if (e.accountMapped === true && typeof e.mappedAccount === "string")
    out.push(`账号已映射（${e.mappedAccount}）`);
  if (typeof e.publishTimeDiffSeconds === "number")
    out.push(`发布时间相差 ${e.publishTimeDiffSeconds} 秒`);
  if (e.dateMatched === true) out.push("发布日期一致");
  if (typeof e.titleSimilarity === "number")
    out.push(`标题相似度 ${(e.titleSimilarity * 100).toFixed(1)}%`);
  if (typeof e.durationDiffSeconds === "number") out.push(`时长相差 ${e.durationDiffSeconds} 秒`);
  if (e.workIdMissing === true) out.push("作品 ID 缺失");
  return out;
}

export async function listBatchRows(
  batchId: string,
  query: { status?: string; keyword?: string; page: number; pageSize: number },
): Promise<{ items: RowListItem[]; total: number }> {
  const conditions = [eq(importRow.batchId, batchId)];
  if (query.status && query.status !== "all") {
    // 外部输入收窄到枚举内再比较（非法值直接当未筛选，不报错不崩列表）
    if ((IMPORT_ROW_MATCH_STATUSES as readonly string[]).includes(query.status)) {
      conditions.push(eq(importRow.matchStatus, query.status as RowMatchStatus));
    }
  }
  if (query.keyword) {
    conditions.push(sql`CAST(${importRow.rawData} AS CHAR) LIKE ${`%${query.keyword}%`}`);
  }
  const where = and(...conditions);
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(importRow).where(where);
  const rows = await db
    .select()
    .from(importRow)
    .where(where)
    .orderBy(importRow.rowNumber)
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  const items: RowListItem[] = [];
  for (const r of rows) {
    const rawData = r.rawData as Record<string, string>;
    const [decision] = await db
      .select()
      .from(matchDecision)
      .where(eq(matchDecision.importRowId, r.id))
      .limit(1);
    const [candidate] = await db
      .select()
      .from(matchCandidate)
      .where(eq(matchCandidate.importRowId, r.id))
      .orderBy(matchCandidate.rank)
      .limit(1);
    const [{ n: candCount }] = await db
      .select({ n: sql<number>`count(*)` })
      .from(matchCandidate)
      .where(eq(matchCandidate.importRowId, r.id));
    const targetVideoId = decision?.matchedVideoId ?? candidate?.videoId ?? null;
    let matched: RowListItem["matched"] = null;
    if (targetVideoId !== null) matched = await loadVideoBrief(targetVideoId);
    const normalized = r.normalizedData as NormalizedRow;
    items.push({
      rowId: r.id,
      rowNumber: r.rowNumber,
      imported: {
        date: normalized.date ?? normalized.publishTime?.slice(0, 10) ?? null,
        platform: normalized.platform,
        account: normalized.account,
        title: normalized.title,
        platformWorkId: normalized.platformWorkId,
        views: normalized.viewsHeader !== null ? (rawData[normalized.viewsHeader] ?? null) : null,
      },
      matched,
      matchStatus: r.matchStatus,
      decisionType: decision?.decisionType ?? null,
      matchMethod: candidate?.matchMethod ?? decision?.matchMethod ?? null,
      candidateCount: Number(candCount),
      evidenceSummary: candidate
        ? evidenceSummaryOf(candidate.evidence as Record<string, unknown>)
        : [],
    });
  }
  return { items, total: Number(n) };
}

async function loadVideoBrief(videoId: string): Promise<RowListItem["matched"]> {
  const [row] = await db
    .select({
      id: publishRecords.id,
      title: publishRecords.publishTitle,
      contentTitle: contents.title,
      coverUrl: publishRecords.coverUrl,
      publishTime: publishRecords.publishTime,
      video: contents.video,
      audio: contents.audio,
    })
    .from(publishRecords)
    .innerJoin(contents, eq(publishRecords.contentId, contents.id))
    .where(eq(publishRecords.id, videoId))
    .limit(1);
  if (!row) return null;
  return {
    videoId: row.id,
    videoTitle: row.title ?? row.contentTitle,
    coverUrl: row.coverUrl,
    publishTime: row.publishTime?.toISOString() ?? null,
    durationSec: durationOf(row.video, row.audio),
  };
}

export interface RowDetail {
  row: {
    id: number;
    rowNumber: number;
    matchStatus: string;
    dataGranularity: ImportDataGranularity;
    rawData: Record<string, string>;
    normalized: NormalizedRow;
  };
  decision: {
    matchStatus: string;
    matchedVideoId: string | null;
    decisionType: string;
    operator: string;
    confirmedAt: string | null;
    metadata: unknown;
  } | null;
  candidates: Array<{
    videoId: string;
    matchMethod: string;
    matchScore: number;
    rank: number;
    evidence: unknown;
    video: Awaited<ReturnType<typeof loadVideoBrief>>;
  }>;
}

export async function getRowDetail(batchId: string, rowId: number): Promise<RowDetail | null> {
  const [r] = await db
    .select()
    .from(importRow)
    .where(and(eq(importRow.id, rowId), eq(importRow.batchId, batchId)))
    .limit(1);
  if (!r) return null;
  const [decision] = await db
    .select()
    .from(matchDecision)
    .where(eq(matchDecision.importRowId, rowId))
    .limit(1);
  const candidates = await db
    .select()
    .from(matchCandidate)
    .where(eq(matchCandidate.importRowId, rowId))
    .orderBy(matchCandidate.rank);
  const detailed: RowDetail["candidates"] = [];
  for (const c of candidates) {
    detailed.push({
      videoId: c.videoId,
      matchMethod: c.matchMethod,
      matchScore: c.matchScore,
      rank: c.rank,
      evidence: c.evidence,
      video: await loadVideoBrief(c.videoId),
    });
  }
  return {
    row: {
      id: r.id,
      rowNumber: r.rowNumber,
      matchStatus: r.matchStatus,
      dataGranularity: r.dataGranularity,
      rawData: r.rawData as Record<string, string>,
      normalized: r.normalizedData as NormalizedRow,
    },
    decision: decision
      ? {
          matchStatus: decision.matchStatus,
          matchedVideoId: decision.matchedVideoId,
          decisionType: decision.decisionType,
          operator: decision.operator,
          confirmedAt: decision.confirmedAt?.toISOString() ?? null,
          metadata: decision.metadata,
        }
      : null,
    candidates: detailed,
  };
}

// ── STEP 3：裁决（批量操作真实落库） ──

export type DecisionAction =
  | { action: "confirm"; rowIds?: number[]; allUnique?: boolean }
  | { action: "assign"; rowId: number; videoId: string }
  | { action: "ignore"; rowIds: number[] }
  | { action: "external"; rowIds: number[] }
  | { action: "account_day"; rowIds: number[] }
  | { action: "reset"; rowIds: number[] };

export type ApplyDecisionsResult =
  | { kind: "ok"; affected: number; stats: BatchStats }
  | { kind: "not-found" }
  | { kind: "invalid-state"; status: string }
  | { kind: "account-day-denied" } // 红线：账号日级行不允许归属作品
  | { kind: "video-not-found"; videoId: string }
  | { kind: "not-confirmable"; rowIds: number[] }; // confirm 只接受 unique_match 行

async function upsertDecision(
  batchId: string,
  rowId: number,
  patch: {
    matchStatus: "confirmed" | "ignored";
    matchedVideoId: string | null;
    decisionType:
      | "operator_confirm"
      | "operator_assign"
      | "operator_external"
      | "operator_account_day"
      | "operator_ignore";
    metadata?: Record<string, unknown> | null;
  },
): Promise<void> {
  const values = {
    importRowId: rowId,
    batchId,
    matchStatus: patch.matchStatus,
    matchedVideoId: patch.matchedVideoId,
    matchMethod: null as null,
    confidence: null as null,
    decisionType: patch.decisionType,
    operator: "local",
    confirmedAt: new Date(),
    metadata: patch.metadata ?? null,
  };
  await db.insert(matchDecision).values(values).onDuplicateKeyUpdate({ set: values });
}

export async function applyDecisions(
  batchId: string,
  action: DecisionAction,
): Promise<ApplyDecisionsResult> {
  const [b] = await db.select().from(importBatch).where(eq(importBatch.id, batchId)).limit(1);
  if (!b) return { kind: "not-found" };
  if (b.status !== "prematched" && b.status !== "preflight_ok") {
    return { kind: "invalid-state", status: b.status };
  }
  if (action.action === "confirm") {
    return confirmRows(batchId, action);
  }
  if (action.action === "assign") {
    return assignRow(batchId, action.rowId, action.videoId);
  }
  if (action.action === "reset") {
    return resetRows(batchId, action.rowIds);
  }
  const statusMap = { ignore: "ignored", external: "ignored", account_day: "confirmed" } as const;
  const typeMap = {
    ignore: "operator_ignore",
    external: "operator_external",
    account_day: "operator_account_day",
  } as const;
  let affected = 0;
  for (const rowId of action.rowIds) {
    const [row] = await db.select().from(importRow).where(eq(importRow.id, rowId)).limit(1);
    if (!row || row.batchId !== batchId) continue;
    const meta =
      action.action === "external"
        ? {
            externalVideo: true,
            importTitle:
              row.normalizedData === null ? null : (row.normalizedData as NormalizedRow).title,
            importAccount: (row.normalizedData as NormalizedRow).account,
          }
        : null;
    await upsertDecision(batchId, rowId, {
      matchStatus: statusMap[action.action],
      matchedVideoId: null,
      decisionType: typeMap[action.action],
      metadata: meta,
    });
    await db
      .update(importRow)
      .set({ matchStatus: statusMap[action.action] })
      .where(eq(importRow.id, rowId));
    affected += 1;
  }
  return { kind: "ok", affected, stats: await loadStats(batchId) };
}

async function confirmRows(
  batchId: string,
  action: Extract<DecisionAction, { action: "confirm" }>,
): Promise<ApplyDecisionsResult> {
  const base = [eq(importRow.batchId, batchId)];
  if (action.allUnique) base.push(eq(importRow.matchStatus, "unique_match"));
  const rows = action.allUnique
    ? await db
        .select()
        .from(importRow)
        .where(and(...base))
    : await db
        .select()
        .from(importRow)
        .where(and(eq(importRow.batchId, batchId), inArray(importRow.id, action.rowIds ?? [])));
  const notConfirmable = rows.filter((r) => r.matchStatus !== "unique_match").map((r) => r.id);
  if (notConfirmable.length > 0) return { kind: "not-confirmable", rowIds: notConfirmable };
  let affected = 0;
  for (const row of rows) {
    const [top] = await db
      .select()
      .from(matchCandidate)
      .where(eq(matchCandidate.importRowId, row.id))
      .orderBy(matchCandidate.rank)
      .limit(1);
    if (!top) continue;
    await upsertDecision(batchId, row.id, {
      matchStatus: "confirmed",
      matchedVideoId: top.videoId,
      decisionType: "operator_confirm",
      metadata: {
        systemMatchStatus: "unique_match",
        matchMethod: top.matchMethod,
        matchScore: top.matchScore,
      },
    });
    await db.update(importRow).set({ matchStatus: "confirmed" }).where(eq(importRow.id, row.id));
    affected += 1;
  }
  return { kind: "ok", affected, stats: await loadStats(batchId) };
}

async function assignRow(
  batchId: string,
  rowId: number,
  videoId: string,
): Promise<ApplyDecisionsResult> {
  const [row] = await db.select().from(importRow).where(eq(importRow.id, rowId)).limit(1);
  if (!row || row.batchId !== batchId) return { kind: "not-found" };
  // 红线：账号日级数据不允许归属到单个视频（UI 不提供该按钮，这里是服务端第二道闸）
  if (row.dataGranularity === "account_day_level" || row.matchStatus === "account_day_level") {
    return { kind: "account-day-denied" };
  }
  const [video] = await db
    .select({ id: publishRecords.id })
    .from(publishRecords)
    .where(and(eq(publishRecords.id, videoId), ne(publishRecords.publishStatus, "deleted")))
    .limit(1);
  if (!video) return { kind: "video-not-found", videoId };
  const [candidate] = await db
    .select()
    .from(matchCandidate)
    .where(and(eq(matchCandidate.importRowId, rowId), eq(matchCandidate.videoId, videoId)))
    .limit(1);
  await upsertDecision(batchId, rowId, {
    matchStatus: "confirmed",
    matchedVideoId: videoId,
    decisionType: "operator_assign",
    metadata: {
      systemMatchStatus: row.matchStatus,
      viaCandidate: candidate !== undefined,
      ...(candidate
        ? { matchMethod: candidate.matchMethod, matchScore: candidate.matchScore }
        : {}),
    },
  });
  await db.update(importRow).set({ matchStatus: "confirmed" }).where(eq(importRow.id, rowId));
  return { kind: "ok", affected: 1, stats: await loadStats(batchId) };
}

async function resetRows(batchId: string, rowIds: number[]): Promise<ApplyDecisionsResult> {
  let affected = 0;
  for (const rowId of rowIds) {
    const [decision] = await db
      .select()
      .from(matchDecision)
      .where(eq(matchDecision.importRowId, rowId))
      .limit(1);
    if (!decision || decision.batchId !== batchId) continue;
    const systemStatus = (decision.metadata as { systemMatchStatus?: string } | null)
      ?.systemMatchStatus;
    const restore =
      systemStatus === "unique_match" || systemStatus === "conflict" || systemStatus === "unmatched"
        ? systemStatus
        : "unmatched";
    await db.delete(matchDecision).where(eq(matchDecision.importRowId, rowId));
    await db.update(importRow).set({ matchStatus: restore }).where(eq(importRow.id, rowId));
    affected += 1;
  }
  return { kind: "ok", affected, stats: await loadStats(batchId) };
}

// ── STEP 4：Preflight（服务端组装快照 → 纯函数检查 → 行级 validation_status 落库） ──

async function buildPreflightInput(batchId: string): Promise<PreflightInput | null> {
  const [b] = await db.select().from(importBatch).where(eq(importBatch.id, batchId)).limit(1);
  if (!b) return null;
  const rules = (b.matchRules as ImportMatchRules | null) ?? DEFAULT_MATCH_RULES;
  const rows = await loadRowsInternal(batchId);
  const decisions = await db.select().from(matchDecision).where(eq(matchDecision.batchId, batchId));
  const decisionByRow = new Map(decisions.map((d) => [d.importRowId, d]));
  const videoIds = [
    ...new Set(decisions.map((d) => d.matchedVideoId).filter((v): v is string => v !== null)),
  ];
  const videoInfo = new Map<string, { platform: string; publishEpoch: number | null }>();
  if (videoIds.length > 0) {
    const vids = await db
      .select({
        id: publishRecords.id,
        platform: publishRecords.platform,
        publishTime: publishRecords.publishTime,
      })
      .from(publishRecords)
      .where(inArray(publishRecords.id, videoIds));
    for (const v of vids) {
      videoInfo.set(v.id, { platform: v.platform, publishEpoch: v.publishTime?.getTime() ?? null });
    }
  }
  const [dup] = await db
    .select({ id: importBatch.id })
    .from(importBatch)
    .where(
      and(
        eq(importBatch.fileHash, b.fileHash),
        eq(importBatch.status, "committed"),
        ne(importBatch.id, batchId),
      ),
    )
    .limit(1);
  return {
    batchId,
    fileHash: b.fileHash,
    committedSameHash: dup !== undefined,
    alreadyCommitted: b.status === "committed",
    accountMapping: rules.accountMapping,
    nowEpoch: Date.now(),
    rows: rows.map((r) => {
      const decision = decisionByRow.get(r.id);
      const info = decision?.matchedVideoId ? videoInfo.get(decision.matchedVideoId) : undefined;
      const timeRaw = r.normalized.publishTime ?? r.normalized.date;
      const metricRaws: Record<string, unknown> = {};
      for (const h of r.normalized.metricHeaders) {
        if (r.rawData[h] !== undefined) metricRaws[h] = r.rawData[h];
      }
      return {
        rowId: r.id,
        rowNumber: r.rowNumber,
        matchStatus: r.matchStatus,
        granularity: r.dataGranularity,
        account: r.normalized.account,
        platform: r.normalized.platform,
        metricRaws,
        importTimeEpoch:
          timeRaw !== null ? parseTimeToEpoch(timeRaw, rules.timezoneOffsetMinutes) : null,
        ...(decision
          ? {
              attributionKind: decision.matchedVideoId
                ? ("video" as const)
                : ("account_day" as const),
            }
          : {}),
        ...(decision?.matchedVideoId && info
          ? {
              confirmed: {
                videoId: decision.matchedVideoId,
                videoPlatform: info.platform,
                videoPublishEpoch: info.publishEpoch,
              },
            }
          : {}),
      };
    }),
  };
}

function validationLevel(report: PreflightReport, rowId: number): "ok" | "warning" | "error" {
  if (report.checks.some((c) => c.level === "blocking" && c.rowIds.includes(rowId))) return "error";
  if (report.checks.some((c) => c.level === "warning" && c.rowIds.includes(rowId)))
    return "warning";
  return "ok";
}

export type PreflightOutcome = { kind: "report"; report: PreflightReport } | { kind: "not-found" };

export async function preflightBatch(batchId: string): Promise<PreflightOutcome> {
  const input = await buildPreflightInput(batchId);
  if (!input) return { kind: "not-found" };
  const report = runPreflightChecks(input);
  for (const row of input.rows) {
    await db
      .update(importRow)
      .set({ validationStatus: validationLevel(report, row.rowId) })
      .where(eq(importRow.id, row.rowId));
  }
  if (report.pass) {
    await db.update(importBatch).set({ status: "preflight_ok" }).where(eq(importBatch.id, batchId));
  }
  return { kind: "report", report };
}

// ── STEP 4：提交落库（重验 preflight → preimage 快照 → 单事务写入） ──

interface VideoSnapshot {
  recordId: string;
  metrics: MetricSnapshotRow[];
  daily: DailySnapshotRow[];
}

/** 快照只存语义列（自增 id/时间戳回灌时由 DB 重建），直接复用 drizzle 插入类型 */
type MetricSnapshotRow = typeof videoMetrics.$inferInsert;
type DailySnapshotRow = typeof videoMetricDaily.$inferInsert;
type CreatorDailySnapshotRow = typeof creatorMetricDaily.$inferInsert;

interface CommitPreimage {
  video: VideoSnapshot[];
  creatorDaily: Array<{ platform: string; statDate: string; old: CreatorDailySnapshotRow | null }>;
}

export interface CommitSummary {
  workLevel: number;
  accountDayLevel: number;
  ignored: number;
  external: number;
  skippedRows: Array<{ rowNumber: number; reason: string }>;
}

export type CommitResult =
  | { kind: "committed"; summary: CommitSummary }
  | { kind: "not-found" }
  | { kind: "preflight_failed"; report: PreflightReport };

/** 角色映射：批次 fieldDetection → { 原始表头: canonical指标 } */
function buildHeaderMappings(
  fieldDetection: FieldDetectionEntry[],
  table: Partial<Record<ImportFieldRole, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of fieldDetection) {
    if (d.role === null) continue;
    const target = table[d.role as ImportFieldRole];
    if (target) out[d.header] = target;
  }
  return out;
}

export async function commitBatch(batchId: string): Promise<CommitResult> {
  const [b] = await db.select().from(importBatch).where(eq(importBatch.id, batchId)).limit(1);
  if (!b) return { kind: "not-found" };
  if (b.status !== "prematched" && b.status !== "preflight_ok") {
    const input = await buildPreflightInput(batchId);
    if (input) return { kind: "preflight_failed", report: runPreflightChecks(input) };
    return { kind: "not-found" };
  }
  // 服务端不信任前端态：提交前重跑十项检查
  const outcome = await preflightBatch(batchId);
  if (outcome.kind === "not-found") return { kind: "not-found" };
  if (!outcome.report.pass) return { kind: "preflight_failed", report: outcome.report };
  const fieldDetection = b.fieldDetection as FieldDetectionEntry[];
  const metricMapping = buildHeaderMappings(fieldDetection, ROLE_TO_METRIC);
  const dailyMapping = buildHeaderMappings(fieldDetection, ROLE_TO_DAILY);
  const rows = await loadRowsInternal(batchId);
  const decisions = await db.select().from(matchDecision).where(eq(matchDecision.batchId, batchId));
  const decisionByRow = new Map(decisions.map((d) => [d.importRowId, d]));
  const workRows = rows.filter((r) => decisionByRow.get(r.id)?.matchedVideoId);
  const dayRows = rows.filter((r) => {
    const d = decisionByRow.get(r.id);
    return (
      d !== undefined && d.matchedVideoId === null && d.decisionType === "operator_account_day"
    );
  });
  const skipped: CommitSummary["skippedRows"] = [];
  const recordIds = [
    ...new Set(workRows.map((r) => decisionByRow.get(r.id)?.matchedVideoId as string)),
  ];
  const dailyKeys = [
    ...new Set(
      dayRows.map((r) => ({
        platform: b.platform,
        statDate: r.normalized.date ?? r.normalized.publishTime?.slice(0, 10) ?? null,
      })),
    ),
  ].filter((k) => k.statDate !== null);
  const preimage = await capturePreimage(
    recordIds,
    dailyKeys as Array<{ platform: string; statDate: string }>,
  );
  const summary: CommitSummary = {
    workLevel: 0,
    accountDayLevel: 0,
    ignored: rows.filter((r) => r.matchStatus === "ignored").length,
    external: decisions.filter((d) => d.decisionType === "operator_external").length,
    skippedRows: skipped,
  };
  await db.transaction(async (tx) => {
    for (const row of workRows) {
      const recordId = decisionByRow.get(row.id)?.matchedVideoId as string;
      const { drafts, skipped: fields } = mapImportRow(row.rawData, metricMapping);
      if (drafts.length === 0) {
        skipped.push({ rowNumber: row.rowNumber, reason: fields[0]?.reason ?? "无合法指标值" });
        continue;
      }
      const dataDate = row.normalized.date ?? row.normalized.publishTime?.slice(0, 10) ?? null;
      await writeMetricRows(
        tx,
        recordId,
        drafts.map((d) => ({
          metricName: d.metricName,
          metricValue: d.metricValue,
          sourceType: "CREATOR_IMPORT" as const,
          sourceField: d.sourceField,
          dataDate,
          // 粉丝增量属时间窗口归因：不得伪装精确归因，统一标记估算（与 importMetrics 同一既有纪律）
          isEstimated: d.metricName === "new_fan_count" || undefined,
          metadata: {
            batch_id: batchId,
            import_row: row.rowNumber,
            matched_by: decisionByRow.get(row.id)?.decisionType ?? "operator_confirm",
          },
        })),
      );
      await recomputeDerivedMetrics(recordId, tx);
      summary.workLevel += 1;
    }
    for (const row of dayRows) {
      const statDate = row.normalized.date ?? row.normalized.publishTime?.slice(0, 10) ?? null;
      if (statDate === null) {
        skipped.push({ rowNumber: row.rowNumber, reason: "缺少日期，无法落账号日级" });
        continue;
      }
      const { fields, skipped: sf } = mapCreatorDailyRow(row.rawData, dailyMapping);
      if (Object.keys(fields).length === 0) {
        skipped.push({ rowNumber: row.rowNumber, reason: sf[0]?.reason ?? "无合法账号日字段" });
        continue;
      }
      await upsertCreatorDailyRow(tx, {
        platform: b.platform,
        statDate,
        sourceType: "CREATOR_IMPORT",
        fields,
        metadata: { batch_id: batchId, import_row: row.rowNumber },
      });
      summary.accountDayLevel += 1;
    }
    await tx
      .update(importBatch)
      .set({
        status: "committed",
        commitSummary: summary,
        commitPreimage: preimage,
        completedAt: new Date(),
      })
      .where(eq(importBatch.id, batchId));
  });
  return { kind: "committed", summary };
}

/** 回滚依据：受影响发布记录的全部最新值行 + 快照行 + 账号日旧行 */
async function capturePreimage(
  recordIds: string[],
  dailyKeys: Array<{ platform: string; statDate: string }>,
): Promise<CommitPreimage> {
  const video: VideoSnapshot[] = [];
  for (const recordId of recordIds) {
    const metrics = await db
      .select({
        publishRecordId: videoMetrics.publishRecordId,
        metricName: videoMetrics.metricName,
        metricValue: videoMetrics.metricValue,
        sourceType: videoMetrics.sourceType,
        sourceField: videoMetrics.sourceField,
        dataDate: videoMetrics.dataDate,
        isEstimated: videoMetrics.isEstimated,
        confidence: videoMetrics.confidence,
        metadata: videoMetrics.metadata,
      })
      .from(videoMetrics)
      .where(eq(videoMetrics.publishRecordId, recordId));
    const daily = await db
      .select({
        publishRecordId: videoMetricDaily.publishRecordId,
        metricName: videoMetricDaily.metricName,
        metricValue: videoMetricDaily.metricValue,
        sourceType: videoMetricDaily.sourceType,
        sourceField: videoMetricDaily.sourceField,
        dataDate: videoMetricDaily.dataDate,
        isEstimated: videoMetricDaily.isEstimated,
        confidence: videoMetricDaily.confidence,
        metadata: videoMetricDaily.metadata,
      })
      .from(videoMetricDaily)
      .where(eq(videoMetricDaily.publishRecordId, recordId));
    video.push({ recordId, metrics, daily });
  }
  const creatorDaily: CommitPreimage["creatorDaily"] = [];
  for (const key of dailyKeys) {
    const [old] = await db
      .select({
        platform: creatorMetricDaily.platform,
        statDate: creatorMetricDaily.statDate,
        playIncrement: creatorMetricDaily.playIncrement,
        likeIncrement: creatorMetricDaily.likeIncrement,
        commentIncrement: creatorMetricDaily.commentIncrement,
        shareIncrement: creatorMetricDaily.shareIncrement,
        profileUV: creatorMetricDaily.profileUV,
        newFans: creatorMetricDaily.newFans,
        totalFans: creatorMetricDaily.totalFans,
        bounceRate2s: creatorMetricDaily.bounceRate2s,
        watchRate5s: creatorMetricDaily.watchRate5s,
        avgWatchTime: creatorMetricDaily.avgWatchTime,
        postCount: creatorMetricDaily.postCount,
        coverClickRate: creatorMetricDaily.coverClickRate,
        sourceType: creatorMetricDaily.sourceType,
        metadata: creatorMetricDaily.metadata,
      })
      .from(creatorMetricDaily)
      .where(
        and(
          eq(creatorMetricDaily.platform, key.platform),
          eq(creatorMetricDaily.statDate, key.statDate),
        ),
      )
      .limit(1);
    creatorDaily.push({
      platform: key.platform,
      statDate: key.statDate,
      old: old ?? null,
    });
  }
  return { video, creatorDaily };
}

export type RollbackResult =
  | { kind: "rolled_back"; records: number; creatorDailyKeys: number }
  | { kind: "not-found" }
  | { kind: "not-committed" }
  | { kind: "no-preimage" };

export async function rollbackBatch(batchId: string): Promise<RollbackResult> {
  const [b] = await db.select().from(importBatch).where(eq(importBatch.id, batchId)).limit(1);
  if (!b) return { kind: "not-found" };
  if (b.status !== "committed") return { kind: "not-committed" };
  const preimage = b.commitPreimage as CommitPreimage | null;
  if (!preimage) return { kind: "no-preimage" };
  await db.transaction(async (tx) => {
    for (const snap of preimage.video) {
      await tx.delete(videoMetrics).where(eq(videoMetrics.publishRecordId, snap.recordId));
      await tx.delete(videoMetricDaily).where(eq(videoMetricDaily.publishRecordId, snap.recordId));
      if (snap.metrics.length > 0) {
        await tx.insert(videoMetrics).values(snap.metrics);
      }
      if (snap.daily.length > 0) {
        await tx.insert(videoMetricDaily).values(snap.daily);
      }
    }
    for (const day of preimage.creatorDaily) {
      await tx
        .delete(creatorMetricDaily)
        .where(
          and(
            eq(creatorMetricDaily.platform, day.platform),
            eq(creatorMetricDaily.statDate, day.statDate),
          ),
        );
      if (day.old) {
        await tx.insert(creatorMetricDaily).values(day.old);
      }
    }
    await tx.update(importBatch).set({ status: "rolled_back" }).where(eq(importBatch.id, batchId));
  });
  return {
    kind: "rolled_back",
    records: preimage.video.length,
    creatorDailyKeys: preimage.creatorDaily.length,
  };
}

// ── 一键导入（合集快速模式，2026-09-28 用户裁决：零异常自动入库，任何异常整批拦截转四步） ──

export type QuickImportResult =
  | { kind: "committed"; batchId: string; summary: CommitSummary }
  | { kind: "manual_required"; batchId: string; stats: BatchStats | null; reason: string }
  | { kind: "account_day_denied"; batchId: string; reason: string };

/**
 * 合集一键导入：内部走与四步完全相同的状态机与引擎（审计痕迹、preimage、回滚能力一致），
 * 只是无人值守：创建→确认粒度→默认规则→预匹配→全部可自动确认（强证据/双证据 unique）→preflight→提交。
 * 红线：账号日汇总不伪装成作品数据（直接拒绝，引导去四步存账号级）；任何冲突/未匹配 → 整批不入库。
 */
export async function quickImport(input: CreateBatchInput): Promise<QuickImportResult> {
  const created = await createImportBatch(input);
  if (created.kind !== "created") {
    return { kind: "manual_required", batchId: "", stats: null, reason: "文件没有可导入的数据行" };
  }
  const batchId = created.batchId;
  if (created.granularity === "account_day_level") {
    return {
      kind: "account_day_denied",
      batchId,
      reason:
        "本文件为账号日汇总（无作品维度），不能入库为作品数据；已保留批次，请在四步工作台保存为账号日级数据",
    };
  }
  const manual = (stats: BatchStats | null, reason: string): QuickImportResult => ({
    kind: "manual_required",
    batchId,
    stats,
    reason,
  });
  const confirm = await confirmGranularity(batchId, created.granularity);
  if (confirm.kind !== "ok") return manual(null, `粒度确认失败（${confirm.kind}）`);
  const rules = await saveRules(batchId, DEFAULT_MATCH_RULES);
  if (rules.kind !== "ok") return manual(null, `规则初始化失败（${rules.kind}）`);
  const pm = await prematchBatch(batchId, false);
  if (pm.kind !== "ok") return manual(null, `预匹配失败（${pm.kind}）`);
  const { uniqueMatch, conflict, unmatched } = pm.stats;
  if (conflict > 0 || unmatched > 0) {
    return manual(
      pm.stats,
      `存在 ${conflict} 行冲突、${unmatched} 行未匹配，一键模式整批不入库，请在四步工作台处理异常`,
    );
  }
  if (uniqueMatch === 0) return manual(pm.stats, "没有任何可自动匹配的行");
  const confirmed = await applyDecisions(batchId, { action: "confirm", allUnique: true });
  if (confirmed.kind !== "ok") return manual(pm.stats, `批量确认失败（${confirmed.kind}）`);
  const commit = await commitBatch(batchId);
  if (commit.kind !== "committed") {
    return manual(
      await loadStats(batchId),
      commit.kind === "preflight_failed"
        ? "提交前校验未通过，请在四步工作台查看阻断项"
        : `提交失败（${commit.kind}）`,
    );
  }
  return { kind: "committed", batchId, summary: commit.summary };
}
