/**
 * 工作台聚合服务 — GET /api/dashboard/summary 数据源
 * 一次请求返回指标/流水线/失败原因/最近任务，替代前端拉全量列表自算
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { contents, uploadMarks } from "../db/schema";

export interface DashboardSummary {
  today: number;
  yesterday: number;
  pendingRender: number;
  ttsActive: number;
  completedVideos: number;
  /** 已完成成片中占比最高的模板（无成片为 null） */
  topTemplate: { name: string; share: number } | null;
  failed: number;
  /** 聚合后的失败原因（如「片头生成失败 ×2」「词库校验失败 ×1」） */
  failureReasons: string[];
  pipeline: {
    generating: number;
    validating: number;
    tts: number;
    rendering: number;
    publishable: number;
  };
  recent: {
    id: string;
    title: string;
    template: string;
    level: string;
    status: string;
    intro: string;
    updatedAt: string;
  }[];
}

/** 按 status 分组计数 */
async function loadStatusCounts(): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: contents.status, n: sql<number>`count(*)` })
    .from(contents)
    .groupBy(contents.status);
  const map: Record<string, number> = {};
  for (const r of rows) map[r.status] = Number(r.n);
  return map;
}

/** 今日/昨日生成数（单查询按日期分组，昨日 = 今天-1 天） */
async function loadDayCounts(): Promise<{ today: number; yesterday: number }> {
  const rows = await db
    .select({
      day: sql<string>`date(${contents.createdAt})`,
      n: sql<number>`count(*)`,
    })
    .from(contents)
    .where(sql`${contents.createdAt} >= (curdate() - interval 1 day)`)
    .groupBy(sql`date(${contents.createdAt})`);
  const todayStr = new Date().toISOString().slice(0, 10);
  const y = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const find = (day: string) => Number(rows.find((r) => String(r.day) === day)?.n ?? 0);
  return { today: find(todayStr), yesterday: find(y) };
}

/** video JSON → introStatus（结构收窄，无值回 unknown/空） */
function introOf(video: unknown): string {
  if (video && typeof video === "object" && "introStatus" in video) {
    const value = (video as { introStatus?: unknown }).introStatus;
    if (typeof value === "string") return value;
  }
  return "";
}

interface CompletedRow {
  id: string;
  template: string;
  video: unknown;
}

/** 已完成且有成片的记录（可发布判定与模板占比共用） */
async function loadCompletedWithVideo(): Promise<CompletedRow[]> {
  return db
    .select({ id: contents.id, template: contents.template, video: contents.video })
    .from(contents)
    .where(and(eq(contents.status, "completed"), sql`${contents.video} is not null`));
}

/** 可发布 = 成片且无任何上传标记（按任务 id 关联） */
async function countPublishable(): Promise<number> {
  const rows = await db
    .select({ id: contents.id })
    .from(contents)
    .leftJoin(uploadMarks, eq(uploadMarks.taskId, contents.id))
    .where(and(eq(contents.status, "completed"), sql`${contents.video} is not null`))
    .groupBy(contents.id)
    .having(sql`count(${uploadMarks.id}) = 0`);
  return rows.length;
}

interface FailedRow {
  id: string;
  video: unknown;
  audit: unknown;
}

/** 最近失败记录（失败原因聚合用，最多 20 条） */
async function loadFailedRows(): Promise<FailedRow[]> {
  return db
    .select({ id: contents.id, video: contents.video, audit: contents.audit })
    .from(contents)
    .where(eq(contents.status, "failed"))
    .orderBy(desc(contents.updatedAt))
    .limit(20);
}

/** 单条失败记录 → 原因标签：片头失败 > 审计最后一次拒绝原因 > 未留痕 */
export function failureReasonOf(row: FailedRow): string {
  if (introOf(row.video) === "failed") return "片头生成失败";
  const attempts = (row.audit as { process?: { attempts?: { reason?: string }[] } } | null)?.process
    ?.attempts;
  const last = Array.isArray(attempts) ? attempts[attempts.length - 1] : undefined;
  return last?.reason?.trim() || "未记录原因";
}

/** 原因列表 → 「原因 ×n」聚合（保持首次出现顺序） */
export function aggregateReasons(reasons: string[]): string[] {
  const counts = new Map<string, number>();
  for (const r of reasons) counts.set(r, (counts.get(r) ?? 0) + 1);
  return [...counts.entries()].map(([reason, n]) => (n > 1 ? `${reason} ×${n}` : reason));
}

/** 最近 5 条任务（列表页缩略） */
async function loadRecent(): Promise<DashboardSummary["recent"]> {
  const rows = await db
    .select({
      id: contents.id,
      title: contents.title,
      template: contents.template,
      level: contents.level,
      status: contents.status,
      video: contents.video,
      updatedAt: contents.updatedAt,
    })
    .from(contents)
    .orderBy(desc(contents.createdAt))
    .limit(5);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    template: r.template,
    level: r.level,
    status: r.status,
    intro: introOf(r.video) || "—",
    updatedAt: r.updatedAt instanceof Date ? r.updatedAt.toISOString() : String(r.updatedAt),
  }));
}

/** 成片模板占比 top1 */
function topTemplateOf(completed: CompletedRow[]): DashboardSummary["topTemplate"] {
  if (completed.length === 0) return null;
  const counts = new Map<string, number>();
  for (const c of completed) counts.set(c.template, (counts.get(c.template) ?? 0) + 1);
  const [name, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return { name, share: Math.round((n / completed.length) * 100) };
}

/** 组装工作台聚合（各子查询并行） */
export async function getDashboardSummary(): Promise<DashboardSummary> {
  const [statusCounts, days, completed, publishable, failedRows, recent] = await Promise.all([
    loadStatusCounts(),
    loadDayCounts(),
    loadCompletedWithVideo(),
    countPublishable(),
    loadFailedRows(),
    loadRecent(),
  ]);
  const failedReasons = aggregateReasons(failedRows.map(failureReasonOf));
  return {
    today: days.today,
    yesterday: days.yesterday,
    pendingRender: (statusCounts.content_ready ?? 0) + (statusCounts.audio_ready ?? 0),
    ttsActive: statusCounts.tts_processing ?? 0,
    completedVideos: completed.length,
    topTemplate: topTemplateOf(completed),
    failed: statusCounts.failed ?? 0,
    failureReasons: failedReasons.length > 0 ? failedReasons : ["进入生成记录查看失败详情"],
    pipeline: {
      generating: statusCounts.ai_generating ?? 0,
      validating: statusCounts.content_ready ?? 0,
      tts: statusCounts.tts_processing ?? 0,
      rendering: statusCounts.video_rendering ?? 0,
      publishable,
    },
    recent,
  };
}
