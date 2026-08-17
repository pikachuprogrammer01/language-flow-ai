/**
 * 任务（生成记录）管理路由
 * GET /api/tasks        — 列表（status 过滤 + 分页）
 * GET /api/tasks/:id    — 详情（ContentDTO 全量）
 * PATCH /api/tasks/:id  — 更新（title/video/audio/status，生成流程逐步回写）
 * DELETE /api/tasks/:id — 删除记录（文件保留，ponytail: 文件 GC 后续做）
 * 存储复用 contents 表（SPEC §十），generate 时自动建记录（见 content.ts）
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { contents } from "../db/schema";
import { logger } from "../lib/logger";

// ── Zod schema ──

const listQuerySchema = z.object({
  status: z
    .enum([
      "draft",
      "ai_generating",
      "content_ready",
      "tts_processing",
      "audio_ready",
      "video_rendering",
      "completed",
      "failed",
    ])
    .optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
});

const patchBodySchema = z.object({
  title: z.string().min(1).max(255).optional(),
  audio: z
    .object({
      url: z.string(),
      duration: z.number(),
      format: z.string(),
    })
    .optional(),
  video: z
    .object({
      url: z.string(),
      duration: z.number(),
      format: z.string(),
    })
    .optional(),
  status: z
    .enum([
      "draft",
      "ai_generating",
      "content_ready",
      "tts_processing",
      "audio_ready",
      "video_rendering",
      "completed",
      "failed",
    ])
    .optional(),
});

const idParamSchema = z.object({ id: z.string().min(1).max(32) });

/** 正文摘要：取第一段的 text 字段，截断 60 字 */
function summarizeContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const first = content.find(
    (seg): seg is { text?: unknown } => typeof seg === "object" && seg !== null && "text" in seg,
  );
  const text = typeof first?.text === "string" ? first.text : "";
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

const taskSummarySchema = z.object({
  id: z.string(),
  template: z.enum(["scene_word", "word_card", "quiz"]),
  title: z.string(),
  level: z.enum(["CET4", "CET6"]),
  status: z.string(),
  /** 词汇总数（列表即见内容，免进详情） */
  wordsCount: z.number(),
  /** 正文摘要：首段前 60 字 */
  textPreview: z.string(),
  audio: z.any().optional(),
  video: z.any().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ── 路由 ──

export const tasks = new OpenAPIHono();

const listRoute = createRoute({
  method: "get",
  path: "/",
  request: { query: listQuerySchema },
  responses: {
    200: {
      description: "任务列表",
      content: {
        "application/json": {
          schema: z.object({
            tasks: z.array(taskSummarySchema),
            total: z.number(),
          }),
        },
      },
    },
    500: { description: "查询任务列表失败" },
  },
  tags: ["tasks"],
});

tasks.openapi(listRoute, async (c) => {
  const { status, page, pageSize } = c.req.valid("query");
  try {
    const rows = await db
      .select()
      .from(contents)
      .where(status ? eq(contents.status, status) : undefined)
      .orderBy(desc(contents.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    const totalRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(contents)
      .where(status ? eq(contents.status, status) : undefined);
    const total = Number(totalRows[0]?.count ?? 0);
    return c.json({
      tasks: rows.map((r) => ({
        id: r.id,
        template: r.template,
        title: r.title,
        level: r.level,
        status: r.status,
        wordsCount: Array.isArray(r.words) ? r.words.length : 0,
        textPreview: summarizeContent(r.content),
        audio: r.audio ?? undefined,
        video: r.video ?? undefined,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
      total,
    });
  } catch (e) {
    logger.error({ err: e }, "查询任务列表失败");
    return c.json({ error: "查询任务列表失败" }, 500);
  }
});

const detailRoute = createRoute({
  method: "get",
  path: "/:id",
  request: { params: idParamSchema },
  responses: {
    200: {
      description: "任务详情（ContentDTO 全量）",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    404: { description: "任务不存在" },
  },
  tags: ["tasks"],
});

tasks.openapi(detailRoute, async (c) => {
  const { id } = c.req.valid("param");
  try {
    const rows = await db.select().from(contents).where(eq(contents.id, id)).limit(1);
    if (rows.length === 0) return c.json({ error: "任务不存在" }, 404);
    return c.json(rows[0]);
  } catch (e) {
    logger.error({ err: e, id }, "查询任务详情失败");
    return c.json({ error: "查询任务详情失败" }, 500);
  }
});

const patchRoute = createRoute({
  method: "patch",
  path: "/:id",
  request: {
    params: idParamSchema,
    body: { content: { "application/json": { schema: patchBodySchema } } },
  },
  responses: {
    200: {
      description: "更新成功",
      content: { "application/json": { schema: z.record(z.string(), z.unknown()) } },
    },
    404: { description: "任务不存在" },
  },
  tags: ["tasks"],
});

tasks.openapi(patchRoute, async (c) => {
  const { id } = c.req.valid("param");
  const body = c.req.valid("json");
  try {
    const rows = await db.select().from(contents).where(eq(contents.id, id)).limit(1);
    if (rows.length === 0) return c.json({ error: "任务不存在" }, 404);
    await db
      .update(contents)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(contents.id, id));
    const after = await db.select().from(contents).where(eq(contents.id, id)).limit(1);
    return c.json(after[0]);
  } catch (e) {
    logger.error({ err: e, id }, "更新任务失败");
    return c.json({ error: "更新任务失败" }, 500);
  }
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/:id",
  request: { params: idParamSchema },
  responses: {
    200: {
      description: "删除成功",
      content: { "application/json": { schema: z.object({ success: z.boolean() }) } },
    },
    404: { description: "任务不存在" },
  },
  tags: ["tasks"],
});

tasks.openapi(deleteRoute, async (c) => {
  const { id } = c.req.valid("param");
  try {
    const rows = await db.select().from(contents).where(eq(contents.id, id)).limit(1);
    if (rows.length === 0) return c.json({ error: "任务不存在" }, 404);
    await db.delete(contents).where(eq(contents.id, id));
    return c.json({ success: true });
  } catch (e) {
    logger.error({ err: e, id }, "删除任务失败");
    return c.json({ error: "删除任务失败" }, 500);
  }
});
