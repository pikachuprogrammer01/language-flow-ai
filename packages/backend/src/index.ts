import { Hono } from "hono";
import type { Context } from "hono";
import { rateLimiter } from "hono-rate-limiter";
import { cors } from "hono/cors";
import { logger } from "./lib/logger";
import { health } from "./routes/health";

const keyGenerator = (c: Context): string => {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? c.req.header("x-real-ip") ?? "unknown"
  );
};

const app = new Hono();

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

// 启动日志
logger.info({ env: process.env.NODE_ENV ?? "development" }, "Backend starting");

export default app;
