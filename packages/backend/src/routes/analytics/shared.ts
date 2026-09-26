// 数据分析路由共用件（批次 5C：analytics 按领域拆分的单一挂载实例 + 公共 schema，docs/17 §十一）
// 各领域模块（records/import/features/dashboard/insights）向本 `analyticsRoute` 注册路由；
// analytics.ts 仅负责按领域顺序 side-effect 导入并导出——对外路径与 operationId 逐字不变
import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { contentFeatures } from "../../db/schema";
import { METRIC_SOURCE_TYPES } from "../../lib/analytics-taxonomy";

/** 整个 /api/analytics 子路由共用的单一 OpenAPIHono 实例（拆分不改契约） */
export const analyticsRoute = new OpenAPIHono();

export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式须为 YYYY-MM-DD");

export const templateEnum = z.enum(["scene_word", "word_card", "quiz"]);
export const publishStatusEnum = z.enum(["scheduled", "published", "deleted"]);
export const levelEnum = z.enum(["CET4", "CET6"]);

export const contentIdParam = z.object({ contentId: z.string().min(1).max(32) });

export const recordItemSchema = z.object({
  id: z.string(),
  contentId: z.string(),
  contentTitle: z.string(),
  template: templateEnum,
  videoAssetId: z.string().nullable(),
  platform: z.string(),
  platformVideoId: z.string().nullable(),
  publishTitle: z.string().nullable(),
  publishTime: z.string().nullable(),
  coverUrl: z.string().nullable(),
  publishStatus: publishStatusEnum,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const metricViewSchema = z.object({
  metricName: z.string(),
  label: z.string(),
  unit: z.string(),
  availability: z.string(),
  metricValue: z.number(),
  sourceType: z.enum(METRIC_SOURCE_TYPES),
  sourceField: z.string().nullable(),
  dataDate: z.string().nullable(),
  isEstimated: z.boolean(),
  confidence: z.number().nullable(),
  fetchedAt: z.string(),
});

/** 带来源的指标单元格（canonical 名 → 值；缺键=无数据非 0） */
export const metricCellSchema = z.object({
  value: z.number(),
  sourceType: z.enum(METRIC_SOURCE_TYPES),
  isEstimated: z.boolean(),
  dataDate: z.string().nullable(),
});

export const featureSchema = z.object({
  contentId: z.string(),
  template: templateEnum,
  level: levelEnum,
  duration: z.number().nullable(),
  knowledgePointCount: z.number().nullable(),
  characterCount: z.number().nullable(),
  dialogueCount: z.number().nullable(),
  segmentCount: z.number().nullable(),
  speechRate: z.number().nullable(),
  voiceId: z.string().nullable(),
  bgm: z.string().nullable(),
  subtitleType: z.string().nullable(),
  shotCount: z.number().nullable(),
  introEffect: z.number().nullable(),
  introTopic: z.string().nullable(),
  promptVersion: z.string().nullable(),
  rendererVersion: z.string().nullable(),
  scene: z.string().nullable(),
  hook: z.string().nullable(),
  contentFormat: z.string().nullable(),
  emotion: z.string().nullable(),
  ctaType: z.string().nullable(),
  ctaStartTime: z.number().nullable(),
  fieldSources: z.record(z.string()).nullable(),
});

type FeatureRowView = typeof contentFeatures.$inferSelect;

export function toFeatureView(row: FeatureRowView): z.infer<typeof featureSchema> {
  return {
    contentId: row.contentId,
    template: row.template,
    level: row.level,
    duration: row.duration,
    knowledgePointCount: row.knowledgePointCount,
    characterCount: row.characterCount,
    dialogueCount: row.dialogueCount,
    segmentCount: row.segmentCount,
    speechRate: row.speechRate,
    voiceId: row.voiceId,
    bgm: row.bgm,
    subtitleType: row.subtitleType,
    shotCount: row.shotCount,
    introEffect: row.introEffect,
    introTopic: row.introTopic,
    promptVersion: row.promptVersion,
    rendererVersion: row.rendererVersion,
    scene: row.scene,
    hook: row.hook,
    contentFormat: row.contentFormat,
    emotion: row.emotion,
    ctaType: row.ctaType,
    ctaStartTime: row.ctaStartTime,
    fieldSources: (row.fieldSources as Record<string, string> | null) ?? null,
  };
}
