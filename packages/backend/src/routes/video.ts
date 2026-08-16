/**
 * 视频渲染路由
 * POST /api/video/render — 接收完整 ContentDTO（含 audio），渲染 9:16 MP4
 * 契约详见 SPEC.md §5.3 + docs/10_视频渲染设计文档.md
 */
import type { ContentDTO } from "@ai-english/shared";
import { Hono } from "hono";
import { z } from "zod";
import { logger } from "../lib/logger";
import { renderVideo } from "../services/video.service";

// ── Zod schema（与 handler 相邻，类型与 shared ContentDTO 结构对齐） ──

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

/** content 结构按 template 判别（与 ContentArray 联合一一对应） */
const contentSchemaByTemplate = {
  scene_word: z.array(sceneWordSegmentSchema).min(1),
  word_card: z.array(wordCardItemSchema).min(1),
  quiz: z.array(quizItemSchema).min(1),
} as const;

/** ContentDTO 除 content 外的字段（content 按 template 单独校验） */
const baseSchema = z.object({
  id: z.string().min(1),
  template: z.enum(["scene_word", "word_card", "quiz"]),
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
});

// ── 路由 ──

export const video = new Hono().post("/render", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "请求体不是合法 JSON" }, 400);
  }

  const base = baseSchema.safeParse(raw);
  if (!base.success) {
    return c.json({ success: false, error: base.error }, 400);
  }

  // content 按 template 对应的结构校验（无 as：z.record 提取 + 模板判别 schema）
  const rawRecord = z.record(z.string(), z.unknown()).safeParse(raw);
  if (!rawRecord.success) {
    return c.json({ success: false, error: rawRecord.error }, 400);
  }
  const contentResult = contentSchemaByTemplate[base.data.template].safeParse(
    rawRecord.data.content,
  );
  if (!contentResult.success) {
    return c.json({ success: false, error: contentResult.error }, 400);
  }

  const dto: ContentDTO = { ...base.data, content: contentResult.data };

  try {
    const videoResult = await renderVideo(dto);
    return c.json({ video: videoResult });
  } catch (err) {
    logger.error({ err, template: dto.template }, "video render failed");
    return c.json({ error: "Video rendering failed" }, 500);
  }
});
