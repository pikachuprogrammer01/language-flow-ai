/**
 * 内容特征服务 — Production Feature 落库（需求 §五A：生产数据优先，禁止 AI 二次猜测已知事实）
 *
 * 提取口径：
 * - duration / knowledgePointCount / segmentCount / speechRate / voiceId / bgm /
 *   introEffect / introTopic / shotCount / template / level → 直接取自 ContentDTO 与产物事实
 * - promptVersion / rendererVersion → 当前 audit 未留痕，保持 null（不猜测）
 * - scene / hook / contentFormat / emotion / ctaType / ctaStartTime → 生产阶段未建模，
 *   仅接受 USER_INPUT（PATCH 覆盖），重新同步时保留不覆盖
 */
import { eq } from "drizzle-orm";
import { db } from "../db";
import { contentFeatures, contents } from "../db/schema";
import {
  FEATURE_TAXONOMY_BY_FIELD,
  MANUAL_FEATURE_FIELDS,
  type MetricSourceType,
} from "../lib/analytics-taxonomy";

type Db = typeof db;
type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type ContentRow = typeof contents.$inferSelect;
type FeatureRow = typeof contentFeatures.$inferSelect;
type FeatureInsert = typeof contentFeatures.$inferInsert;

/** 生产可直取字段（PLATFORM_PRODUCTION）；与提取函数返回结构同源 */
const PRODUCTION_FEATURE_FIELDS = [
  "template",
  "level",
  "duration",
  "knowledgePointCount",
  "segmentCount",
  "dialogueCount",
  "speechRate",
  "voiceId",
  "bgm",
  "subtitleType",
  "shotCount",
  "introEffect",
  "introTopic",
  "promptVersion",
  "rendererVersion",
] as const;

type ProductionField = (typeof PRODUCTION_FEATURE_FIELDS)[number];
export type ProductionFeatureValues = Pick<
  FeatureInsert,
  (typeof PRODUCTION_FEATURE_FIELDS)[number]
>;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function arrayLength(value: unknown): number | null {
  return Array.isArray(value) ? value.length : null;
}

function numberOr(value: unknown, fallback: number | null): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 纯函数：从 contents 行提取生产特征（无副作用，可单测） */
export function extractProductionFeature(row: ContentRow): ProductionFeatureValues {
  const style = asRecord(row.style);
  const voice = asRecord(row.voice);
  const video = asRecord(row.video);
  const audio = asRecord(row.audio);
  const contentLength = arrayLength(row.content);
  const words = Array.isArray(row.words) ? row.words : [];
  const distinctWords = new Set(
    words.map((w) => String(asRecord(w).word ?? "").toLowerCase()).filter(Boolean),
  );
  const duration = numberOr(video.duration, null) ?? numberOr(audio.duration, null);
  const introStatus = typeof video.introStatus === "string" ? video.introStatus : null;
  const introEffect =
    row.template === "scene_word"
      ? introStatus === "rendered"
        ? 1
        : introStatus === "disabled" || introStatus === "failed"
          ? 0
          : style.introEffect === false
            ? 0
            : null
      : null;
  // 镜头数 = 渲染器事实：scene_word 片头（若渲染）+ 每段 1 镜头；word_card 每卡 1 镜头；quiz 每题 1 镜头
  const shotCount =
    contentLength === null ? null : contentLength + (introStatus === "rendered" ? 1 : 0);
  return {
    template: row.template,
    level: row.level,
    duration,
    knowledgePointCount: distinctWords.size,
    segmentCount: contentLength,
    // 对白/段落数仅 scene_word 具备"段即台词块"语义；其余模板不猜测
    dialogueCount: row.template === "scene_word" ? contentLength : null,
    speechRate: numberOr(voice.speed, 1),
    voiceId: typeof voice.id === "string" ? voice.id : null,
    bgm: typeof style.bgm === "string" ? style.bgm : null,
    // 渲染器事实：三模板均为烧录字幕（docs/10 视频渲染设计）
    subtitleType: "burned_in",
    shotCount,
    introEffect,
    introTopic: typeof style.introTopic === "string" ? style.introTopic : null,
    promptVersion: null,
    rendererVersion: null,
  };
}

const PRODUCTION_FIELDS: readonly string[] =
  PRODUCTION_FEATURE_FIELDS satisfies readonly ProductionField[];

type FieldSources = Partial<Record<string, MetricSourceType>>;

