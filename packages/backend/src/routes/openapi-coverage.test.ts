/**
 * OpenAPI 文档覆盖度与统一规范校验（docs/16 §四 完整性保障）
 * 作为常驻门禁运行：pnpm openapi:check / vitest（pre-push）/ lefthook
 * 校验项：
 *  1. 代码注册的全部路由均收录进 OpenAPI 文档（零遗漏，杜绝裸 Hono 端点）
 *  2. 每个 operation 齐全：summary / tags / operationId / 全响应 description
 *  3. operationId 全局唯一
 *  4. /api 下路径 kebab-case（动态段 {param} 除外），方法/状态码在白名单内
 *  5. /doc 实时 JSON 与代码 getOpenAPIDocument() 一致（文档页不会展示过时契约）
 */
import type { OpenAPIHono } from "@hono/zod-openapi";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OPENAPI_DOC_BASE } from "../lib/api-convention";

// 纯文档校验不碰数据库（与其他路由测试同一 mock 惯例）
vi.mock("../db", () => ({ db: {} }));
// index.ts 入口环境变量自检只需非空值；池已 mock，不会真建连
process.env.DATABASE_URL ??= "mysql://test:test@localhost:3306/test";
// index.ts 导入即 listen：随机端口避免与运行中的 dev server 冲占 8080
process.env.PORT = "0";
const { default: app, server } = await import("../index");

type Doc = ReturnType<OpenAPIHono["getOpenAPIDocument"]>;
interface OperationObject {
  summary?: string;
  tags?: string[];
  operationId?: string;
  responses: Record<string, { description?: string }>;
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);
const ALLOWED_STATUS = new Set([
  "200",
  "201",
  "204",
  "400",
  "401",
  "403",
  "404",
  "409",
  "422",
  "429",
  "500",
  "501",
  "503",
]);

let doc: Doc;
let registered: { method: string; path: string }[] = [];

beforeAll(async () => {
  doc = app.getOpenAPIDocument(OPENAPI_DOC_BASE);
  // Hono 内部 routes：method 大写；mount 后子路径与全路径双记录；中间件为 ALL —— 归一＋去重后只留端点
  const raw = (app as unknown as { routes: { method: string; path: string }[] }).routes
    .filter((r) => HTTP_METHODS.has(r.method.toLowerCase()))
    .map((r) => `${r.method.toLowerCase()} ${normalize(r.path)}`);
  registered = [...new Set(raw)].map((k) => {
    const [method, path] = k.split(" ");
    return { method, path };
  });
});

afterAll(() => {
  server?.close();
});

/** OpenAPI path 模板 /x/{y} 与 Hono 内部 :x 写法归一化后比较 */
const normalize = (p: string): string =>
  p.replaceAll(/:[A-Za-z_][A-Za-z0-9_]*/g, (m) => `{${m.slice(1)}}`);

/** 文档自举路由（app.doc / Swagger UI 页）本身不属于业务 API，不参与双向比对 */
const DOC_ROUTES = new Set(["GET /doc", "GET /doc/"]);

describe("OpenAPI 文档覆盖度", () => {
  it("代码注册的每条路由都收录进文档（无遗漏端点）", () => {
    const documented = new Set(
      Object.entries(doc.paths).flatMap(([path, methods]) =>
        Object.keys(methods).map((m) => `${m.toUpperCase()} ${path}`),
      ),
    );
    const missing = registered
      .map((r) => `${r.method.toUpperCase()} ${normalize(r.path)}`)
      .filter((key) => !documented.has(key) && !DOC_ROUTES.has(key));
    expect(
      missing,
      `以下端点未纳入 OpenAPI 文档，请改用 OpenAPIHono.openapi() 定义：\n${missing.join("\n")}`,
    ).toEqual([]);
  });

  it("文档不含幽灵路径（文档 ⊆ 代码注册路由）", () => {
    const codeKeys = new Set(
      registered
        .map((r) => `${r.method.toUpperCase()} ${normalize(r.path)}`)
        .filter((k) => !DOC_ROUTES.has(k)),
    );
    const ghosts = Object.entries(doc.paths).flatMap(([path, methods]) =>
      Object.keys(methods)
        .map((m) => `${m.toUpperCase()} ${path}`)
        .filter((key) => !codeKeys.has(key)),
    );
    expect(ghosts).toEqual([]);
  });
});

describe("统一规范强制", () => {
  it("每个 operation 齐全 summary/tags/operationId，每个响应有 description", () => {
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(methods) as [string, OperationObject][]) {
        const id = `${method.toUpperCase()} ${path}`;
        expect(op.summary, `${id} 缺少 summary`).toBeTruthy();
        expect(op.tags?.length, `${id} 缺少 tags（文档分组）`).toBeTruthy();
        expect(op.operationId, `${id} 缺少 operationId`).toBeTruthy();
        for (const [status, resp] of Object.entries(op.responses)) {
          expect(resp.description, `${id} 响应 ${status} 缺少 description`).toBeTruthy();
          expect(ALLOWED_STATUS.has(status), `${id} 响应状态码 ${status} 不在规范白名单`).toBe(
            true,
          );
        }
      }
    }
  });

  it("operationId 全局唯一", () => {
    const ids = Object.values(doc.paths).flatMap((methods) =>
      Object.values(methods).map((op) => (op as OperationObject).operationId ?? ""),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("/api 下路径段符合 kebab-case（动态段 {param} 除外）", () => {
    const segmentOk = (s: string) =>
      /^\{[a-zA-Z][A-Za-z0-9_]*\}$/.test(s) || /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(s);
    const bad = Object.keys(doc.paths)
      .filter((p) => p.startsWith("/api"))
      .filter((p) =>
        p
          .split("/")
          .slice(2)
          .some((s) => !segmentOk(s)),
      );
    expect(bad, `以下路径违反 kebab-case 规范：${bad.join(", ")}`).toEqual([]);
  });

  it("仅使用规范白名单内的 HTTP 方法", () => {
    for (const r of registered) {
      expect(HTTP_METHODS.has(r.method), `端点 ${r.method} ${r.path} 方法不合规`).toBe(true);
    }
  });

  it("GET /doc 实时 JSON 与代码文档一致（可视化页永不展示过时契约）", async () => {
    const live = (await (await app.request("/doc")).json()) as Doc;
    expect(live.paths).toEqual(doc.paths);
  });

  it("GET /doc/ 返回 Swagger UI 页面且含返回管理界面导航", async () => {
    const res = await app.request("/doc/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("swagger-ui");
    expect(html).toContain("返回管理界面");
  });
});
