/**
 * AI 内容生成路由
 * POST /api/content/generate — 主题 → LLM 生成情景故事 → 词库校验 → ContentDTO
 * 契约详见 SPEC.md §六 + docs/15_AI内容生成服务设计.md
 */
import { Hono } from "hono";
import { z } from "zod";
import { logger } from "../lib/logger";
import { generateSceneWordContent } from "../services/content.service";
import { LlmNotConfiguredError } from "../services/llm.service";

const generateSchema = z.object({
  topic: z.string().min(1).max(50),
  level: z.enum(["CET4", "CET6"]),
  wordCount: z.number().int().min(3).max(15).optional(),
  targetDuration: z.number().int().min(15).max(300).optional(),
});

export const content = new Hono().post("/generate", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "请求体不是合法 JSON" }, 400);
  }

  const parsed = generateSchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error }, 400);
  }

  try {
    const dto = await generateSceneWordContent(parsed.data);
    logger.info(
      { template: dto.template, title: dto.title, segments: dto.content.length },
      "content generated",
    );
    return c.json({ content: dto });
  } catch (err) {
    if (err instanceof LlmNotConfiguredError) {
      return c.json({ error: err.message }, 503);
    }
    logger.error({ err }, "content generate failed");
    return c.json({ error: "Content generation failed" }, 500);
  }
});
