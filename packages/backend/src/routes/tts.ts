/**
 * TTS 路由
 * POST /api/tts/generate       — 底层：接收纯文本（已发布契约，保持兼容）
 * POST /api/tts/from-content   — 内容生成/前端使用：接收 ContentArray，后端拼接 + 合成 + 返回音频元数据
 * 契约详见 SPEC.md §5.2（@hono/zod-openapi）
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { logger } from "../lib/logger";
import { buildTtsText, getAudioDuration, synthesizeSpeech } from "../services/tts.service";

// ── Zod schema ──

const ttsSchema = z.object({
  text: z.string().min(1).max(500),
  voice: z.string().optional().default("zh-CN-XiaoxiaoNeural"),
});

// content 为上游传入的动态 JSON（AGENTS.md §3.1：Record<string, unknown> 例外）
const fromContentSchema = z.object({
  content: z.array(z.record(z.string(), z.unknown())).min(1).max(100),
  template: z.enum(["scene_word", "word_card", "quiz"]),
  voice: z.string().optional().default("zh-CN-XiaoxiaoNeural"),
});

const ttsResponseSchema = z.object({
  success: z.boolean(),
  filename: z.string(),
  url: z.string(),
});

const audioSchema = z.object({
  url: z.string(),
  duration: z.number(),
  format: z.string(),
});

const audioResponseSchema = z.object({ audio: audioSchema });

// ── 路由定义 ──

const generateRoute = createRoute({
  method: "post",
  path: "/generate",
  summary: "TTS 底层接口（纯文本合成，已发布契约）",
  request: {
    body: { content: { "application/json": { schema: ttsSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: ttsResponseSchema } },
      description: "合成成功，返回音频文件信息",
    },
    400: { description: "参数不合法" },
    500: { description: "TTS 引擎错误" },
  },
});

const fromContentRoute = createRoute({
  method: "post",
  path: "/from-content",
  summary: "按模板拼接朗读文本并合成（返回音频元数据）",
  request: {
    body: { content: { "application/json": { schema: fromContentSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: audioResponseSchema } },
      description: "合成成功（url/duration/format）",
    },
    400: { description: "content 无法拼出文本 / 超 500 字符" },
    500: { description: "TTS 引擎错误" },
  },
});

// ── 内部工具 ──

/** 写 MP3 文件并用 ffprobe 探测时长，返回文件信息 */
async function saveAudio(
  buffer: Buffer,
): Promise<{ filename: string; url: string; duration: number; format: string }> {
  const filename = `${randomUUID()}.mp3`;
  const dir = join(import.meta.dirname, "../../uploads/audio");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, filename);
  await writeFile(filePath, buffer);
  const duration = await getAudioDuration(filePath);
  return { filename, url: `/files/audio/${filename}`, duration, format: "mp3" };
}

// ── 路由注册 ──

export const tts = new OpenAPIHono()
  .openapi(generateRoute, async (c): Promise<Response> => {
    const { text, voice } = c.req.valid("json");
    try {
      const audio = await synthesizeSpeech(text, voice);
      const { filename, url } = await saveAudio(audio);
      logger.info({ filename, textLength: text.length }, "tts file saved");
      return c.json({ success: true, filename, url });
    } catch (err) {
      logger.error({ err }, "tts generate failed");
      return c.json({ error: "TTS synthesis failed" }, 500);
    }
  })
  .openapi(fromContentRoute, async (c): Promise<Response> => {
    const { content, template, voice } = c.req.valid("json");
    try {
      const text = buildTtsText(content, template);
      if (text.length === 0) {
        return c.json({ error: "content 无法拼出朗读文本" }, 400);
      }
      // 与 generate 契约对齐：单次合成文本上限 500 字符（content 最多 100 段，拼接可能超限）
      if (text.length > 500) {
        return c.json({ error: "拼接文本超过 500 字符上限" }, 400);
      }
      const audio = await synthesizeSpeech(text, voice);
      const { url, duration, format } = await saveAudio(audio);
      logger.info({ template, duration, textLength: text.length }, "tts from-content saved");
      return c.json({ audio: { url, duration, format } });
    } catch (err) {
      logger.error({ err }, "tts from-content failed");
      return c.json({ error: "TTS synthesis failed" }, 500);
    }
  });
