/**
 * 统一内容主视图服务（docs/22 §5.1，GET /api/analytics/content-videos）
 *
 * 与既有 GET /api/analytics/videos 的分工（旧契约逐字保留，不改行锚点）：
 * - 旧接口以 publish_records 为行锚点，一条发布记录一行——本地成片但从未登记的集只能
 *   靠 unregisteredContentCount 点破，看不见内容本体。
 * - 本接口以 contents 为行锚点，一条内容一行，平台发布记录与指标作为 platforms[] 明细，
 *   于是「生产了什么 / 发到了哪 / 表现如何」第一次能在同一行里对齐。
 *
 * 纪律（docs/22 §3 不变量）：
 * - 未发布的本地成片进入列表，但**不创建 local 伪平台记录**（platforms 为空数组）。
 * - 主行不提供任何跨平台合计：播放/点赞/完播/互动只在各平台明细里读，平台口径不同不相加。
 * - 指标缺键 = 无数据，不补 0；发布时间来源为 null = 旧记录无法判定，不事后编一个来源。
 */
import { type SQL, and, count, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import {
  contentFeatures,
  contents,
  importRow,
  matchCandidate,
  publishRecords,
  videoMetrics,
} from "../db/schema";
import type { MetricSourceType, PublishTimeSource } from "../lib/analytics-taxonomy";

// ── 状态口径 ──

/** 内容行状态（docs/22 §5.1 status 查询参数的取值全集，禁增） */
export const CONTENT_VIDEO_STATUSES = [
  "unpublished",
  "published_unimported",
  "imported",
  "import_conflict",
  "failed",
  "deleted",
] as const;

export type ContentVideoStatus = (typeof CONTENT_VIDEO_STATUSES)[number];

/** status 查询参数全集：六个真实状态 + all（= 默认口径「已完成且有成片」） */
export const CONTENT_VIDEO_STATUS_FILTERS = [...CONTENT_VIDEO_STATUSES, "all"] as const;
export type ContentVideoStatusFilter = (typeof CONTENT_VIDEO_STATUS_FILTERS)[number];

export const CONTENT_VIDEO_SORTS = [
  "created_time",
  "publish_time",
  "play",
  "completion",
  "engagement",
] as const;
export type ContentVideoSort = (typeof CONTENT_VIDEO_SORTS)[number];

/**
 * 主状态优先级：越靠前越优先。一行只展示一个主状态，但判定口径必须只在这里讲一次，
 * 否则筛选谓词与界面徽标会各写一套、迟早飘掉。
 */
const STATUS_PRIORITY: ContentVideoStatus[] = [
  "failed",
  "import_conflict",
  "deleted",
  "imported",
  "published_unimported",
  "unpublished",
];

/** 排序键 → canonical 指标名（与旧 /videos 白名单同一批指标） */
const SORT_METRIC: Partial<Record<ContentVideoSort, string>> = {
  play: "play_count",
  completion: "completion_rate",
  engagement: "engagement_rate",
};

export interface MetricCellView {
  value: number;
  sourceType: MetricSourceType;
  isEstimated: boolean;
  dataDate: string | null;
}

interface PlatformInput {
  recordId: string;
  platform: string;
  platformVideoId: string | null;
  publishStatus: "scheduled" | "published" | "deleted";
  publishTime: Date | null;
  publishTimeSource: PublishTimeSource | null;
  metrics: Record<string, MetricCellView>;
  /** 仍有未裁决的导入冲突把这条记录列为候选 */
  hasImportConflict: boolean;
}

export interface ContentVideoInput {
  contentId: string;
  title: string;
  template: string;
  level: string;
  /** contents.status 原值（前端按 ContentStatus 语义展示） */
  localStatus: string;
  createdAt: Date;
  videoAssetId: string | null;
  durationSec: number | null;
  platforms: PlatformInput[];
}

export interface ContentVideoPlatformView {
  recordId: string;
  platform: string;
  platformVideoId: string | null;
  publishStatus: string;
  publishTime: string | null;
  publishTimeSource: PublishTimeSource | null;
  metricCount: number;
  /** 冲突态不落在发布记录列上，只能由行集判定透出，故明细里显式给一个布尔 */
  hasImportConflict: boolean;
  metrics: Record<string, MetricCellView>;
}

export interface ContentVideoItem {
  contentId: string;
  title: string;
  template: string;
  level: string;
  localStatus: string;
  /** 本地生成完成时间（contents.createdAt）；不冒充平台发布时间 */
  generatedAt: string;
  videoAssetId: string | null;
  durationSec: number | null;
  /** 本行主状态（按 STATUS_PRIORITY 判定） */
  status: ContentVideoStatus;
  /** 命中的全部状态（一行可以同时是 imported 且有导入冲突） */
  statuses: ContentVideoStatus[];
  /** 去重后的平台数（同平台多条记录时小于 platforms.length） */
  platformCount: number;
  metricCoverage: {
    platforms: number;
    records: number;
    recordsWithMetrics: number;
  };
  platforms: ContentVideoPlatformView[];
}

/**
 * 命中的状态全集（纯函数）：每个判定只读真实存在的事实，缺数据不折算成任何一种「0 表现」。
 *
 * `unpublished` 的定义是「有真实成片但没发布」——生成失败/未出片的行不该顶着这个标签，
 * 它的真实状态是 failed，所以这里需要显式区分有没有成片产物。
 */
export function contentStatusesOf(input: {
  localStatus: string;
  hasVideoArtifact: boolean;
  platforms: { publishStatus: string; metricCount: number; hasImportConflict: boolean }[];
}): ContentVideoStatus[] {
  const hit = new Set<ContentVideoStatus>();
  if (input.localStatus === "failed") hit.add("failed");
  const records = input.platforms;
  if (records.length === 0 && input.hasVideoArtifact) hit.add("unpublished");
  if (records.some((r) => r.hasImportConflict)) hit.add("import_conflict");
  if (records.length > 0 && records.every((r) => r.publishStatus === "deleted")) hit.add("deleted");
  if (records.some((r) => r.metricCount > 0)) hit.add("imported");
  if (records.length > 0 && records.every((r) => r.metricCount === 0))
    hit.add("published_unimported");
  return STATUS_PRIORITY.filter((s) => hit.has(s));
}

/** 单条内容的视图组装（纯函数；iso 转换与「不相加」纪律在此一处收口，可单测） */
export function buildContentVideoItem(input: ContentVideoInput): ContentVideoItem {
  const platforms: ContentVideoPlatformView[] = input.platforms.map((p) => ({
    recordId: p.recordId,
    platform: p.platform,
    platformVideoId: p.platformVideoId,
    publishStatus: p.publishStatus,
    publishTime: p.publishTime ? p.publishTime.toISOString() : null,
    publishTimeSource: p.publishTimeSource,
    metricCount: Object.keys(p.metrics).length,
    hasImportConflict: p.hasImportConflict,
    metrics: p.metrics,
  }));
  const statuses = contentStatusesOf({
    localStatus: input.localStatus,
    hasVideoArtifact: input.videoAssetId !== null,
    platforms,
  });
  const platformCount = new Set(platforms.map((p) => p.platform)).size;
  return {
    contentId: input.contentId,
    title: input.title,
    template: input.template,
    level: input.level,
    localStatus: input.localStatus,
    generatedAt: input.createdAt.toISOString(),
    videoAssetId: input.videoAssetId,
    durationSec: input.durationSec,
    status: statuses[0] ?? "unpublished",
    statuses,
    platformCount,
    metricCoverage: {
      platforms: platformCount,
      records: platforms.length,
      recordsWithMetrics: platforms.filter((p) => p.metricCount > 0).length,
    },
    platforms,
  };
}

// ── 行集谓词 ──

/** 内容行的视频产物文件名（contents.video 是 JSON {url,...}；无产物回 null） */
function videoAssetOf(video: unknown): string | null {
  if (video && typeof video === "object" && "url" in video) {
    const url = (video as { url?: unknown }).url;
    if (typeof url === "string" && url.length > 0) return url.split("/").pop() ?? null;
  }
  return null;
}

/** 与既有 /videos、工作台、标记页同一判据：video 列非空即有真实成片 */
const hasVideoArtifact = sql`${contents.video} is not null`;

/** 平台过滤只在相关子查询内部生效，主查询保持 contents 单表（行锚点=内容，一条一行） */
function scoped(cond: SQL | undefined, inner: SQL): SQL {
  return cond ? sql`${inner} and ${cond}` : inner;
}

function existsRecord(platformCond?: SQL): SQL {
  return sql`exists (select 1 from ${publishRecords} where ${scoped(
    platformCond,
    sql`${publishRecords.contentId} = ${contents.id}`,
  )})`;
}

function existsMetric(platformCond?: SQL): SQL {
  return sql`exists (select 1 from ${publishRecords} join ${videoMetrics} on ${videoMetrics.publishRecordId} = ${publishRecords.id} where ${scoped(
    platformCond,
    sql`${publishRecords.contentId} = ${contents.id}`,
  )})`;
}

/**
 * 导入冲突 = 仍有 match_status='conflict' 的导入行把该平台记录列为候选（待人工裁决归属）。
 * 不新造「冲突」标记列：冲突只存在于导入中间层，判据必须来自那里。
 */
function existsConflict(platformCond?: SQL): SQL {
  return sql`exists (select 1 from ${matchCandidate} join ${importRow} on ${importRow.id} = ${matchCandidate.importRowId} join ${publishRecords} on ${publishRecords.id} = ${matchCandidate.videoId} where ${importRow.matchStatus} = 'conflict' and ${scoped(
    platformCond,
    sql`${publishRecords.contentId} = ${contents.id}`,
  )})`;
}

function existsDeleted(platformCond?: SQL): SQL {
  return sql`exists (select 1 from ${publishRecords} where ${publishRecords.publishStatus} = 'deleted' and ${scoped(
    platformCond,
    sql`${publishRecords.contentId} = ${contents.id}`,
  )})`;
}

/**
 * 状态筛选 → 行集谓词（导出供单测逐态钉住）。
 *
 * 默认（all）只要「已完成且有真实视频产物」；显式指定状态时放开 completed 要求
 * （否则 failed/deleted 永远筛不出来），但未发布/已发布/导入类仍要求有产物——
 * 没有产物就没有可分析的内容行。
 */
export function rowPredicate(
  status: ContentVideoStatusFilter,
  platformCond?: SQL,
): SQL | undefined {
  const record = existsRecord(platformCond);
  const metrics = existsMetric(platformCond);
  switch (status) {
    case "unpublished":
      return and(hasVideoArtifact, sql`not ${record}`);
    case "published_unimported":
      return and(hasVideoArtifact, record, sql`not ${metrics}`);
    case "imported":
      return and(hasVideoArtifact, metrics);
    case "import_conflict":
      return and(hasVideoArtifact, existsConflict(platformCond));
    case "failed":
      return eq(contents.status, "failed");
    case "deleted":
      return existsDeleted(platformCond);
    case "all":
      return and(eq(contents.status, "completed"), hasVideoArtifact);
  }
}

export interface ContentVideoQuery {
  status: ContentVideoStatusFilter;
  platform?: string;
  sort: ContentVideoSort;
  order: "asc" | "desc";
  page: number;
  pageSize: number;
}

export interface ContentVideoPage {
  items: ContentVideoItem[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * 排序表达式（标量子查询）。
 *
 * publish_time 取该内容各平台记录里最近一次发布时间，play/completion/engagement 取
 * 各平台该指标的**最好值**（max）——跨平台口径不可比，所以只用于排序取一档，
 * 绝不做 sum/avg：合计会把两个平台的口径混成一个哪里都不存在的数字。
 * 缺数据恒排末（`is null` 前置位），与旧 /videos 同一实现手法。
 */
export function orderBySql(sort: ContentVideoSort, order: "asc" | "desc"): SQL[] {
  const dir = order === "asc" ? sql`asc` : sql`desc`;
  if (sort === "created_time") return [sql`${contents.createdAt} ${dir}`];
  const key =
    sort === "publish_time"
      ? sql`(select max(coalesce(${publishRecords.publishTime}, ${publishRecords.createdAt})) from ${publishRecords} where ${publishRecords.contentId} = ${contents.id})`
      : sql`(select max(${videoMetrics.metricValue}) from ${videoMetrics} join ${publishRecords} on ${publishRecords.id} = ${videoMetrics.publishRecordId} where ${publishRecords.contentId} = ${contents.id} and ${videoMetrics.metricName} = ${SORT_METRIC[sort] ?? "play_count"})`;
  return [sql`${key} is null`, sql`${key} ${dir}`, sql`${contents.createdAt} desc`];
}

const recordSelect = {
  recordId: publishRecords.id,
  contentId: publishRecords.contentId,
  platform: publishRecords.platform,
  platformVideoId: publishRecords.platformVideoId,
  publishStatus: publishRecords.publishStatus,
  publishTime: publishRecords.publishTime,
  publishTimeSource: publishRecords.publishTimeSource,
};

export async function listContentVideos(query: ContentVideoQuery): Promise<ContentVideoPage> {
  const platformCond = query.platform ? eq(publishRecords.platform, query.platform) : undefined;
  const where = rowPredicate(query.status, platformCond);

  const [totalRow] = await db.select({ n: count() }).from(contents).where(where);
  const total = Number(totalRow?.n ?? 0);
  const pageRows = await db
    .select({ contentId: contents.id })
    .from(contents)
    .where(where)
    .orderBy(...orderBySql(query.sort, query.order))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  const contentIds = pageRows.map((r) => r.contentId);
  if (contentIds.length === 0) {
    return { items: [], total, page: query.page, pageSize: query.pageSize };
  }

  const recordWhere = and(
    inArray(publishRecords.contentId, contentIds),
    ...(platformCond ? [platformCond] : []),
  );
  const [contentRows, recordRows, featureRows] = await Promise.all([
    db
      .select({
        id: contents.id,
        title: contents.title,
        template: contents.template,
        level: contents.level,
        status: contents.status,
        createdAt: contents.createdAt,
        video: contents.video,
      })
      .from(contents)
      .where(inArray(contents.id, contentIds)),
    db.select(recordSelect).from(publishRecords).where(recordWhere),
    db
      .select({ contentId: contentFeatures.contentId, duration: contentFeatures.duration })
      .from(contentFeatures)
      .where(inArray(contentFeatures.contentId, contentIds)),
  ]);
  const recordIds = recordRows.map((r) => r.recordId);
  const [metricRows, conflictRows] = await Promise.all([
    recordIds.length > 0
      ? db
          .select({
            publishRecordId: videoMetrics.publishRecordId,
            metricName: videoMetrics.metricName,
            metricValue: videoMetrics.metricValue,
            sourceType: videoMetrics.sourceType,
            isEstimated: videoMetrics.isEstimated,
            dataDate: videoMetrics.dataDate,
          })
          .from(videoMetrics)
          .where(inArray(videoMetrics.publishRecordId, recordIds))
      : Promise.resolve([]),
    recordIds.length > 0
      ? db
          .select({ videoId: matchCandidate.videoId })
          .from(matchCandidate)
          .innerJoin(importRow, eq(importRow.id, matchCandidate.importRowId))
          .where(
            and(eq(importRow.matchStatus, "conflict"), inArray(matchCandidate.videoId, recordIds)),
          )
      : Promise.resolve([]),
  ]);

  const cellsByRecord = new Map<string, Record<string, MetricCellView>>();
  for (const m of metricRows) {
    const cells = cellsByRecord.get(m.publishRecordId) ?? {};
    cells[m.metricName] = {
      value: m.metricValue,
      sourceType: m.sourceType,
      isEstimated: m.isEstimated === 1,
      dataDate: m.dataDate,
    };
    cellsByRecord.set(m.publishRecordId, cells);
  }
  const conflictRecordIds = new Set(conflictRows.map((r) => r.videoId));
  const durationByContent = new Map(featureRows.map((f) => [f.contentId, f.duration]));
  const recordsByContent = new Map<string, (typeof recordRows)[number][]>();
  for (const r of recordRows) {
    const list = recordsByContent.get(r.contentId) ?? [];
    list.push(r);
    recordsByContent.set(r.contentId, list);
  }

  // items 顺序严格跟随分页排序结果（SQL 已排好，装载后不再重排）
  const contentById = new Map(contentRows.map((c) => [c.id, c]));
  const items = contentIds.flatMap((id) => {
    const c = contentById.get(id);
    if (!c) return [];
    return [
      buildContentVideoItem({
        contentId: c.id,
        title: c.title,
        template: c.template,
        level: c.level,
        localStatus: c.status,
        createdAt: c.createdAt,
        videoAssetId: videoAssetOf(c.video),
        durationSec: durationByContent.get(c.id) ?? null,
        platforms: (recordsByContent.get(c.id) ?? []).map((r) => ({
          recordId: r.recordId,
          platform: r.platform,
          platformVideoId: r.platformVideoId,
          publishStatus: r.publishStatus,
          publishTime: r.publishTime,
          publishTimeSource: r.publishTimeSource,
          metrics: cellsByRecord.get(r.recordId) ?? {},
          hasImportConflict: conflictRecordIds.has(r.recordId),
        })),
      }),
    ];
  });
  return { items, total, page: query.page, pageSize: query.pageSize };
}
