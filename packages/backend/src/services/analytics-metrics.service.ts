/**
 * 视频指标服务 — Creator Import 落库 + 派生指标统一计算（后端单一口径，需求 §二十四）
 *
 * 真实性约束：
 * - 派生指标输入缺失或除零 → 不落该指标（无数据 ≠ 0，需求 §二十六）
 * - 导入来源仅允许 CREATOR_IMPORT / USER_INPUT，禁止伪装官方 API（需求 §二十二）
 * - 视频级 new_fan_count 属时间窗口归因/估算，导入时必须显式携带 isEstimated（本服务不自动派生粉丝归因）
 */
import { randomBytes } from "node:crypto";
import { and, asc, count, desc, eq, gte, inArray, like, lte, or, sql } from "drizzle-orm";
import { db } from "../db";
import {
  contents,
  creatorMetricDaily,
  publishRecords,
  videoMetricDaily,
  videoMetrics,
} from "../db/schema";
import {
  CREATOR_DAILY_FIELDS,
  type MetricSourceType,
  type MetricUnit,
  derivedMetricNames,
  findCanonicalMetric,
  isCreatorDailyField,
  isImportableMetric,
} from "../lib/analytics-taxonomy";

type Db = typeof db;
/** 可执行器：连接池或事务内 tx（与现有服务同一事务透传惯例） */
type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

// ── 数值归一化（纯函数） ──

export type CoerceResult = { ok: true; value: number } | { ok: false; reason: string };

/** 空值/占位符：创作者导出常用 "-"、"N/A" 等表示无数据，绝不能折算成 0 */
const PLACEHOLDER = new Set(["", "-", "—", "–", "n/a", "na", "null", "none", "暂无"]);

/** 千分位/全角逗号/空格/百分号清洗后解析；rate 单位接受 0~1 小数与百分数（41.3 / "41.3%" → 0.413） */
export function coerceMetricValue(raw: unknown, unit: MetricUnit): CoerceResult {
  if (raw === null || raw === undefined) return { ok: false, reason: "空值" };
  let isPercent = false;
  let num: number;
  if (typeof raw === "number") {
    num = raw;
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (PLACEHOLDER.has(trimmed.toLowerCase())) return { ok: false, reason: "空值或占位符" };
    isPercent = trimmed.endsWith("%");
    let normalized = trimmed.replace(/[,，\s]/g, "").replace(/%$/, "");
    // 时长类接受带单位后缀的导出值（3.94s / 4秒 / 1min20s 不受理，仅简单后缀）
    if (unit === "seconds") {
      normalized = normalized.replace(/(seconds?|secs?|s|秒)$/i, "");
    } else {
      normalized = normalized.replace(/%$/, "");
    }
    normalized = normalized.replace(/,/g, "");
    if (normalized === "" || Number.isNaN(Number(normalized))) {
      return { ok: false, reason: "无法解析为数值" };
    }
    num = Number(normalized);
  } else {
    return { ok: false, reason: "不支持的值类型" };
  }
  if (!Number.isFinite(num)) return { ok: false, reason: "非有限数值" };
  if (unit === "rate") {
    const value = isPercent ? num / 100 : Math.abs(num) > 1 ? num / 100 : num;
    if (value < 0 || value > 1) return { ok: false, reason: "比例类指标超出 0~1 范围" };
    return { ok: true, value };
  }
  if (isPercent) return { ok: false, reason: "计数/时长类指标不接受百分比" };
  if (num < 0) return { ok: false, reason: "负值不合法" };
  return { ok: true, value: num };
}

// ── 派生指标（纯函数，除零/缺输入即跳过） ──

/** 计算公式与 analytics-taxonomy 的 DERIVED 注册表一一对应 */
export function computeDerivedMetrics(
  base: ReadonlyMap<string, number>,
  durationSec: number | null,
): Map<string, number> {
  const out = new Map<string, number>();
  const get = (name: string) => base.get(name);
  const play = get("play_count");
  const bounce = get("bounce_rate_2s");
  if (bounce !== undefined) out.set("effective_play_rate_2s", 1 - bounce);
  if (play !== undefined && play > 0) {
    for (const [src, target] of [
      ["like_count", "like_rate"],
      ["comment_count", "comment_rate"],
      ["share_count", "share_rate"],
      ["collect_count", "collect_rate"],
      ["profile_visit_count", "profile_visit_rate"],
    ] as const) {
      const v = get(src);
      if (v !== undefined) out.set(target, v / play);
    }
    const like = get("like_count");
    const comment = get("comment_count");
    const share = get("share_count");
    if (like !== undefined && comment !== undefined && share !== undefined) {
      out.set("engagement_rate", (like + comment + share) / play);
    }
  }
  const watch = get("avg_watch_time");
  if (watch !== undefined && durationSec !== null && durationSec > 0) {
    out.set("avg_watch_ratio", watch / durationSec);
  }
  return out;
}

