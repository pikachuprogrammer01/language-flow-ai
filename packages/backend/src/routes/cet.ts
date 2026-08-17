/**
 * 四六级词库路由 — POST /api/cet/validate-words · /api/cet/random-words
 * 依据：SPEC.md §5.1（@hono/zod-openapi 定义，自动生成 OpenAPI 文档）
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { db } from "../db";
import { logger } from "../lib/logger";
import { randomWords, validateWords } from "../services/cet.service";

// ── Zod schema（openapi 扩展，与 handler 相邻） ──

const validateWordsSchema = z.object({
  words: z.array(z.string().min(1).max(100)).min(1).max(100),
  level: z.enum(["CET4", "CET6"]),
});

const randomWordsSchema = z.object({
  level: z.enum(["CET4", "CET6"]),
  count: z.number().int().min(1).max(15),
});

const matchedWordSchema = z.object({
  word: z.string(),
  level: z.enum(["CET4", "CET6"]),
  meaning: z.string(),
  frequency: z.number().optional(),
});

const validateWordsResponseSchema = z.object({
  matchedWords: z.array(matchedWordSchema),
  unmatchedWords: z.array(z.string()),
});

const randomWordsResponseSchema = z.object({
  words: z.array(matchedWordSchema),
});

// ── 路由定义 ──

const validateWordsRoute = createRoute({
  method: "post",
  path: "/validate-words",
  summary: "词库精确校验",
  request: {
    body: { content: { "application/json": { schema: validateWordsSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: validateWordsResponseSchema } },
      description: "校验结果（词义以词库为准）",
    },
    400: { description: "参数不合法" },
    500: { description: "词库查询失败" },
  },
});

const randomWordsRoute = createRoute({
  method: "post",
  path: "/random-words",
  summary: "随机抽取高频词",
  request: {
    body: { content: { "application/json": { schema: randomWordsSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: randomWordsResponseSchema } },
      description: "高频池随机抽样结果",
    },
    400: { description: "参数不合法" },
    500: { description: "词库查询失败" },
  },
});

// ── 路由注册 ──

export const cet = new OpenAPIHono()
  .openapi(validateWordsRoute, async (c) => {
    const { words, level } = c.req.valid("json");
    try {
      const result = await validateWords(words, level, db);
      return c.json(result);
    } catch (err) {
      logger.error({ err, wordCount: words.length }, "validate words failed");
      return c.json({ error: "词库查询失败" }, 500);
    }
  })
  .openapi(randomWordsRoute, async (c) => {
    const { level, count } = c.req.valid("json");
    try {
      const result = await randomWords(level, count, db);
      return c.json(result);
    } catch (err) {
      logger.error({ err, level, count }, "random words failed");
      return c.json({ error: "词库查询失败" }, 500);
    }
  });
