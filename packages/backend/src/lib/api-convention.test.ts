/**
 * api-convention 单测 — 路由构建器的错误信封自动附加与 tag 中文化（docs/16 契约层）
 */
import { describe, expect, it } from "vitest";
import {
  API_TAGS,
  OPENAPI_DOC_BASE,
  apiErrorSchema,
  buildApiRoute,
  errorResponse,
} from "./api-convention";

describe("buildApiRoute", () => {
  const base = {
    method: "get" as const,
    path: "/demo",
    tag: "health" as const,
    operationId: "getDemo",
    summary: "示例",
  };

  it("4xx/5xx 未显式给 content 时自动补统一错误信封", () => {
    const route = buildApiRoute({
      ...base,
      responses: { 200: { description: "ok" }, 404: { description: "不存在" } },
    });
    const responses = route.responses as Record<string, { content?: Record<string, unknown> }>;
    expect(responses["404"]?.content?.["application/json"]).toBeDefined();
    expect(responses["200"]?.content).toBeUndefined();
  });

  it("调用方显式给的错误 content 不被覆盖", () => {
    const custom = { "application/json": { schema: apiErrorSchema } };
    const route = buildApiRoute({
      ...base,
      responses: { 500: { description: "错", content: custom } },
    });
    const responses = route.responses as Record<string, { content: unknown }>;
    expect(responses["500"]?.content).toEqual(custom);
  });

  it("tag 映射为中文分组名", () => {
    const route = buildApiRoute({ ...base, responses: { 200: { description: "ok" } } });
    expect(route.tags).toEqual([API_TAGS.health]);
  });
});

describe("errorResponse / 文档基座", () => {
  it("errorResponse 产出带信封 schema 的响应项", () => {
    const item = errorResponse("参数错") as {
      description: string;
      content: Record<string, unknown>;
    };
    expect(item.description).toBe("参数错");
    expect(item.content["application/json"]).toBeDefined();
  });

  it("OPENAPI_DOC_BASE 的 tags 与 API_TAGS 值一一对应", () => {
    expect(OPENAPI_DOC_BASE.tags.map((t) => t.name)).toEqual(Object.values(API_TAGS));
  });
});