// ── 动态字段映射（纯函数，外部列名不写死，需求 §五B） ──

export interface MappedDraft {
  metricName: string;
  metricValue: number;
  sourceField: string;
}
export interface SkippedField {
  field: string;
  reason: string;
}

export function mapImportRow(
  values: Record<string, unknown>,
  mapping: Record<string, string>,
): { drafts: MappedDraft[]; skipped: SkippedField[] } {
  const drafts: MappedDraft[] = [];
  const skipped: SkippedField[] = [];
  for (const [field, raw] of Object.entries(values)) {
    const canonical = mapping[field];
    if (canonical === undefined) {
      skipped.push({ field, reason: "字段未映射" });
      continue;
    }
    if (!findCanonicalMetric(canonical)) {
      skipped.push({ field, reason: `未知指标 ${canonical}` });
      continue;
    }
    if (!isImportableMetric(canonical)) {
      skipped.push({ field, reason: `${canonical} 为派生/预留指标，不接受导入` });
      continue;
    }
    const metric = findCanonicalMetric(canonical);
    const coerced = coerceMetricValue(raw, metric?.unit ?? "count");
    if (!coerced.ok) {
      skipped.push({ field, reason: coerced.reason });
      continue;
    }
    drafts.push({ metricName: canonical, metricValue: coerced.value, sourceField: field });
  }
  return { drafts, skipped };
}

// ── 落库 ──

export interface MetricDraftRow {
  metricName: string;
  metricValue: number;
  sourceType: MetricSourceType;
  sourceField?: string | null;
  dataDate?: string | null;
  isEstimated?: boolean;
  confidence?: number | null;
  metadata?: Record<string, unknown> | null;
}

/** upsert 最新值 + （带 dataDate 时）每日快照（导出供四步导入批次提交在同一事务内复用，单一口径） */
export async function writeMetricRows(
  executor: Executor,
  publishRecordId: string,
  rows: MetricDraftRow[],
): Promise<void> {
  for (const row of rows) {
    const base = {
      publishRecordId,
      metricName: row.metricName,
      metricValue: row.metricValue,
      sourceType: row.sourceType,
      sourceField: row.sourceField ?? null,
      isEstimated: row.isEstimated ? 1 : 0,
      confidence: row.confidence ?? null,
      metadata: row.metadata ?? null,
    };
    await executor
      .insert(videoMetrics)
      .values({ ...base, dataDate: row.dataDate ?? null })
      .onDuplicateKeyUpdate({ set: { ...base, dataDate: row.dataDate ?? null } });
    if (row.dataDate) {
      await executor
        .insert(videoMetricDaily)
        .values({ ...base, dataDate: row.dataDate })
        .onDuplicateKeyUpdate({ set: { ...base } });
    }
  }
}

/** 成片时长（秒）：video.duration 优先，回退 audio.duration（与发布元数据同口径） */
function durationOfContent(video: unknown, audio: unknown): number | null {
  for (const meta of [video, audio]) {
    if (meta && typeof meta === "object" && "duration" in meta) {
      const d = Number((meta as { duration?: unknown }).duration);
      if (Number.isFinite(d) && d > 0) return d;
    }
  }
  return null;
}

