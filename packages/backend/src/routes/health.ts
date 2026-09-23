/**
 * 健康检查路由 — GET /health
 * 规范化：改用 OpenAPIHono + createRoute，纳入 OpenAPI 文档体系（docs/16）
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { API_TAGS } from "../lib/api-convention";

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: [API_TAGS.health],
  operationId: "getHealth",
  summary: "服务健康检查",
  description: "存活探针，供负载均衡 / 监控 / 运维脚本使用，无鉴权",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: z.object({
            status: z.literal("ok"),
            timestamp: z.string().openapi({ format: "date-time" }),
          }),
        },
      },
      description: "服务正常",
    },
  },
});

export const health = new OpenAPIHono().openapi(healthRoute, (c) =>
  c.json({ status: "ok", timestamp: new Date().toISOString() }),
);
