/**
 * AI 内容生成路由
 * POST /api/content/generate — 主题 → LLM 生成情景故事 → 词库校验 → ContentDTO
 * 契约详见 SPEC.md §六 + docs/15_AI内容生成服务设计.md（@hono/zod-openapi）
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { db } from "../db";
import { contents } from "../db/schema";
import { logger } from "../lib/logger";
import { generateSceneWordContent } from "../services/content.service";
import { LlmNotConfiguredError } from "../services/llm.service";
import { generateQuizContent } from "../services/quiz.service";
import { generateWordCardContent } from "../services/word-card.service";

// ── Zod schema ──

const generateSchema = z.object({
  topic: z.string().min(1).max(50),
  level: z.enum(["CET4", "CET6"]),
  /** 模板选择（MVP 需求 #1）：情景背词 / 单词卡片 / 选择题 */
  template: z.enum(["scene_word", "word_card", "quiz"]).optional().default("scene_word"),
  wordCount: z.number().int().min(3).max(15).optional(),
  targetDuration: z.number().int().min(15).max(300).optional(),
});

/** ContentDTO（scene_word 全量，docs/04）— 供 content/tts/video 路由共用 */
export const wordInfoSchema = z.object({
  word: z.string(),
  meaning: z.string(),
  level: z.enum(["CET4", "CET6"]),
  wordIndex: z.number().int().optional(),
  frequency: z.number().optional(),
});

const sceneWordSegmentSchema = z.object({
  text: z.string(),
  words: z.array(wordInfoSchema),
});

const styleSchema = z.object({
  background: z.string(),
  font: z.string().optional(),
  colorScheme: z.string().optional(),
  bgm: z.string().optional(),
});

const voiceSchema = z.object({
  id: z.string(),
  speed: z.number().optional(),
});

const audioSchema = z.object({
  url: z.string(),
  duration: z.number(),
  format: z.string(),
});

export const contentDtoSchema = z.object({
  id: z.string(),
  template: z.enum(["scene_word", "word_card", "quiz"]),
  title: z.string(),
  level: z.enum(["CET4", "CET6"]),
  targetDuration: z.number(),
  content: z.array(sceneWordSegmentSchema),
  words: z.array(wordInfoSchema),
  style: styleSchema,
  voice: voiceSchema,
  audio: audioSchema.optional(),
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
});

const generateResponseSchema = z.object({ content: contentDtoSchema });

// ── 路由定义 ──

const generateRoute = createRoute({
  method: "post",
  path: "/generate",
  summary: "AI 生成情景故事内容（ContentDTO）",
  request: {
    body: { content: { "application/json": { schema: generateSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: generateResponseSchema } },
      description: "生成成功（词库校验后的 ContentDTO）",
    },
    400: { description: "参数不合法" },
    503: { description: "LLM 未配置" },
    500: { description: "生成失败" },
  },
});

// ── 路由注册 ──

export const content = new OpenAPIHono().openapi(generateRoute, async (c): Promise<Response> => {
  const input = c.req.valid("json");
  try {
    const dto =
      input.template === "word_card"
        ? await generateWordCardContent(input)
        : input.template === "quiz"
          ? await generateQuizContent(input)
          : await generateSceneWordContent(input);
    logger.info(
      { template: dto.template, title: dto.title, segments: dto.content.length },
      "content generated",
    );
    // 自动建任务记录（contents 表，状态 content_ready）；落库失败仅告警不阻塞响应
    try {
      await db.insert(contents).values({
        id: dto.id,
        template: dto.template,
        title: dto.title,
        level: input.level,
        targetDuration: input.targetDuration ?? 60,
        content: dto.content as unknown as object[],
        words: dto.words as unknown as object[],
        style: dto.style as unknown as object,
        voice: dto.voice as unknown as object,
        audit: dto.audit as unknown as object,
        status: "content_ready",
      });
      logger.info({ id: dto.id }, "task record created");
    } catch (dbErr) {
      logger.warn({ err: dbErr, id: dto.id }, "task record 落库失败（不影响生成结果）");
    }
    return c.json({ content: dto });
  } catch (err) {
    if (err instanceof LlmNotConfiguredError) {
      return c.json({ error: err.message }, 503);
    }
    logger.error({ err }, "content generate failed");
    return c.json({ error: "Content generation failed" }, 500);
  }
});
