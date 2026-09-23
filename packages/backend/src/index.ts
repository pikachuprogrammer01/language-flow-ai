import { serve } from "@hono/node-server";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { rateLimiter } from "hono-rate-limiter";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { OPENAPI_DOC_BASE } from "./lib/api-convention";
import { registerApiDocs } from "./lib/api-docs";
import { logger } from "./lib/logger";
import { cet } from "./routes/cet";
import { content } from "./routes/content";
import { dashboard } from "./routes/dashboard";
import { fileManager } from "./routes/file-manager";
import { files } from "./routes/files";
import { health } from "./routes/health";
import { llm } from "./routes/llm";
import { tasks } from "./routes/tasks";
import { topics } from "./routes/topics";
import { tts } from "./routes/tts";
import { uploadMarksRoute } from "./routes/upload-marks";
import { video } from "./routes/video";
import { videoAnalyticsRoute } from "./routes/video-analytics";

// ── 环境变量校验 ──
const requiredEnvVars = ["DATABASE_URL"] as const;
for (const key of requiredEnvVars) {
  if (!process.env[key]) {
    logger.fatal({ key }, "Missing required environment variable");
    process.exit(1);
  }
}

const keyGenerator = (c: Context): string => {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? c.req.header("x-real-ip") ?? "unknown"
  );
};

const app = new OpenAPIHono();

// 请求日志中间件
app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  logger.info(
    { method: c.req.method, path: c.req.path, status: c.res.status, elapsed: Date.now() - start },
    "request",
  );
});

// 请求体大小限制 — 10MB
app.use("*", bodyLimit({ maxSize: 10 * 1024 * 1024 }));

// 错误处理中间件 — 统一错误信封 { error, message?, code? }（docs/16）
app.onError((err, c) => {
  logger.error({ err, path: c.req.path, method: c.req.method }, "unhandled error");
  return c.json({ error: "Internal Server Error", message: err.message, code: "INTERNAL" }, 500);
});

// 404 处理
app.notFound((c) => {
  return c.json(
    { error: "Not Found", message: `路由不存在：${c.req.method} ${c.req.path}`, code: "NOT_FOUND" },
    404,
  );
});

// CORS — 允许前端开发服务器跨域访问
app.use(
  "*",
  cors({
    origin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

// Rate Limiting — 按 IP 限流，每分钟最多 100 次（仅生产启用；本地开发不限制，避免页面操作/调试触发 429）
if (process.env.NODE_ENV === "production") {
  app.use(
    "*",
    rateLimiter({
      windowMs: 60_000,
      limit: 100,
      standardHeaders: true,
      keyGenerator,
      // 工作台只读聚合端点豁免：前端 500ms 生命周期轮询（120 次/分）会击穿常规限额，
      // 该端点无写入、查询成本固定，不依赖限流防护
      skip: (c) => c.req.path === "/api/dashboard/summary",
    }),
  );
}

// 路由注册
app.route("/", health);
app.route("/api/cet", cet);
app.route("/api/content", content);
app.route("/api/tts", tts);
app.route("/api/video", video);
app.route("/api/tasks", tasks);
app.route("/api/topics", topics);
app.route("/api/files", fileManager);
app.route("/api/upload-marks", uploadMarksRoute);
app.route("/api/llm", llm);
app.route("/api/dashboard", dashboard);
app.route("/api/video-analytics", videoAnalyticsRoute);
app.route("/files", files);

// ── OpenAPI 文档体系（docs/16）──
// GET /doc → OpenAPI 3.1 JSON；GET /doc/ → 自托管 Swagger UI（本地资源，离线可用）+ 返回管理界面导航
app.doc("/doc", OPENAPI_DOC_BASE);
registerApiDocs(app);

// openapi.json 落盘由显式脚本生成：pnpm openapi:gen（lefthook pre-commit backend 变更时自动重生成）

// ── 启动服务器 ──
const port = Number.parseInt(process.env.PORT ?? "8080", 10);
const server = serve({ fetch: app.fetch, port }, (info) => {
  logger.info({ port: info.port, env: process.env.NODE_ENV ?? "development" }, "server started");
});

// ── 优雅关闭 ──
const shutdown = (signal: string) => {
  logger.info({ signal }, "shutting down");
  server.close(() => {
    logger.info("server closed");
    process.exit(0);
  });
  // 强制退出超时
  setTimeout(() => {
    logger.error("forced shutdown after timeout");
    process.exit(1);
  }, 10_000);
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// 命名导出供测试/脚本收尾 listen 句柄（覆盖度测试 afterAll close）
export { app, server };
export default app;