/** 合并：生产字段总是重算；人工字段（USER_INPUT/AI_EXTRACTED）保留不被覆盖 */
export function mergeFeatureRow(
  existing: FeatureRow | undefined,
  contentId: string,
  production: ProductionFeatureValues,
): FeatureInsert {
  const previousSources: FieldSources = asRecord(existing?.fieldSources) as FieldSources;
  const values: FeatureInsert = { contentId, ...production };
  const fieldSources: FieldSources = {};
  for (const field of PRODUCTION_FIELDS) fieldSources[field] = "PLATFORM_PRODUCTION";
  for (const field of MANUAL_FEATURE_FIELDS) {
    const source = previousSources[field];
    const kept = existing ? (existing[field as keyof FeatureRow] as string | number | null) : null;
    if (source && source !== "PLATFORM_PRODUCTION" && kept !== null && kept !== undefined) {
      Object.assign(values, { [field]: kept });
      fieldSources[field] = source;
    }
  }
  values.fieldSources = fieldSources;
  return values;
}

/** 只读加载特征行（docs/16：GET 只读；重算仅限创建发布记录时与 POST sync 端点） */
export async function loadContentFeature(
  contentId: string,
  executor: Executor = db,
): Promise<FeatureRow | null> {
  const rows = await executor
    .select()
    .from(contentFeatures)
    .where(eq(contentFeatures.contentId, contentId))
    .limit(1);
  return rows[0] ?? null;
}

/** 重算并 upsert 单条内容的生产特征（发布记录创建/手动同步入口） */
export async function syncContentFeature(
  contentId: string,
  executor: Executor = db,
): Promise<FeatureRow | null> {
  const [content] = await executor
    .select()
    .from(contents)
    .where(eq(contents.id, contentId))
    .limit(1);
  if (!content) return null;
  const existingList = await executor
    .select()
    .from(contentFeatures)
    .where(eq(contentFeatures.contentId, contentId))
    .limit(1);
  const existing = existingList[0];
  const values = mergeFeatureRow(existing, contentId, extractProductionFeature(content));
  await executor
    .insert(contentFeatures)
    .values(values)
    .onDuplicateKeyUpdate({ set: { ...values, updatedAt: new Date() } });
  const rows = await executor
    .select()
    .from(contentFeatures)
    .where(eq(contentFeatures.contentId, contentId))
    .limit(1);
  return rows[0] ?? null;
}

export type ManualFeaturePatch = Partial<{
  scene: string | null;
  hook: string | null;
  contentFormat: string | null;
  emotion: string | null;
  ctaType: string | null;
  ctaStartTime: number | null;
}>;

/** taxonomy 白名单校验（USER_INPUT 入口同样不得写脏值）；返回校验失败字段 */
export function validateManualPatch(patch: ManualFeaturePatch): string[] {
  const errors: string[] = [];
  for (const [field, value] of Object.entries(patch)) {
    if (value === null || value === undefined) continue;
    const allowed = FEATURE_TAXONOMY_BY_FIELD[field as keyof typeof FEATURE_TAXONOMY_BY_FIELD];
    if (allowed && typeof value === "string" && !allowed.includes(value)) {
      errors.push(`${field} 不在标签体系内（可选：${allowed.join(", ")}）`);
    }
    if (field === "ctaStartTime" && typeof value === "number" && value < 0) {
      errors.push("ctaStartTime 不能为负");
    }
  }
  return errors;
}

/** 人工覆盖标签字段并标记来源 USER_INPUT（生产字段不受影响） */
export async function patchManualFeature(
  contentId: string,
  patch: ManualFeaturePatch,
): Promise<FeatureRow | null> {
  await syncContentFeature(contentId);
  const rows = await db
    .select()
    .from(contentFeatures)
    .where(eq(contentFeatures.contentId, contentId))
    .limit(1);
  const existing = rows[0];
  if (!existing) return null;
  const fieldSources = { ...asRecord(existing.fieldSources) } as FieldSources;
  const next: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    next[field] = value;
    fieldSources[field] = value === null ? "PLATFORM_PRODUCTION" : "USER_INPUT";
  }
  await db
    .update(contentFeatures)
    .set({ ...next, fieldSources, updatedAt: new Date() })
    .where(eq(contentFeatures.contentId, contentId));
  const updated = await db
    .select()
    .from(contentFeatures)
    .where(eq(contentFeatures.contentId, contentId))
    .limit(1);
  return updated[0] ?? null;
}
