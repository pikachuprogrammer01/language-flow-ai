import { zValidator } from "@hono/zod-validator";
/**
 * 四六级词库路由 — POST /api/cet/validate-words
 * 依据：SPEC.md §5.1.1
 */
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db";
import { logger } from "../lib/logger";
import { randomWords, validateWords } from "../services/cet.service";

// ── Zod schema（与 handler 相邻） ──

const validateWordsSchema = z.object({
  words: z.array(z.string().min(1).max(100)).min(1).max(100),
  level: z.enum(["CET4", "CET6"]),
});

const randomWordsSchema = z.object({
  level: z.enum(["CET4", "CET6"]),
  count: z.number().int().min(1).max(15),
});

// ── 路由 ──

export const cet = new Hono()
  .post("/validate-words", zValidator("json", validateWordsSchema), async (c) => {
    const { words, level } = c.req.valid("json");

    try {
      const result = await validateWords(words, level, db);
      return c.json(result);
    } catch (err) {
      logger.error({ err, wordCount: words.length }, "validate words failed");
      return c.json({ error: "词库查询失败" }, 500);
    }
  })
  .post("/random-words", zValidator("json", randomWordsSchema), async (c) => {
    const { level, count } = c.req.valid("json");

    try {
      const result = await randomWords(level, count, db);
      return c.json(result);
    } catch (err) {
      logger.error({ err, level, count }, "random words failed");
      return c.json({ error: "词库查询失败" }, 500);
    }
  });
