import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { contents, videoAnalytics } from "../db/schema";
import { API_TAGS } from "../lib/api-convention";
import { apiError, internalError } from "../lib/api-error";
import { logger } from "../lib/logger";
import { allVoiceIds, isBgmAllowed, isVoiceAllowed } from "../lib/tts-catalog";

const idSchema = z.object({ contentId: z.string().min(1).max(32) });
const batchQuerySchema = z.object({ ids: z.string().min(1).max(4000) });

export const customParamSchema = z.object({
  key: z.string().min(1).max(100),
  label: z.string().min(1).max(255),
  type: z.enum(["text", "image"]),
  value: z.string().max(2000),
});

const bodySchema = z.object({
  storyTopic: z.string().max(255).nullable().optional(),
  publishAt: z.string().datetime().nullable().optional(),
  coverUrl: z.string().max(500).nullable().optional(),
  allowSave: z.boolean().optional(),
  voice: z.string().min(1).max(100).optional(),
  bgm: z.string().max(500).nullable().optional(),
  customParams: z.array(customParamSchema).max(50).nullable().optional(),
});

const responseSchema = z.object({
  contentId: z.string(),
  template: z.enum(["scene_word", "word_card", "quiz"]),
  targetDuration: z.number(),
  duration: z.number().nullable(),
  storyTopic: z.string().nullable(),
  voice: z.string().nullable(),
  bgm: z.string().nullable(),
  publishAt: z.string().nullable(),
  coverUrl: z.string().nullable(),
  allowSave: z.boolean(),
  customParams: z.array(customParamSchema),
});

export type VideoAnalyticsResponse = z.infer<typeof responseSchema>;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * 发布主题只回传用户的显式覆盖值：空/NULL 语义是「跟随生成标题」，由展示层回落 contents.title。
 * 服务端不得在这里混入回落值——前端保存会把回显内容原样写回，一旦混入就把「跟随」固化成了永久覆盖。
 */
export function resolveStoryTopicOverride(
  analytics: Pick<typeof videoAnalytics.$inferSelect, "storyTopic"> | undefined,
): string | null {
  return asString(analytics?.storyTopic);
}

function getDuration(content: typeof contents.$inferSelect): number | null {
  const video = asRecord(content.video);
  const audio = asRecord(content.audio);
  const duration = video.duration ?? audio.duration;
  return typeof duration === "number" ? duration : null;
}

function getCustomParams(value: unknown): z.infer<typeof customParamSchema>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is z.infer<typeof customParamSchema> => customParamSchema.safeParse(item).success,
  );
}