/** 导入后统一重算派生指标（PLATFORM_CALCULATED；缺输入的旧派生行同事务内删除，不留陈旧值） */
export async function recomputeDerivedMetrics(
  publishRecordId: string,
  executor: Executor = db,
): Promise<string[]> {
  const [record] = await executor
    .select()
    .from(publishRecords)
    .where(eq(publishRecords.id, publishRecordId))
    .limit(1);
  if (!record) return [];
  const [contentRow] = await executor
    .select({ video: contents.video, audio: contents.audio })
    .from(contents)
    .where(eq(contents.id, record.contentId))
    .limit(1);
  const duration = durationOfContent(contentRow?.video, contentRow?.audio);
  const stored = await executor
    .select({ metricName: videoMetrics.metricName, metricValue: videoMetrics.metricValue })
    .from(videoMetrics)
    .where(eq(videoMetrics.publishRecordId, publishRecordId));
  const base = new Map(stored.map((m) => [m.metricName, m.metricValue]));
  for (const name of derivedMetricNames()) base.delete(name);
  const derived = computeDerivedMetrics(base, duration);
  // 本次算不出的派生行（输入变缺）同步删除，避免陈旧值继续被看板消费
  const computed = new Set(derived.keys());
  const stale = derivedMetricNames().filter((n) => !computed.has(n));
  if (stale.length > 0) {
    await executor
      .delete(videoMetrics)
      .where(
        and(
          eq(videoMetrics.publishRecordId, publishRecordId),
          inArray(videoMetrics.metricName, stale),
        ),
      );
  }
  await writeMetricRows(
    executor,
    publishRecordId,
    [...derived.entries()].map(([metricName, metricValue]) => ({
      metricName,
      metricValue,
      sourceType: "PLATFORM_CALCULATED" as const,
      sourceField: null,
      metadata: { formula: findCanonicalMetric(metricName)?.formula ?? null },
    })),
  );
  return [...derived.keys()];
}

// ── 发布记录 CRUD ──

function makePublishId(): string {
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  return `pub_${ymd}_${randomBytes(3).toString("hex")}`;
}

/** mysql2 唯一键冲突（ER_DUP_ENTRY）：先查后插非原子，并发窗口一律兜底回 duplicate 而非 500 */
function isDupKeyError(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "ER_DUP_ENTRY";
}

/** 从 contents.video.url 提取视频资产文件名（无成片返回 null） */
export function videoAssetIdOf(video: unknown): string | null {
  if (video && typeof video === "object" && "url" in video) {
    const url = (video as { url?: unknown }).url;
    if (typeof url === "string" && url.length > 0) return url.split("/").pop() ?? null;
  }
  return null;
}

export type PublishRecordCreateInput = {
  contentId: string;
  platform: string;
  platformVideoId?: string | null;
  publishTitle?: string | null;
  publishTime?: string | null;
  coverUrl?: string | null;
  publishStatus?: "scheduled" | "published" | "deleted";
};

export type PublishRecordResult =
  | { kind: "created"; id: string }
  | { kind: "content-not-found" }
  | { kind: "duplicate" };

export async function createPublishRecord(
  input: PublishRecordCreateInput,
): Promise<PublishRecordResult> {
  const [content] = await db
    .select({ id: contents.id, video: contents.video })
    .from(contents)
    .where(eq(contents.id, input.contentId))
    .limit(1);
  if (!content) return { kind: "content-not-found" };
  if (input.platformVideoId) {
    const dup = await db
      .select({ id: publishRecords.id })
      .from(publishRecords)
      .where(
        and(
          eq(publishRecords.platform, input.platform),
          eq(publishRecords.platformVideoId, input.platformVideoId),
        ),
      )
      .limit(1);
    if (dup.length > 0) return { kind: "duplicate" };
  }
  const id = makePublishId();
  try {
    await db.insert(publishRecords).values({
      id,
      contentId: input.contentId,
      videoAssetId: videoAssetIdOf(content.video),
      platform: input.platform,
      platformVideoId: input.platformVideoId ?? null,
      publishTitle: input.publishTitle ?? null,
      publishTime: input.publishTime ? new Date(input.publishTime) : null,
      coverUrl: input.coverUrl ?? null,
      publishStatus: input.publishStatus ?? "published",
    });
  } catch (e) {
    if (isDupKeyError(e)) return { kind: "duplicate" };
    throw e;
  }
  return { kind: "created", id };
}

export interface PublishRecordListItem {
  id: string;
  contentId: string;
  contentTitle: string;
  template: string;
  videoAssetId: string | null;
  platform: string;
  platformVideoId: string | null;
  publishTitle: string | null;
  publishTime: string | null;
  coverUrl: string | null;
  publishStatus: string;
  createdAt: string;
  updatedAt: string;
}

const iso = (value: Date | string | null): string | null =>
  value instanceof Date ? value.toISOString() : value;

