/**
 * 工作台聚合路由
 * GET /api/dashboard/summary — 指标/流水线/失败原因/最近任务一次返回（前端 500ms 轮询）
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { API_TAGS } from "../lib/api-convention";
import { getDashboardSummary } from "../services/dashboard.service";

const summarySchema = z.object({
  today: z.number(),
  yesterday: z.number(),
  pendingRender: z.number(),
  ttsActive: z.number(),
  completedVideos: z.number(),
  topTemplate: z.object({ name: z.string(), share: z.number() }).nullable(),
  failed: z.number(),
  failureReasons: z.array(z.string()),
  pipeline: z.object({
    generating: z.number(),
    validating: z.number(),
    tts: z.number(),
    rendering: z.number(),
    publishable: z.number(),
  }),
  recent: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      template: z.string(),
      level: z.string(),
      status: z.string(),
      intro: z.string(),
      updatedAt: z.string(),
    }),
  ),
});

const summaryRoute = createRoute({
  method: "get",
  path: "/summary",
  tags: [API_TAGS.dashboard],
  operationId: "getDashboardSummary",
  summary: "工作台实时聚合（状态存量/今日昨日/可发布/失败原因/最近任务）",
  responses: {
    200: {
      description: "工作台聚合数据",
      content: { "application/json": { schema: summarySchema } },
    },
  },
});

export const dashboard = new OpenAPIHono();

dashboard.openapi(summaryRoute, async (c) => {
  const summary = await getDashboardSummary();
  return c.json(summary, 200);
});
