import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Context } from "hono";
import { rateLimiter } from "hono-rate-limiter";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { logger } from "./lib/logger";
import { health } from "./routes/health";

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

const app = new Hono();

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

// 错误处理中间件
app.onError((err, c) => {
  logger.error({ err, path: c.req.path, method: c.req.method }, "unhandled error");
  return c.json({ error: "Internal Server Error", message: err.message }, 500);
});

// 404 处理
app.notFound((c) => {
  return c.json({ error: "Not Found", path: c.req.path }, 404);
});

// CORS — 允许前端开发服务器跨域访问
app.use(
  "*",
  cors({
    origin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
    allowMethods: ["GET", "POST", "PUT", "DELETE"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
);

// Rate Limiting — 按 IP 限流，每分钟最多 100 次请求
app.use(
  "*",
  rateLimiter({
    windowMs: 60_000,
    limit: 100,
    standardHeaders: true,
    keyGenerator,
  }),
);

// 路由注册
app.route("/", health);

// ── 启动服务器 ──
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
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

export default app;