export async function listPublishRecords(query: {
  platform?: string;
  contentId?: string;
  /** 模糊搜索（发布标题/内容标题/作品 ID），导入向导未匹配行手动绑定用 */
  keyword?: string;
  page: number;
  pageSize: number;
}): Promise<{ items: PublishRecordListItem[]; total: number }> {
  const conditions = [];
  if (query.platform) conditions.push(eq(publishRecords.platform, query.platform));
  if (query.contentId) conditions.push(eq(publishRecords.contentId, query.contentId));
  if (query.keyword) {
    const kw = `%${query.keyword}%`;
    conditions.push(
      or(
        like(publishRecords.publishTitle, kw),
        like(contents.title, kw),
        like(publishRecords.platformVideoId, kw),
      ),
    );
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const rows = await db
    .select({
      record: publishRecords,
      contentTitle: contents.title,
      template: contents.template,
    })
    .from(publishRecords)
    .innerJoin(contents, eq(contents.id, publishRecords.contentId))
    .where(where)
    .orderBy(desc(publishRecords.createdAt))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  // count 与列表同构 join（keyword 条件引用 contents.title，不 join 会 Unknown column；FK 保证行集不变）
  const totalRows = await db
    .select({ n: count() })
    .from(publishRecords)
    .innerJoin(contents, eq(contents.id, publishRecords.contentId))
    .where(where);
  const total = Number(totalRows[0]?.n ?? 0);
  return {
    items: rows.map(({ record, contentTitle, template }) => ({
      id: record.id,
      contentId: record.contentId,
      contentTitle,
      template,
      videoAssetId: record.videoAssetId,
      platform: record.platform,
      platformVideoId: record.platformVideoId,
      publishTitle: record.publishTitle,
      publishTime: iso(record.publishTime),
      coverUrl: record.coverUrl,
      publishStatus: record.publishStatus,
      createdAt: iso(record.createdAt) ?? String(record.createdAt),
      updatedAt: iso(record.updatedAt) ?? String(record.updatedAt),
    })),
    total,
  };
}

export type PublishRecordPatchInput = Partial<PublishRecordCreateInput> & {
  videoAssetId?: string | null;
};

export async function updatePublishRecord(
  id: string,
  patch: PublishRecordPatchInput,
): Promise<"updated" | "not-found" | "duplicate"> {
  const [existing] = await db
    .select()
    .from(publishRecords)
    .where(eq(publishRecords.id, id))
    .limit(1);
  if (!existing) return "not-found";
  const platform = patch.platform ?? existing.platform;
  const platformVideoId =
    patch.platformVideoId !== undefined ? patch.platformVideoId : existing.platformVideoId;
  if (
    platformVideoId &&
    (platform !== existing.platform || platformVideoId !== existing.platformVideoId)
  ) {
    const dup = await db
      .select({ id: publishRecords.id })
      .from(publishRecords)
      .where(
        and(
          eq(publishRecords.platform, platform),
          eq(publishRecords.platformVideoId, platformVideoId),
        ),
      )
      .limit(1);
    if (dup.length > 0 && dup[0].id !== id) return "duplicate";
  }
  try {
    await db
      .update(publishRecords)
      .set({
        ...(patch.contentId !== undefined ? { contentId: patch.contentId } : {}),
        ...(patch.videoAssetId !== undefined ? { videoAssetId: patch.videoAssetId } : {}),
        ...(patch.platform !== undefined ? { platform } : {}),
        ...(patch.platformVideoId !== undefined ? { platformVideoId } : {}),
        ...(patch.publishTitle !== undefined ? { publishTitle: patch.publishTitle } : {}),
        ...(patch.publishTime !== undefined
          ? { publishTime: patch.publishTime ? new Date(patch.publishTime) : null }
          : {}),
        ...(patch.coverUrl !== undefined ? { coverUrl: patch.coverUrl } : {}),
        ...(patch.publishStatus !== undefined ? { publishStatus: patch.publishStatus } : {}),
        updatedAt: new Date(),
      })
      .where(eq(publishRecords.id, id));
  } catch (e) {
    if (isDupKeyError(e)) return "duplicate";
    throw e;
  }
  return "updated";
}

/** 删除发布记录（指标级联）；不存在时返回 false 供路由回 404，不再假报删除成功 */
export async function deletePublishRecord(id: string): Promise<boolean> {
  const [existing] = await db
    .select({ id: publishRecords.id })
    .from(publishRecords)
    .where(eq(publishRecords.id, id))
    .limit(1);
  if (!existing) return false;
  await db.delete(publishRecords).where(eq(publishRecords.id, id));
  return true;
}

// ── 指标查询（含 provenance） ──

export interface MetricView {
  metricName: string;
  label: string;
  unit: string;
  availability: string;
  metricValue: number;
  sourceType: string;
  sourceField: string | null;
  dataDate: string | null;
  isEstimated: boolean;
  confidence: number | null;
  fetchedAt: string;
}

function metricView(row: {
  metricName: string;
  metricValue: number;
  sourceType: string;
  sourceField: string | null;
  dataDate: string | null;
  isEstimated: number;
  confidence: number | null;
  fetchedAt: Date;
}): MetricView {
  const def = findCanonicalMetric(row.metricName);
  return {
    metricName: row.metricName,
    label: def?.label ?? row.metricName,
    unit: def?.unit ?? "count",
    availability: def?.availability ?? "FUTURE",
    metricValue: row.metricValue,
    sourceType: row.sourceType,
    sourceField: row.sourceField,
    dataDate: row.dataDate,
    isEstimated: row.isEstimated === 1,
    confidence: row.confidence,
    fetchedAt: row.fetchedAt.toISOString(),
  };
}

export interface RecordMetricsView {
  recordId: string;
  platform: string;
  platformVideoId: string | null;
  publishTime: string | null;
  latest: MetricView[];
  daily: MetricView[];
}

/** 单视频指标读取：一个内容可能发布到多平台，逐发布记录返回；无数据 ≠ 0（§二十六） */
export async function getRecordMetrics(
  contentId: string,
  query: { platform?: string; dateFrom?: string; dateTo?: string },
): Promise<{ records: RecordMetricsView[]; emptyReason: string | null }> {
  const [content] = await db
    .select({ id: contents.id })
    .from(contents)
    .where(eq(contents.id, contentId))
    .limit(1);
  if (!content) return { records: [], emptyReason: "content_not_found" };
  const recordWhere = query.platform
    ? and(eq(publishRecords.contentId, contentId), eq(publishRecords.platform, query.platform))
    : eq(publishRecords.contentId, contentId);
  const records = await db
    .select()
    .from(publishRecords)
    .where(recordWhere)
    .orderBy(asc(publishRecords.createdAt));
  if (records.length === 0) return { records: [], emptyReason: "not_published" };
  const recordIds = records.map((r) => r.id);
  const latestRows = await db
    .select()
    .from(videoMetrics)
    .where(inArray(videoMetrics.publishRecordId, recordIds));
  const dailyConditions = [inArray(videoMetricDaily.publishRecordId, recordIds)];
  if (query.dateFrom) dailyConditions.push(gte(videoMetricDaily.dataDate, query.dateFrom));
  if (query.dateTo) dailyConditions.push(lte(videoMetricDaily.dataDate, query.dateTo));
  const dailyRows = await db
    .select()
    .from(videoMetricDaily)
    .where(and(...dailyConditions))
    .orderBy(asc(videoMetricDaily.dataDate));
  const hasAny = latestRows.length > 0 || dailyRows.length > 0;
  return {
    records: records.map((record) => ({
      recordId: record.id,
      platform: record.platform,
      platformVideoId: record.platformVideoId,
      publishTime: iso(record.publishTime),
      latest: latestRows.filter((m) => m.publishRecordId === record.id).map(metricView),
      daily: dailyRows.filter((m) => m.publishRecordId === record.id).map(metricView),
    })),
    emptyReason: hasAny ? null : "not_imported",
  };
}

// ── Creator Import 编排 ──

export interface ImportRowRequest {
  match: { recordId?: string; platformVideoId?: string; platform?: string; contentId?: string };
  values: Record<string, unknown>;
  dataDate?: string;
}

export interface ImportRequest {
  sourceType: MetricSourceType;
  metricMapping: Record<string, string>;
  dataDate?: string;
  rows: ImportRowRequest[];
  /** 请求级批次号（批次 3B）：写入行 metadata.batch_id 供审计/回滚定位 */
  batchId?: string;
}

export interface ImportRowResult {
  row: number;
  ok: boolean;
  recordId: string | null;
  written: string[];
  skipped: SkippedField[];
  derived: string[];
  error?: string;
}

/** 行匹配：recordId > platformVideoId(+platform) > platform+contentId；禁止标题模糊匹配（需求 §七） */
async function resolveRecordId(match: ImportRowRequest["match"]): Promise<string | null> {
  if (match.recordId) {
    const [row] = await db
      .select({ id: publishRecords.id })
      .from(publishRecords)
      .where(eq(publishRecords.id, match.recordId))
      .limit(1);
    return row?.id ?? null;
  }
  if (match.platformVideoId) {
    const conditions = [eq(publishRecords.platformVideoId, match.platformVideoId)];
    if (match.platform) conditions.push(eq(publishRecords.platform, match.platform));
    const [row] = await db
      .select({ id: publishRecords.id })
      .from(publishRecords)
      .where(and(...conditions))
      .limit(1);
    return row?.id ?? null;
  }
  if (match.platform && match.contentId) {
    const [row] = await db
      .select({ id: publishRecords.id })
      .from(publishRecords)
      .where(
        and(
          eq(publishRecords.platform, match.platform),
          eq(publishRecords.contentId, match.contentId),
        ),
      )
      .limit(1);
    return row?.id ?? null;
  }
  return null;
}

export async function importMetrics(request: ImportRequest): Promise<ImportRowResult[]> {
  const results: ImportRowResult[] = [];
  for (const [index, row] of request.rows.entries()) {
    const base: ImportRowResult = {
      row: index,
      ok: false,
      recordId: null,
      written: [],
      skipped: [],
      derived: [],
    };
    const recordId = await resolveRecordId(row.match);
    if (!recordId) {
      results.push({
        ...base,
        error: "发布记录未找到（需 recordId / platformVideoId / platform+contentId）",
      });
      continue;
    }
    const { drafts, skipped } = mapImportRow(row.values, request.metricMapping);
    const dataDate = row.dataDate ?? request.dataDate ?? null;
    const written = drafts.map((d) => {
      const def = findCanonicalMetric(d.metricName);
      const meta: Record<string, unknown> = {
        ...(def?.note ? { note: def.note } : {}),
        ...(request.batchId ? { batch_id: request.batchId } : {}),
      };
      return {
        metricName: d.metricName,
        metricValue: d.metricValue,
        sourceType: request.sourceType,
        sourceField: d.sourceField,
        dataDate,
        // 视频级新增粉丝属时间窗口归因：不得伪装精确归因，统一标记估算
        isEstimated: d.metricName === "new_fan_count" || undefined,
        metadata: Object.keys(meta).length > 0 ? meta : null,
      } satisfies MetricDraftRow;
    });
    // 单行一个事务：原始指标写入 + 派生重算全有或全无（重算失败不留半写状态）
    let derived: string[] = [];
    try {
      await db.transaction(async (tx) => {
        await writeMetricRows(tx, recordId, written);
        derived = await recomputeDerivedMetrics(recordId, tx);
      });
    } catch (error) {
      results.push({
        ...base,
        recordId,
        skipped,
        error: error instanceof Error ? error.message : "写入失败",
      });
      continue;
    }
    results.push({
      ...base,
      ok: drafts.length > 0,
      recordId,
      written: drafts.map((d) => d.metricName),
      skipped,
      derived,
    });
  }
  return results;
}

// ── 账号每日聚合 ──

export interface CreatorDailyInput {
  platform: string;
  date: string;
  sourceType: MetricSourceType;
  playIncrement?: number | null;
  likeIncrement?: number | null;
  commentIncrement?: number | null;
  shareIncrement?: number | null;
  profileUV?: number | null;
  newFans?: number | null;
  totalFans?: number | null;
}

export async function upsertCreatorDaily(input: CreatorDailyInput): Promise<void> {
  const values = {
    platform: input.platform,
    statDate: input.date,
    playIncrement: input.playIncrement ?? null,
    likeIncrement: input.likeIncrement ?? null,
    commentIncrement: input.commentIncrement ?? null,
    shareIncrement: input.shareIncrement ?? null,
    profileUV: input.profileUV ?? null,
    newFans: input.newFans ?? null,
    totalFans: input.totalFans ?? null,
    sourceType: input.sourceType,
  };
  await db
    .insert(creatorMetricDaily)
    .values(values)
    .onDuplicateKeyUpdate({ set: { ...values, fetchedAt: sql`now()` } });
}

/** 账号日行 upsert（(platform, statDate) 幂等，仅覆盖提供列）；导出供批次提交在同一事务内复用 */
export async function upsertCreatorDailyRow(
  executor: Executor,
  input: {
    platform: string;
    statDate: string;
    sourceType: MetricSourceType;
    fields: Record<string, number>;
    metadata?: Record<string, unknown> | null;
  },
): Promise<void> {
  const values = {
    platform: input.platform,
    statDate: input.statDate,
    sourceType: input.sourceType,
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...input.fields,
  };
  await executor
    .insert(creatorMetricDaily)
    .values(values)
    .onDuplicateKeyUpdate({ set: { ...values, fetchedAt: sql`now()` } });
}

export async function listCreatorDaily(query: {
  platform?: string;
  dateFrom?: string;
  dateTo?: string;
}) {
  const conditions = [];
  if (query.platform) conditions.push(eq(creatorMetricDaily.platform, query.platform));
  if (query.dateFrom) conditions.push(gte(creatorMetricDaily.statDate, query.dateFrom));
  if (query.dateTo) conditions.push(lte(creatorMetricDaily.statDate, query.dateTo));
  const where = conditions.length > 0 ? and(...conditions) : undefined;
  const rows = await db
    .select()
    .from(creatorMetricDaily)
    .where(where)
    .orderBy(asc(creatorMetricDaily.statDate))
    .limit(366);
  return rows.map((r) => ({
    platform: r.platform,
    date: r.statDate,
    playIncrement: r.playIncrement,
    likeIncrement: r.likeIncrement,
    commentIncrement: r.commentIncrement,
    shareIncrement: r.shareIncrement,
    profileUV: r.profileUV,
    newFans: r.newFans,
    totalFans: r.totalFans,
    bounceRate2s: r.bounceRate2s,
    watchRate5s: r.watchRate5s,
    avgWatchTime: r.avgWatchTime,
    postCount: r.postCount,
    coverClickRate: r.coverClickRate,
    sourceType: r.sourceType,
    fetchedAt: r.fetchedAt.toISOString(),
  }));
}

// ── 账号日汇总批量导入（导入向导第④步：操作者逐行裁决归属，系统不自动拆数） ──

/** 账号日字段 → 视频级 canonical 指标（仅这些可归属到作品；其余字段账号级专属） */
const ATTRIBUTABLE_TO_VIDEO: Record<string, string> = {
  playIncrement: "play_count",
  likeIncrement: "like_count",
  commentIncrement: "comment_count",
  shareIncrement: "share_count",
  profileUV: "profile_visit_count",
  newFans: "new_fan_count",
  bounceRate2s: "bounce_rate_2s",
  watchRate5s: "watch_rate_5s",
  avgWatchTime: "avg_watch_time",
};

export interface CreatorDailyImportRowInput {
  statDate: string;
  values: Record<string, unknown>;
  attribution: { mode: "account" } | { mode: "video"; recordId: string };
}

export interface CreatorDailyImportRequest {
  platform: string;
  sourceType: MetricSourceType;
  /** 外部列名 → 账号日字段名（动态映射，列名不写死） */
  fieldMapping: Record<string, string>;
  rows: CreatorDailyImportRowInput[];
  /** 请求级批次号（批次 3B）：账号日行与归属视频行 metadata 同一此值 */
  batchId?: string;
}

export interface CreatorDailyImportRowResult {
  row: number;
  ok: boolean;
  statDate: string;
  dailyWritten: string[];
  videoRecordId: string | null;
  videoWritten: string[];
  videoDerived: string[];
  skipped: { field: string; reason: string }[];
  error?: string;
}

/** 纯函数：外部列→账号日字段映射 + 值归一化（与视频导入同一 coerce 口径） */
export function mapCreatorDailyRow(
  values: Record<string, unknown>,
  fieldMapping: Record<string, string>,
): { fields: Record<string, number>; skipped: { field: string; reason: string }[] } {
  const fields: Record<string, number> = {};
  const skipped: { field: string; reason: string }[] = [];
  for (const [col, raw] of Object.entries(values)) {
    const fieldName = fieldMapping[col];
    if (!fieldName) {
      skipped.push({ field: col, reason: "未映射列" });
      continue;
    }
    if (!isCreatorDailyField(fieldName)) {
      skipped.push({ field: col, reason: `未知账号日字段「${fieldName}」` });
      continue;
    }
    const def = CREATOR_DAILY_FIELDS.find((f) => f.name === fieldName);
    if (!def) {
      skipped.push({ field: col, reason: `字段「${fieldName}」不在目录` });
      continue;
    }
    const coerced = coerceMetricValue(raw, def.unit);
    if (!coerced.ok) {
      skipped.push({ field: col, reason: coerced.reason });
      continue;
    }
    fields[fieldName] = def.unit === "count" ? Math.round(coerced.value) : coerced.value;
  }
  return { fields, skipped };
}

export async function importCreatorDaily(
  request: CreatorDailyImportRequest,
): Promise<CreatorDailyImportRowResult[]> {
  const results: CreatorDailyImportRowResult[] = [];
  for (const [index, row] of request.rows.entries()) {
    const base: CreatorDailyImportRowResult = {
      row: index,
      ok: false,
      statDate: row.statDate,
      dailyWritten: [],
      videoRecordId: null,
      videoWritten: [],
      videoDerived: [],
      skipped: [],
    };
    const { fields, skipped } = mapCreatorDailyRow(row.values, request.fieldMapping);
    if (Object.keys(fields).length === 0) {
      results.push({ ...base, error: "本行没有任何合法字段值", skipped });
      continue;
    }
    // 归属目标校验：操作者裁决指定的发布记录必须存在（失败回给本行原因，不崩整单）
    let targetRecord: { id: string; contentId: string } | null = null;
    if (row.attribution.mode === "video") {
      const [found] = await db
        .select({ id: publishRecords.id, contentId: publishRecords.contentId })
        .from(publishRecords)
        .where(eq(publishRecords.id, row.attribution.recordId))
        .limit(1);
      if (!found) {
        results.push({
          ...base,
          skipped,
          error: `归属目标发布记录不存在：${row.attribution.recordId}`,
        });
        continue;
      }
      targetRecord = found;
    }
    try {
      // 单行一个事务：账号日 upsert + 视频级归属写 + 派生重算全有或全无，
      // 中段失败不会留下「账号已记账号日、视频层半写」的不一致状态
      let videoWritten: string[] = [];
      let videoDerived: string[] = [];
      const videoSkipped: { field: string; reason: string }[] = [];
      await db.transaction(async (tx) => {
        // 1) 账号日 upsert：仅 set 本行提供的列（不清空存量列），(platform, stat_date) 幂等覆盖
        const setCols: Record<string, unknown> = {
          ...fields,
          sourceType: request.sourceType,
          ...(request.batchId ? { metadata: { batch_id: request.batchId } } : {}),
        };
        await tx
          .insert(creatorMetricDaily)
          .values({
            platform: request.platform,
            statDate: row.statDate,
            sourceType: request.sourceType,
            ...(request.batchId ? { metadata: { batch_id: request.batchId } } : {}),
            ...fields,
          })
          .onDuplicateKeyUpdate({ set: { ...setCols, fetchedAt: sql`now()` } });
        // 2) 归属行→视频级近似落库（必携 isEstimated + 近似声明，这是操作者裁决的结果而非系统推断）
        if (targetRecord !== null) {
          const drafts: MetricDraftRow[] = [];
          for (const [fieldName, value] of Object.entries(fields)) {
            const metricName = ATTRIBUTABLE_TO_VIDEO[fieldName];
            if (!metricName) {
              videoSkipped.push({ field: fieldName, reason: "账号级专属字段，不写入视频指标" });
              continue;
            }
            drafts.push({
              metricName,
              metricValue: value,
              sourceType: request.sourceType,
              sourceField: fieldName,
              dataDate: row.statDate,
              isEstimated: true,
              metadata: {
                matched_by: "operator_confirmed",
                ...(request.batchId ? { batch_id: request.batchId } : {}),
                note: "账号日汇总按日期归属到作品（含当日老视频长尾，近似归因）",
              },
            });
          }
          await writeMetricRows(tx, targetRecord.id, drafts);
          videoWritten = drafts.map((d) => d.metricName);
          videoDerived = await recomputeDerivedMetrics(targetRecord.id, tx);
        }
      });
      const rowSkipped = [...skipped, ...videoSkipped];
      if (targetRecord !== null) {
        results.push({
          ...base,
          ok: true,
          dailyWritten: Object.keys(fields),
          videoRecordId: targetRecord.id,
          videoWritten,
          videoDerived,
          skipped: rowSkipped,
        });
        continue;
      }
      results.push({ ...base, ok: true, dailyWritten: Object.keys(fields), skipped: rowSkipped });
    } catch (error) {
      results.push({
        ...base,
        skipped,
        error: error instanceof Error ? error.message : "写入失败",
      });
    }
  }
  return results;
}
