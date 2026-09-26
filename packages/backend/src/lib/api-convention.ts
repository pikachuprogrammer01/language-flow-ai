/**
 * RESTful API 统一规范（docs/16）— 契约层单一定义源
 *
 * 1. 路径命名：/api 下业务端点统一 kebab-case（校验见 routes/openapi-coverage.test.ts），
 *    资源用复数名词；非 CRUD 动作用子路径动词（/batch-delete、/from-content）
 * 2. HTTP 方法：GET 只读 / POST 创建与动作 / PATCH 局部更新 / DELETE 删除
 * 3. 状态码：200 成功 / 201 创建 / 204 无内容 / 400 参数错 / 401/403 未认证 / 404 不存在 / 409 冲突 /
 *    422 语义错 / 429 限流 / 500 内部错误 / 501 未实现（依赖的本地能力缺席）/ 503 依赖服务不可用
 * 4. 错误格式：非 2xx 统一 { error: string, message?, code? }（本文件 apiErrorSchema）；
 *    新端点渐进采用 DX-1 结构化信封 apiError()（lib/api-error.ts），两者并存不破坏存量契约
 * 5. 文档化：所有端点必须经 OpenAPIHono.openapi() 注册（含 tags/summary/operationId），
 *    由 app.doc() 自动进入 OpenAPI 3.1 文档，禁止裸 Hono 路由游离于文档体系
 */
import { createRoute, z } from "@hono/zod-openapi";

/** createRoute 响应项类型（包未导出内联类型，从入参反推保持单一事实） */
type RouteConfig = Parameters<typeof createRoute>[0];
type ResponseItem = NonNullable<RouteConfig["responses"]>[string];
type ContentOf<T> = T extends { content?: infer C } ? C : never;
type MediaContent = NonNullable<ContentOf<ResponseItem>>;

// ── 文档分组（OpenAPI tags，Scalar/Swagger UI 按此分组） ──

export const API_TAGS = {
  health: "健康检查",
  files: "文件资产",
  cet: "词库",
  content: "内容生成",
  tts: "配音",
  video: "视频渲染",
  tasks: "任务记录",
  topics: "故事主题",
  fileManager: "文件管理",
  uploadMarks: "上传标记",
  llm: "LLM 引擎",
  dashboard: "工作台",
  videoAnalytics: "视频发布",
  analytics: "数据分析",
} as const;

export type ApiTagKey = keyof typeof API_TAGS;

/** createRoute 公共扩展：补 tag / operationId / 统一错误响应 */
export interface ApiRouteOptions {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  /** OpenAPI tag 键（见 API_TAGS） */
  tag: ApiTagKey;
  /** 全局唯一，camelCase，如 validateWords */
  operationId: string;
  summary: string;
  description?: string;
  request?: Record<string, unknown>;
  /** 状态码 → 描述；错误响应自动附统一信封 schema */
  responses: Record<string, { description: string; content?: MediaContent }>;
}

/** 统一错误响应体 schema（兼容存量 { error: string } 与增量 { error, message, code }） */
export const apiErrorSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  code: z.string().optional(),
});

/** 构造带统一错误信封的单个响应项 */
export function errorResponse(description: string): ResponseItem {
  return {
    description,
    content: { "application/json": { schema: apiErrorSchema } },
  } as ResponseItem;
}

/**
 * 归一化 createRoute 入参：4xx/5xx 响应自动补统一错误信封（调用方已显式给 content 的不覆盖）
 * 注：下方 as 仅用于桥接 zod-openapi 未导出的内部响应类型，入参形状已由 ApiRouteOptions 对外约束
 */
export function buildApiRoute(options: ApiRouteOptions): ReturnType<typeof createRoute> {
  const { tag, operationId, responses, ...rest } = options;
  const enriched: Record<string, ResponseItem> = {};
  for (const [status, meta] of Object.entries(responses)) {
    const isError = status.startsWith("4") || status.startsWith("5");
    enriched[status] =
      isError && !meta.content ? errorResponse(meta.description) : (meta as ResponseItem);
  }
  return createRoute({
    ...rest,
    operationId,
    tags: [API_TAGS[tag]],
    responses: enriched,
  } as RouteConfig);
}

// ── OpenAPI 文档全局配置（app.doc / getOpenAPIDocument 共用） ──

export const OPENAPI_DOC_BASE = {
  openapi: "3.1.0" as const,
  info: {
    title: "Language Flow AI API",
    version: "0.1.0",
    description: [
      "四级词汇情景记忆短视频平台 API。",
      "",
      "**统一规范**（详见 docs/16_API接口规范与文档管理.md）：",
      "- 路径：/api 下 kebab-case，资源用复数名词",
      "- 错误格式：非 2xx 统一 `{ error, message?, code? }` 信封",
      "- 状态码：200/201/204 成功族 · 400/404/409 客户端错 · 500 服务端错",
      "- 所有端点由 @hono/zod-openapi 定义自动收录，覆盖度校验见 `pnpm openapi:check`",
    ].join("\n"),
  },
  servers: [{ url: "/", description: "同源部署（开发直连后端 / 生产经 nginx 反代）" }],
  tags: Object.values(API_TAGS).map((name) => ({ name })),
};
