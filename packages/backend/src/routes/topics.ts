/**
 * 主题推荐路由
 * POST /api/topics/suggest — 本地模型生成故事主题候选（PRD §10.1.2 主题选择）
 * 输入 hint 可选（用户意图/关键词）；输出 5-8 个 {title, description} 候选，用户确认后再生成内容
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { logger } from "../lib/logger";
import { LlmNotConfiguredError, chatCompletion, extractJson } from "../services/llm.service";

const suggestSchema = z.object({
  hint: z.string().max(50).optional(),
});

const suggestResponseSchema = z.object({
  topics: z.array(z.object({ title: z.string(), description: z.string() })).min(1),
});

export const topics = new OpenAPIHono();

const suggestRoute = createRoute({
  method: "post",
  path: "/suggest",
  summary: "本地模型生成故事主题候选",
  request: { body: { content: { "application/json": { schema: suggestSchema } } } },
  responses: {
    200: {
      description: "主题候选列表",
      content: { "application/json": { schema: suggestResponseSchema } },
    },
    503: { description: "LLM 未配置" },
    500: { description: "生成失败" },
  },
  tags: ["topics"],
});

topics.openapi(suggestRoute, async (c): Promise<Response> => {
  const { hint } = c.req.valid("json");
  const hintLine = hint
    ? `用户提示词（围绕它展开，不要重复原标题）：${hint}`
    : "用户提示词为空（覆盖生活/职场/校园/旅行/科技/美食/森林/城市等常见场景即可）";
  try {
    const raw = await chatCompletion([
      {
        role: "system",
        content:
          "你是短视频选题策划。请给出 6 个适合制作「四级词汇情景记忆短视频」的故事主题。" +
          "要求：主题具体、有画面感、适合 60 秒小故事（如「深夜便利店的值班故事」）；" +
          "只输出 JSON，不要任何解释或 markdown。",
      },
      {
        role: "user",
        content: `${hintLine}\n输出格式：{"topics":[{"title":"主题名（10 字内）","description":"一句话场景说明（20 字内）"}]}`,
      },
    ]);
    const parsed = extractJson<{ topics: { title: string; description: string }[] }>(raw);
    const topics = (parsed.topics ?? []).filter((t) => t.title).slice(0, 8);
    if (topics.length === 0) {
      return c.json({ error: "主题生成结果为空" }, 500);
    }
    return c.json({ topics });
  } catch (err) {
    if (err instanceof LlmNotConfiguredError) {
      return c.json({ error: err.message }, 503);
    }
    logger.error({ err }, "主题推荐失败");
    return c.json({ error: "主题推荐失败" }, 500);
  }
});
