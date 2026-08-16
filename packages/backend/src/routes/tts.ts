/**
 * TTS 路由
 * POST /api/tts/generate       — 底层：接收纯文本（已发布契约，保持兼容）
 * POST /api/tts/from-content   — Workflow B 使用：接收 ContentArray，后端拼接 + 合成 + 返回音频元数据
 * 契约详见 SPEC.md §5.2
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { logger } from "../lib/logger";
import { buildTtsText, getAudioDuration, synthesizeSpeech } from "../services/tts.service";

// ── Zod schema（与 handler 相邻） ──

const ttsSchema = z.object({
  text: z.string().min(1).max(500),
  voice: z.string().optional().default("zh-CN-XiaoxiaoNeural"),
});

// content 为 Dify 传入的动态 JSON（AGENTS.md §3.1：Record<string, unknown> 例外）
const fromContentSchema = z.object({
  content: z.array(z.record(z.string(), z.unknown())).min(1).max(100),
  template: z.enum(["scene_word", "word_card", "quiz"]),
  voice: z.string().optional().default("zh-CN-XiaoxiaoNeural"),
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

// ── 路由 ──

export const tts = new Hono()
  .post("/generate", zValidator("json", ttsSchema), async (c) => {
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
  .post("/from-content", zValidator("json", fromContentSchema), async (c) => {
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