function parseBatchIds(value: string): string[] | null {
  const ids = [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
  if (ids.length === 0 || ids.length > 100 || ids.some((id) => id.length > 32)) return null;
  return ids;
}

function buildResponse(
  content: typeof contents.$inferSelect,
  analytics: typeof videoAnalytics.$inferSelect | undefined,
): VideoAnalyticsResponse {
  const style = asRecord(content.style);
  const voice = asRecord(content.voice);
  return {
    contentId: content.id,
    template: content.template,
    targetDuration: content.targetDuration,
    duration: getDuration(content),
    storyTopic: resolveStoryTopicOverride(analytics),
    voice: asString(voice.id),
    bgm: asString(style.bgm),
    publishAt: analytics?.publishAt?.toISOString() ?? null,
    coverUrl: analytics?.coverUrl ?? null,
    allowSave: analytics?.allowSave !== 0,
    customParams: getCustomParams(analytics?.customParams),
  };
}

export const videoAnalyticsRoute = new OpenAPIHono();

const batchGetRoute = createRoute({
  method: "get",
  path: "/",
  tags: [API_TAGS.videoAnalytics],
  operationId: "batchGetVideoAnalytics",
  summary: "批量获取视频发布元数据",
  request: { query: batchQuerySchema },
  responses: {
    200: {
      description: "批量视频分析配置",
      content: { "application/json": { schema: z.array(responseSchema) } },
    },
    400: { description: "内容 ID 数量或格式不合法" },
  },
});

videoAnalyticsRoute.openapi(batchGetRoute, async (c) => {
  const ids = parseBatchIds(c.req.valid("query").ids);
  if (!ids) return c.json(apiError("INVALID_BATCH_IDS", "内容 ID 数量或格式不合法"), 400);
  try {
    const contentRows = await db.select().from(contents).where(inArray(contents.id, ids));
    const analyticsRows = await db
      .select()
      .from(videoAnalytics)
      .where(inArray(videoAnalytics.contentId, ids));
    const contentById = new Map(contentRows.map((row) => [row.id, row]));
    const analyticsById = new Map(analyticsRows.map((row) => [row.contentId, row]));
    const result = ids.flatMap((id) => {
      const content = contentById.get(id);
      return content ? [buildResponse(content, analyticsById.get(id))] : [];
    });
    return c.json(result, 200);
  } catch (e) {
    logger.error({ err: e }, "video-analytics batch 查询失败");
    return c.json(internalError(), 500);
  }
});

const getRoute = createRoute({
  method: "get",
  path: "/{contentId}",
  tags: [API_TAGS.videoAnalytics],
  operationId: "getVideoAnalytics",
  summary: "获取单个视频发布元数据",
  request: { params: idSchema },
  responses: {
    200: {
      description: "视频分析配置",
      content: { "application/json": { schema: responseSchema } },
    },
    404: { description: "内容不存在" },
  },
});

videoAnalyticsRoute.openapi(getRoute, async (c) => {
  const { contentId } = c.req.valid("param");
  try {
    const rows = await db.select().from(contents).where(eq(contents.id, contentId)).limit(1);
    const content = rows[0];
    if (!content) return c.json(apiError("NOT_FOUND", "内容不存在"), 404);
    const analytics = (
      await db.select().from(videoAnalytics).where(eq(videoAnalytics.contentId, contentId)).limit(1)
    )[0];
    return c.json(buildResponse(content, analytics), 200);
  } catch (e) {
    logger.error({ err: e, contentId }, "video-analytics 查询失败");
    return c.json(internalError(), 500);
  }
});

const patchRoute = createRoute({
  method: "patch",
  path: "/{contentId}",
  tags: [API_TAGS.videoAnalytics],
  operationId: "updateVideoAnalytics",
  summary: "更新发布元数据（白名单字段原子 upsert）",
  request: {
    params: idSchema,
    body: { content: { "application/json": { schema: bodySchema } } },
  },
  responses: {
    200: { description: "保存成功", content: { "application/json": { schema: responseSchema } } },
    404: { description: "内容不存在" },
  },
});

/**
 * PATCH 事务结果判别联合：缺失/白名单拒绝/成功响应。
 * 白名单规则：非法值但与该行已存值相同 → 视为“未变更的遗留值”放行（no-op），
 * 否则拒绝——保证老数据（如目录前的 female_01 音色）改其它字段不被无关字段锁死。
 */
type AnalyticsPatchResult =
  | { kind: "missing" }
  | { kind: "voice-rejected" }
  | { kind: "bgm-rejected" }
  | { kind: "response"; result: VideoAnalyticsResponse };

/**
 * 事务写 contents（voice/style 回写）+ upsert video_analytics。
 * 对 contents 行 FOR UPDATE，与 tasks render-settings 共用同一行锁语义（F3/G2 全写者互斥）。
 */
async function writeAnalyticsAndCanonical(
  contentId: string,
  body: z.infer<typeof bodySchema>,
): Promise<AnalyticsPatchResult> {
  return db.transaction(async (tx) => {
    const content = (
      await tx.select().from(contents).where(eq(contents.id, contentId)).limit(1).for("update")
    )[0];
    if (!content) return { kind: "missing" };

    const currentVoiceId = asString(asRecord(content.voice).id);
    if (body.voice !== undefined && body.voice !== currentVoiceId && !isVoiceAllowed(body.voice)) {
      return { kind: "voice-rejected" };
    }
    const currentBgm = asString(asRecord(content.style).bgm) ?? "";
    if (body.bgm !== undefined && (body.bgm ?? "") !== currentBgm && !isBgmAllowed(body.bgm)) {
      return { kind: "bgm-rejected" };
    }

    const currentStyle = { ...asRecord(content.style) };
    const currentVoice = asRecord(content.voice);
    if (body.bgm !== undefined) {
      if (body.bgm === null) currentStyle.bgm = undefined;
      else currentStyle.bgm = body.bgm;
    }
    const contentPatch = {
      ...(body.voice !== undefined ? { voice: { ...currentVoice, id: body.voice } } : {}),
      ...(body.bgm !== undefined ? { style: currentStyle } : {}),
    };
    if (Object.keys(contentPatch).length > 0) {
      await tx
        .update(contents)
        .set({ ...contentPatch, updatedAt: new Date() })
        .where(eq(contents.id, contentId));
    }

    const existing = (
      await tx.select().from(videoAnalytics).where(eq(videoAnalytics.contentId, contentId)).limit(1)
    )[0];
    const now = new Date();
    const values = {
      contentId,
      storyTopic: body.storyTopic !== undefined ? body.storyTopic : (existing?.storyTopic ?? null),
      publishAt:
        body.publishAt !== undefined
          ? body.publishAt
            ? new Date(body.publishAt)
            : null
          : (existing?.publishAt ?? null),
      coverUrl: body.coverUrl !== undefined ? body.coverUrl : (existing?.coverUrl ?? null),
      allowSave:
        body.allowSave !== undefined ? (body.allowSave ? 1 : 0) : (existing?.allowSave ?? 0),
      customParams:
        body.customParams !== undefined ? body.customParams : (existing?.customParams ?? null),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await tx
      .insert(videoAnalytics)
      .values(values)
      .onDuplicateKeyUpdate({
        set: {
          storyTopic: values.storyTopic,
          publishAt: values.publishAt,
          coverUrl: values.coverUrl,
          allowSave: values.allowSave,
          customParams: values.customParams,
          updatedAt: values.updatedAt,
        },
      });

    const updatedContent = (
      await tx.select().from(contents).where(eq(contents.id, contentId)).limit(1)
    )[0];
    const updatedAnalytics = (
      await tx.select().from(videoAnalytics).where(eq(videoAnalytics.contentId, contentId)).limit(1)
    )[0];
    return updatedContent && updatedAnalytics
      ? { kind: "response", result: buildResponse(updatedContent, updatedAnalytics) }
      : { kind: "missing" };
  });
}

videoAnalyticsRoute.openapi(patchRoute, async (c) => {
  const { contentId } = c.req.valid("param");
  const body = c.req.valid("json");
  try {
    const outcome = await writeAnalyticsAndCanonical(contentId, body);
    if (outcome.kind === "missing") return c.json(apiError("NOT_FOUND", "内容不存在"), 404);
    if (outcome.kind === "voice-rejected") {
      return c.json(
        apiError("VOICE_NOT_ALLOWED", "音色不在允许列表", {
          field: "voice",
          received: body.voice,
          allowed: allVoiceIds(),
          hint: "GET /api/tts/voices",
        }),
        400,
      );
    }
    if (outcome.kind === "bgm-rejected") {
      return c.json(
        apiError("BGM_NOT_ALLOWED", "背景音乐素材不存在", {
          field: "bgm",
          received: body.bgm ?? undefined,
          hint: "GET /api/files?type=bgm",
        }),
        400,
      );
    }
    return c.json(outcome.result, 200);
  } catch (e) {
    logger.error({ err: e, contentId }, "video-analytics 保存失败");
    return c.json(internalError(), 500);
  }
});
