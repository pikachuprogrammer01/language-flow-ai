/**
 * 分析看板服务 — Phase 2（docs/17 §十 Phase 2；需求 §十一 页面 A/B、§十五 同类 Benchmark）
 *
 * 口径诚实性（需求 §二十二/§二十六）：
 * - 漏斗「2秒有效观看/5秒观看/完播」= Σ(播放量 × 对应比例)，仅对有齐备数据的记录求和；
 *   任一记录缺比例 → 该阶段 sourceTypes 仍标注实际参与来源，全组无数据 → value=null + emptyReason（无数据 ≠ 0）
 * - 逐级转化 stepRate 只在相邻两阶段「覆盖记录集完全一致且数值不倒挂」时给出（stepRateState="computed"）；
 *   否则置 null 并以状态枚举说明原因——绝不截断/伪造百分比掩盖口径错位（2026-09-26 审查批次 1）
 * - shareOfPlays 分母改为「本阶段覆盖记录的播放合计」（basisPlays），与分子覆盖一致，杜绝混合覆盖低估
 * - 「关注」阶段取 creator_metric_daily 同窗口日新增粉丝合计：账号级独立指标，不入视频观看漏斗链路
 *   （stepRate/shareOfPlays 恒 null，note 明示不宣称单视频归因）
 * - Benchmark 分组 = 当前账号 × 同模板 × 相似时长带 ×（若已标注）同场景/同内容形态；
 *   样本不足（<8 条）lowSample=true，前端必须同时展示样本数，禁止据此下结论
 */
