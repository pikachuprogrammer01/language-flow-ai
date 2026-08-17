/**
 * 视频渲染路由
 * POST /api/video/render — 接收完整 ContentDTO（含 audio），渲染 9:16 MP4
 * 契约详见 SPEC.md §5.3 + docs/10_视频渲染设计文档.md（@hono/zod-openapi）
 */
import type { ContentDTO } from "@ai-english/shared";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { logger } from "../lib/logger";
import { renderVideo } from "../services/video.service";

// ── Zod schema（与 shared ContentDTO 结构对齐） ──

const wordInfoSchema = z.object({
  word: z.string().min(1),
  meaning: z.string().min(1),
  level: z.enum(["CET4", "CET6"]),
  wordIndex: z.number().int().optional(),
  frequency: z.number().optional(),
});

const sceneWordSegmentSchema = z.object({
  text: z.string().min(1),
  words: z.array(wordInfoSchema),
});

const wordCardItemSchema = z.object({
  word: z.string().min(1),
  pos: z.string(),
  meaning: z.string().min(1),
  example: z.string(),
  exampleMeaning: z.string().optional(),
  imageUrl: z.string().optional(),
});

const quizItemSchema = z.object({
  stem: z.string().min(1),
  options: z.array(z.string().min(1)).min(2).max(4),
  correctIndex: z.number().int().min(0),
  explanation: z.string(),
  word: wordInfoSchema,
});

/** ContentDTO 公共字段（audio 必填：渲染前置条件） */
const baseFields = {
  id: z.string().min(1),
  title: z.string().min(1).max(100),
  level: z.enum(["CET4", "CET6"]),
  targetDuration: z.number().positive(),
  words: z.array(wordInfoSchema),
  style: z.object({
    background: z.string(),
    font: z.string().optional(),
    colorScheme: z.string().optional(),
    bgm: z.string().optional(),
  }),
  voice: z.object({
    id: z.string().min(1),
    speed: z.number().optional(),
  }),
  audio: z.object({
    url: z.string().min(1),
    duration: z.number().positive(),
    format: z.string().min(1),
  }),
  status: z.enum([
    "draft",
    "ai_generating",
    "content_ready",
    "tts_processing",
    "audio_ready",
    "video_rendering",
    "completed",
    "failed",
  ]),
  createdAt: z.string(),
  updatedAt: z.string(),
} as const;

/** content 结构按 template 判别（与 ContentArray 联合一一对应） */
const renderRequestSchema = z.discriminatedUnion("template", [
  z.object({
    ...baseFields,
    template: z.literal("scene_word"),
    content: z.array(sceneWordSegmentSchema).min(1),
  }),
  z.object({
    ...baseFields,
    template: z.literal("word_card"),
    content: z.array(wordCardItemSchema).min(1),
  }),
  z.object({ ...baseFields, template: z.literal("quiz"), content: z.array(quizItemSchema).min(1) }),
]);

const videoResultSchema = z.object({ url: z.string() });
const renderResponseSchema = z.object({ video: videoResultSchema });

// ── 路由定义 ──

const renderRoute = createRoute({
  method: "post",
  path: "/render",
  summary: "渲染 9:16 短视频（按 template 判别结构）",
  request: {
    body: { content: { "application/json": { schema: renderRequestSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: renderResponseSchema } },
      description: "渲染成功，返回视频 URL",
    },
    400: { description: "ContentDTO 结构不合法" },
    500: { description: "渲染失败（Playwright/FFmpeg）" },
  },
});

// ── 路由注册 ──

export const video = new OpenAPIHono().openapi(renderRoute, async (c): Promise<Response> => {
  const dto = c.req.valid("json") as unknown as ContentDTO;
  try {
    const videoResult = await renderVideo(dto);
    return c.json({ video: videoResult });
  } catch (err) {
    logger.error({ err, template: dto.template }, "video render failed");
    return c.json({ error: "Video rendering failed" }, 500);
  }
});
