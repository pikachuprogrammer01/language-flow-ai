import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { logger } from "../lib/logger";
import { synthesizeSpeech } from "../services/tts.service";

const ttsSchema = z.object({
  text: z.string().min(1).max(500),
  voice: z.string().optional().default("zh-CN-XiaoxiaoNeural"),
});

export const tts = new Hono().post("/generate", zValidator("json", ttsSchema), async (c) => {
  const { text, voice } = c.req.valid("json");

  try {
    const audio = await synthesizeSpeech(text, voice);
    const filename = `${randomUUID()}.mp3`;
    const dir = join(import.meta.dirname, "../../uploads/audio");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, filename), audio);

    logger.info({ filename, textLength: text.length }, "tts file saved");

    return c.json({ success: true, filename, url: `/files/audio/${filename}` });
  } catch (err) {
    logger.error({ err }, "tts generate failed");
    return c.json({ error: "TTS synthesis failed" }, 500);
  }
});