import { type SQL, and, asc, count, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/mysql-core";
import { db } from "../db";
import {
  contentFeatures,
  contents,
  creatorMetricDaily,
  publishRecords,
  videoMetricDaily,
  videoMetrics,
} from "../db/schema";
import type { MetricSourceType } from "../lib/analytics-taxonomy";

// ── 纯数据结构 ──

export interface MetricCell {
  value: number;
  sourceType: MetricSourceType;
  isEstimated: boolean;
  dataDate: string | null;
}
type MetricCells = Record<string, MetricCell>;
export type DashboardMetricCells = MetricCells;

/** 逐级转化可比性状态：仅 computed 时 stepRate 非空；null 是「诚实不可比」不是错误 */
export type StepRateState =
  | "first" /** 首阶段，无上一级 */
  | "computed" /** 覆盖一致且不倒挂，转化可比 */
  | "coverage-mismatch" /** 与上一阶段折算的记录集不同 */
  | "inverted" /** 同覆盖但本阶段值 > 上一阶段（源数据口径倒挂） */
  | "missing" /** 任一侧无数据 */
  | "standalone"; /** 账号级独立指标，不入观看漏斗链路 */

export interface FunnelStage {
  key: string;
  label: string;
  kind: "count" | "rate" | "creator";
  value: number | null;
  previousValue: number | null;
  /** 相对上一阶段的转化：仅 stepRateState="computed" 时非空 */
  stepRate: number | null;
  stepRateState: StepRateState;
  /** 相对本阶段覆盖播放（basisPlays）的占比；播放阶段有值为 1；creator 阶段 null */
  shareOfPlays: number | null;
  /** video 阶段=参与折算的记录数；creator 阶段=窗口内参与折算的账号日行数 */
  coverageCount: number;
  /** 窗口内发布记录总数（覆盖率分母） */
  windowRecordCount: number;
  /** 本阶段覆盖记录的播放量合计（折算/占比分母）；creator 阶段 null */
  basisPlays: number | null;
  changePct: number | null;
  sourceTypes: string[];
  emptyReason: string | null;
  note?: string;
}

/** 阶段定义：value 口径（count=直接求和；rate=播放×比例求和；creator=账号日新增） */
const FUNNEL_STAGES = [
  { key: "plays", label: "播放", kind: "count", metric: "play_count" },
  { key: "effective_2s", label: "2秒有效观看", kind: "rate", rateMetric: "effective_play_rate_2s" },
  { key: "watch_5s", label: "5秒观看", kind: "rate", rateMetric: "watch_rate_5s" },
  { key: "completed", label: "完播", kind: "rate", rateMetric: "completion_rate" },
  { key: "profile_visits", label: "主页访问", kind: "count", metric: "profile_visit_count" },
  { key: "follows", label: "关注", kind: "creator" },
] as const;

interface RecordMetricInput {
  recordId: string;
  publishTime: Date | null;
  createdAt: Date;
  metrics: MetricCells;
}

/** 阶段折算结果：coverage=参与折算的记录集（覆盖一致性判据），basisPlays=覆盖记录播放合计 */
interface StageSum {
  value: number | null;
  sourceTypes: string[];
  emptyReason: string | null;
  coverage: string[];
  basisPlays: number | null;
}

function sumStage(inputs: RecordMetricInput[], stage: (typeof FUNNEL_STAGES)[number]): StageSum {
  const sources = new Set<string>();
  const coverage: string[] = [];
  let basis = 0;
  let total = 0;
  let has = false;
  for (const input of inputs) {
    if (stage.kind === "count") {
      const cell = input.metrics[stage.metric ?? ""];
      if (cell) {
        total += cell.value;
        has = true;
        sources.add(cell.sourceType);
        coverage.push(input.recordId);
        basis += input.metrics.play_count?.value ?? 0;
      }
      continue;
    }
    if (stage.kind === "rate") {
      const plays = input.metrics.play_count;
      const rate = input.metrics[stage.rateMetric ?? ""];
      if (plays && rate) {
        total += plays.value * rate.value;
        has = true;
        sources.add(plays.sourceType);
        sources.add(rate.sourceType);
        coverage.push(input.recordId);
        basis += plays.value;
      }
    }
  }
  if (!has) {
    return {
      value: null,
      sourceTypes: [],
      emptyReason: stage.kind === "count" ? "not_imported" : "missing_rate_or_plays",
      coverage: [],
      basisPlays: null,
    };
  }
  return {
    value: Math.round(total * 100) / 100,
    sourceTypes: [...sources],
    emptyReason: null,
    coverage: coverage.sort(),
    basisPlays: Math.round(basis * 100) / 100,
  };
}

/** 纯函数：组装增长漏斗（当前窗口 vs 上一等长窗口）；creator 阶段由调用方传账号合计 */
export function buildFunnelStages(
  current: RecordMetricInput[],
  previous: RecordMetricInput[],
  creatorFans: { current: number | null; previous: number | null; currentDays: number },
): FunnelStage[] {
  const sums = FUNNEL_STAGES.map((stage) => ({
    stage,
    cur:
      stage.kind === "creator"
        ? {
            value: creatorFans.current,
            sourceTypes: creatorFans.current === null ? [] : ["CREATOR_IMPORT"],
            emptyReason: creatorFans.current === null ? "not_imported" : null,
            coverage: [] as string[],
            basisPlays: null,
          }
        : sumStage(current, stage),
    prev: stage.kind === "creator" ? creatorFans.previous : sumStage(previous, stage).value,
  }));
  const windowRecordCount = current.length;
  const stages: FunnelStage[] = [];
  let prevChain: { value: number | null; coverage: string[] } | null = null;
  for (const { stage, cur, prev } of sums) {
    const changePct =
      cur.value === null || prev === null || prev === 0 ? null : (cur.value - prev) / prev;
    if (stage.kind === "creator") {
      // 账号级独立指标：不入观看漏斗链路，不给逐级转化/占比
      stages.push({
        key: stage.key,
        label: stage.label,
        kind: stage.kind,
        value: cur.value,
        previousValue: prev,
        stepRate: null,
        stepRateState: "standalone",
        shareOfPlays: null,
        coverageCount: creatorFans.currentDays,
        windowRecordCount,
        basisPlays: null,
        changePct,
        sourceTypes: cur.sourceTypes,
        emptyReason: cur.emptyReason,
        note: "账号级日新增粉丝合计（时间窗口相关性，不含单视频归因）",
      });
      continue;
    }
    let stepRateState: StepRateState;
    let stepRate: number | null;
    if (stages.length === 0) {
      stepRateState = "first";
      stepRate = null;
    } else if (cur.value === null || prevChain === null || prevChain.value === null) {
      stepRateState = "missing";
      stepRate = null;
    } else if (
      prevChain.coverage.length !== cur.coverage.length ||
      prevChain.coverage.some((id, i) => id !== cur.coverage[i])
    ) {
      stepRateState = "coverage-mismatch";
      stepRate = null;
    } else if (prevChain.value === 0) {
      stepRateState = "missing";
      stepRate = null;
    } else if (cur.value > prevChain.value + 1e-9) {
      // 同覆盖但数值倒挂：导入源口径不同（如完播率 > 5秒观看率），不硬算转化也不截断
      stepRateState = "inverted";
      stepRate = null;
    } else {
      stepRateState = "computed";
      stepRate = cur.value / prevChain.value;
    }
    stages.push({
      key: stage.key,
      label: stage.label,
      kind: stage.kind,
      value: cur.value,
      previousValue: prev,
      stepRate,
      stepRateState,
      shareOfPlays: shareOfBasis(cur.value, cur.basisPlays, stages.length === 0),
      coverageCount: cur.coverage.length,
      windowRecordCount,
      basisPlays: cur.basisPlays,
      changePct,
      sourceTypes: cur.sourceTypes,
      emptyReason: cur.emptyReason,
    });
    prevChain = { value: cur.value, coverage: cur.coverage };
  }
  return stages;
}

/** 占比 = 阶段值 / 本阶段覆盖记录播放合计（与分子同覆盖，不失真）；首阶段有值为 1 */
function shareOfBasis(
  value: number | null,
  basisPlays: number | null,
  isFirst: boolean,
): number | null {
  if (value === null) return null;
  if (isFirst) return 1;
  if (basisPlays === null || basisPlays === 0) return null;
  return value / basisPlays;
}

// ── 同类分组（需求 §十五：禁止写死行业阈值，以账号自身同类为 Benchmark） ──

/** 时长带（秒）：平台自定义分档，仅用于同类比较分组，非行业基准 */
export function durationBandOf(sec: number | null): string | null {
  if (sec === null || !Number.isFinite(sec)) return null;
  if (sec < 15) return "lt_15";
  if (sec < 30) return "15_30";
  if (sec < 60) return "30_60";
  if (sec < 120) return "60_120";
  return "gte_120";
}

export function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

export function meanOf(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export interface BenchmarkSubject {
  contentId: string;
  template: string;
  scene: string | null;
  contentFormat: string | null;
  durationBand: string | null;
}

/** 同组判定：同模板；时长带存在则要求一致；场景/内容形态已标注时要求一致（未标注不参与过滤） */
export function isSameGroup(subject: BenchmarkSubject, other: BenchmarkSubject): boolean {
  if (other.template !== subject.template) return false;
  if (subject.durationBand && other.durationBand && subject.durationBand !== other.durationBand) {
    return false;
  }
  if (subject.scene && other.scene && subject.scene !== other.scene) return false;
  if (
    subject.contentFormat &&
    other.contentFormat &&
    subject.contentFormat !== other.contentFormat
  ) {
    return false;
  }
  return true;
}

/** Benchmark 指标集（与展示页一致；均取最新值） */
export const BENCHMARK_METRICS = [
  "play_count",
  "effective_play_rate_2s",
  "watch_rate_5s",
  "completion_rate",
  "avg_watch_ratio",
  "like_rate",
  "engagement_rate",
] as const;

export interface BenchmarkEntry {
  self: MetricCell | null;
  groupMedian: number | null;
  groupMean: number | null;
  /** 与组中位数差（比例类按百分点差，即 diff×100 由前端呈现） */
  diff: number | null;
  sampleCount: number;
}

// ── 数据装载（io）──
// 审查批次 5A：看板的三条大流量查询不再每次全表进内存——
// · /overview 只装载「上一窗口起点 → 现在」coalesce 区间内的发布记录及其指标
// · /videos 排序/分页/总数全部下推 SQL（指标缺失恒排末由 IS NULL 前置位实现）
// loadAllVideoRows 保留给确实需要全量分组集的趋势/benchmark/因子路径（§十五 同组比较天然跨窗口）

export interface VideoRowData {
  recordId: string;
  contentId: string;
  platform: string;
  platformVideoId: string | null;
  title: string;
  template: string;
  level: string;
  scene: string | null;
  contentFormat: string | null;
  hook: string | null;
  emotion: string | null;
  ctaType: string | null;
  voiceId: string | null;
  bgm: string | null;
  subtitleType: string | null;
  promptVersion: string | null;
  segmentCount: number | null;
  speechRate: number | null;
  durationSec: number | null;
  publishTime: Date | null;
  createdAt: Date;
  cells: MetricCells;
}

/** 行集合基础列（发布记录×内容×特征；指标另批装载，避免笛卡尔积行膨胀） */
const VIDEO_ROW_FIELDS = {
  recordId: publishRecords.id,
  contentId: publishRecords.contentId,
  platform: publishRecords.platform,
  platformVideoId: publishRecords.platformVideoId,
  publishTime: publishRecords.publishTime,
  createdAt: publishRecords.createdAt,
  title: contents.title,
  template: contents.template,
  level: contents.level,
  featureDuration: contentFeatures.duration,
  scene: contentFeatures.scene,
  contentFormat: contentFeatures.contentFormat,
  hook: contentFeatures.hook,
  emotion: contentFeatures.emotion,
  ctaType: contentFeatures.ctaType,
  voiceId: contentFeatures.voiceId,
  bgm: contentFeatures.bgm,
  subtitleType: contentFeatures.subtitleType,
  promptVersion: contentFeatures.promptVersion,
  segmentCount: contentFeatures.segmentCount,
  speechRate: contentFeatures.speechRate,
};

function toVideoRow(
  r: {
    recordId: string;
    contentId: string;
    platform: string;
    platformVideoId: string | null;
    publishTime: Date | null;
    createdAt: Date;
    title: string;
    template: string;
    level: string;
    featureDuration: number | null;
    scene: string | null;
    contentFormat: string | null;
    hook: string | null;
    emotion: string | null;
    ctaType: string | null;
    voiceId: string | null;
    bgm: string | null;
    subtitleType: string | null;
    promptVersion: string | null;
    segmentCount: number | null;
    speechRate: number | null;
  },
  cells: MetricCells,
): VideoRowData {
  return {
    recordId: r.recordId,
    contentId: r.contentId,
    platform: r.platform,
    platformVideoId: r.platformVideoId,
    title: r.title,
    template: r.template,
    level: r.level,
    scene: r.scene ?? null,
    contentFormat: r.contentFormat ?? null,
    hook: r.hook ?? null,
    emotion: r.emotion ?? null,
    ctaType: r.ctaType ?? null,
    voiceId: r.voiceId ?? null,
    bgm: r.bgm ?? null,
    subtitleType: r.subtitleType ?? null,
    promptVersion: r.promptVersion ?? null,
    segmentCount: r.segmentCount ?? null,
    speechRate: r.speechRate ?? null,
    durationSec: r.featureDuration,
    publishTime: r.publishTime,
    createdAt: r.createdAt,
    cells,
  };
}

async function loadCellsByRecordIds(recordIds: string[]): Promise<Map<string, MetricCells>> {
  const byRecord = new Map<string, MetricCells>();
  if (recordIds.length === 0) return byRecord;
  const metricRows = await db
    .select()
    .from(videoMetrics)
    .where(inArray(videoMetrics.publishRecordId, recordIds));
  for (const m of metricRows) {
    const cells = byRecord.get(m.publishRecordId) ?? {};
    cells[m.metricName] = {
      value: m.metricValue,
      sourceType: m.sourceType,
      isEstimated: m.isEstimated === 1,
      dataDate: m.dataDate,
    };
    byRecord.set(m.publishRecordId, cells);
  }
  return byRecord;
}

/** 按条件装载行集（无条件=全量，仅趋势/benchmark/因子这类确实需要全分组集的路径使用） */
async function loadVideoRowsBy(whereCond?: SQL): Promise<VideoRowData[]> {
  const base = db
    .select(VIDEO_ROW_FIELDS)
    .from(publishRecords)
    .innerJoin(contents, eq(contents.id, publishRecords.contentId))
    .leftJoin(contentFeatures, eq(contentFeatures.contentId, publishRecords.contentId));
  const rows = whereCond ? await base.where(whereCond) : await base;
  const cells = await loadCellsByRecordIds(rows.map((r) => r.recordId));
  return rows.map((r) => toVideoRow(r, cells.get(r.recordId) ?? {}));
}

/** 全量发布记录×特征×指标装载（仅供确实需要跨窗口全分组集的 benchmark/因子路径） */
export async function loadAllVideoRows(): Promise<VideoRowData[]> {
  return loadVideoRowsBy();
}

/** UTC 字面量（与 datetime(mode:date) 存储/回读同一基准，免会话时区漂移） */
function toSqlDateTime(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

const publishedAtSql = sql`coalesce(${publishRecords.publishTime}, ${publishRecords.createdAt})`;

/** 窗口内发布记录装载（批次 5A）：coalesce(publish_time, created_at) 区间过滤下推 SQL，不再全表进内存 */
async function loadVideoRowsInWindow(from: Date, to: Date): Promise<VideoRowData[]> {
  return loadVideoRowsBy(
    sql`${publishedAtSql} >= ${toSqlDateTime(from)} AND ${publishedAtSql} < ${toSqlDateTime(to)}`,
  );
}

/** 账号窗口内日新增粉丝合计与参与天数（fans null=窗口内无任何导入行，区别于 0） */
async function sumCreatorNewFans(
  from: Date,
  to: Date,
): Promise<{ fans: number | null; days: number }> {
  const fromStr = toDateString(from);
  const toStr = toDateString(to);
  const rows = await db
    .select({
      n: sql<number>`coalesce(sum(${creatorMetricDaily.newFans}), 0)`,
      any: sql<number>`count(*)`,
    })
    .from(creatorMetricDaily)
    .where(
      and(
        gte(creatorMetricDaily.statDate, fromStr),
        lt(creatorMetricDaily.statDate, toStr),
        sql`${creatorMetricDaily.newFans} is not null`,
      ),
    );
  const row = rows[0];
  if (!row || Number(row.any) === 0) return { fans: null, days: 0 };
  return { fans: Number(row.n), days: Number(row.any) };
}

function toDateString(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// ── 用例编排 ──

export interface OverviewResult {
  days: number;
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
  publishedVideos: number;
  previousPublishedVideos: number;
  stages: FunnelStage[];
  emptyReason: string | null;
}

export async function getAnalyticsOverview(days: number): Promise<OverviewResult> {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const previousFrom = new Date(from.getTime() - days * 86_400_000);
  // 批次 5A：只装载 [previousFrom, to) 窗口区间记录（SQL 下推），不再全表进内存；
  // 当前/上一期切分仍用 JS Date 同一判据（coalesce(publishTime, createdAt)），与旧路径语义一致
  const windowed = await loadVideoRowsInWindow(previousFrom, to);
  const atMs = (r: VideoRowData): number => (r.publishTime ?? r.createdAt).getTime();
  const windowRows = windowed.filter((r) => atMs(r) >= from.getTime() && atMs(r) < to.getTime());
  const prevRows = windowed.filter((r) => atMs(r) < from.getTime());
  const map = (r: VideoRowData): RecordMetricInput => ({
    recordId: r.recordId,
    publishTime: r.publishTime,
    createdAt: r.createdAt,
    metrics: r.cells,
  });
  const fansCur = await sumCreatorNewFans(from, to);
  const fansPrev = await sumCreatorNewFans(previousFrom, from);
  const creatorFans = {
    current: fansCur.fans,
    previous: fansPrev.fans,
    currentDays: fansCur.days,
  };
  const stages = buildFunnelStages(windowRows.map(map), prevRows.map(map), creatorFans);
  const hasAnyStage = stages.some((s) => s.value !== null);
  return {
    days,
    from: toDateString(from),
    to: toDateString(to),
    previousFrom: toDateString(previousFrom),
    previousTo: toDateString(from),
    publishedVideos: windowRows.length,
    previousPublishedVideos: prevRows.length,
    stages,
    emptyReason:
      windowRows.length === 0 && creatorFans.current === null
        ? "no_records"
        : hasAnyStage
          ? null
          : "no_metrics",
  };
}

/** 排序白名单 → 取对应 canonical 指标值（缺数据排最后） */
const SORT_METRIC: Record<string, string> = {
  play: "play_count",
  completion: "completion_rate",
  engagement: "engagement_rate",
  fans: "new_fan_count",
};

export interface VideoListSort {
  sort: "play" | "completion" | "engagement" | "fans" | "publish_time";
  order: "asc" | "desc";
}

export async function listAnalyticsVideos(
  sort: VideoListSort,
  page: number,
  pageSize: number,
): Promise<{
  items: {
    recordId: string;
    contentId: string;
    platform: string;
    platformVideoId: string | null;
    title: string;
    template: string;
    level: string;
    durationSec: number | null;
    publishTime: string | null;
    metrics: MetricCells;
  }[];
  total: number;
  page: number;
  pageSize: number;
}> {
  // 批次 5A：排序/分页/总数全部下推 SQL；「缺数据恒排末」由 `IS NULL` 前置位实现，
  // 同值/同缺失尾部按 createdAt desc 决胜（与旧内存路径装载序一致）
  const totalRows = await db.select({ n: count() }).from(publishRecords);
  const total = Number(totalRows[0]?.n ?? 0);
  let recordIds: { recordId: string }[];
  if (sort.sort === "publish_time") {
    const dir = sort.order === "asc" ? asc(publishedAtSql) : desc(publishedAtSql);
    recordIds = await db
      .select({ recordId: publishRecords.id })
      .from(publishRecords)
      .orderBy(dir, desc(publishRecords.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
  } else {
    const m = alias(videoMetrics, "sort_metric");
    const metric = SORT_METRIC[sort.sort] ?? "play_count";
    const dir = sort.order === "asc" ? asc(m.metricValue) : desc(m.metricValue);
    recordIds = await db
      .select({ recordId: publishRecords.id })
      .from(publishRecords)
      .leftJoin(m, and(eq(m.publishRecordId, publishRecords.id), eq(m.metricName, metric)))
      .orderBy(sql`${m.metricValue} is null`, dir, desc(publishRecords.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
  }
  const ids = recordIds.map((r) => r.recordId);
  const loaded = await loadVideoRowsBy(
    ids.length > 0 ? inArray(publishRecords.id, ids) : undefined,
  );
  const byId = new Map(loaded.map((r) => [r.recordId, r]));
  const items = ids.flatMap((id) => {
    const r = byId.get(id);
    if (!r) return [];
    return [
      {
        recordId: r.recordId,
        contentId: r.contentId,
        platform: r.platform,
        platformVideoId: r.platformVideoId,
        title: r.title,
        template: r.template,
        level: r.level,
        durationSec: r.durationSec,
        publishTime: r.publishTime ? r.publishTime.toISOString() : null,
        metrics: r.cells,
      },
    ];
  });
  return { items, total, page, pageSize };
}

export interface BenchmarkResult {
  subject: { contentId: string; group: Omit<BenchmarkSubject, "contentId"> };
  sampleCount: number;
  lowSample: boolean;
  metrics: Record<string, BenchmarkEntry>;
  emptyReason: string | null;
}

/** 同组 Benchmark：中位数/均值 + 与自身差（需求 §十五 + §十四 早期以分组统计为主） */
export async function getBenchmark(contentId: string): Promise<BenchmarkResult> {
  const rows = await loadAllVideoRows();
  const target = rows.find((r) => r.contentId === contentId);
  if (!target) {
    return {
      subject: {
        contentId,
        group: { template: "", scene: null, contentFormat: null, durationBand: null },
      },
      sampleCount: 0,
      lowSample: true,
      metrics: {},
      emptyReason: "no_publish_record",
    };
  }
  const subject: BenchmarkSubject = {
    contentId: target.contentId,
    template: target.template,
    scene: target.scene,
    contentFormat: target.contentFormat,
    durationBand: durationBandOf(target.durationSec),
  };
  const peers = rows.filter((r) =>
    isSameGroup(subject, {
      contentId: r.contentId,
      template: r.template,
      scene: r.scene,
      contentFormat: r.contentFormat,
      durationBand: durationBandOf(r.durationSec),
    }),
  );
  const metrics: Record<string, BenchmarkEntry> = {};
  for (const name of BENCHMARK_METRICS) {
    const groupValues = peers
      .map((p) => p.cells[name]?.value)
      .filter((v): v is number => v !== undefined);
    const self = target.cells[name] ?? null;
    const med = medianOf(groupValues);
    metrics[name] = {
      self,
      groupMedian: med,
      groupMean: meanOf(groupValues),
      diff: self && med !== null ? self.value - med : null,
      sampleCount: groupValues.length,
    };
  }
  return {
    subject: {
      contentId,
      group: {
        template: subject.template,
        scene: subject.scene,
        contentFormat: subject.contentFormat,
        durationBand: subject.durationBand,
      },
    },
    sampleCount: peers.length,
    lowSample: peers.length < 8,
    metrics,
    emptyReason: peers.length === 0 ? "no_group_data" : null,
  };
}

// ── 页面 C 趋势线：D0~D30 每日快照（不补 0，缺日不画点；无秒级留存不造假曲线） ──

export interface TrendPoint {
  date: string;
  value: number;
  sourceType: MetricSourceType;
}
export interface TrendSeries {
  metricName: string;
  points: TrendPoint[];
}
export interface TrendRecord {
  recordId: string;
  platform: string;
  series: TrendSeries[];
}

export async function getDailyTrend(
  contentId: string,
  query: { dateFrom?: string; dateTo?: string } = {},
): Promise<TrendRecord[]> {
  const records = await db
    .select({ id: publishRecords.id, platform: publishRecords.platform })
    .from(publishRecords)
    .where(eq(publishRecords.contentId, contentId))
    .limit(20);
  if (records.length === 0) return [];
  const conditions = [
    inArray(
      videoMetricDaily.publishRecordId,
      records.map((r) => r.id),
    ),
  ];
  if (query.dateFrom) conditions.push(gte(videoMetricDaily.dataDate, query.dateFrom));
  if (query.dateTo) conditions.push(lte(videoMetricDaily.dataDate, query.dateTo));
  const rows = await db
    .select()
    .from(videoMetricDaily)
    .where(and(...conditions))
    .orderBy(videoMetricDaily.dataDate);
  const byRecord = new Map<string, Map<string, TrendPoint[]>>();
  for (const r of rows) {
    const seriesMap = byRecord.get(r.publishRecordId) ?? new Map<string, TrendPoint[]>();
    const points = seriesMap.get(r.metricName) ?? [];
    points.push({ date: String(r.dataDate), value: r.metricValue, sourceType: r.sourceType });
    seriesMap.set(r.metricName, points);
    byRecord.set(r.publishRecordId, seriesMap);
  }
  return records.map((record) => ({
    recordId: record.id,
    platform: record.platform,
    series: [...(byRecord.get(record.id) ?? new Map()).entries()].map(([metricName, points]) => ({
      metricName,
      points,
    })),
  }));
}
