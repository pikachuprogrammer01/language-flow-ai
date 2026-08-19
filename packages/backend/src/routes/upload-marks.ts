// 视频上传标记路由
// GET    /api/upload-marks        — 标记列表（可选按 videoFilename 过滤）
// POST   /api/upload-marks        — 新增标记（videoFilename + platform 必填，url/note 可选）
// PATCH  /api/upload-marks/:id    — 修改标记
// DELETE /api/upload-marks/:id    — 删除标记
// 语义：表示视频已上传到外部平台；一个视频可多条标记（多个平台）
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import { contents, uploadMarks } from "../db/schema";
import { resolveTaskIdByVideoFilename } from "../db/upload-marks-helper";

const UPLOADS_DIR = join(import.meta.dirname, "../../uploads");

const markSchema = z.object({
  videoFilename: z.string().min(1).max(100),
  platform: z.string().min(1).max(50),
  url: z.string().max(500).optional(),
  note: z.string().max(500).optional(),
  /** 关联任务 id（可选；不传则由后端按 videoFilename 自动反查绑定） */
  taskId: z.string().min(1).max(32).optional(),
});

const patchSchema = z.object({
  platform: z.string().min(1).max(50).optional(),
  url: z.string().max(500).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
});

/** 校验文件名：只允许 video 目录下的常规文件名（防路径穿越） */
function isValidVideoFilename(filename: string): boolean {
  return !filename.includes("..") && basename(filename) === filename;
}

export const uploadMarksRoute = new OpenAPIHono();

const listRoute = createRoute({
  method: "get",
  path: "/",
  request: {
    query: z.object({
      videoFilename: z.string().max(100).optional(),
    }),
  },
  responses: {
    200: {
      description: "上传标记列表",
      content: {
        "application/json": {
          schema: z.object({
            marks: z.array(
              z.object({
                id: z.string(),
                taskId: z.string().nullable(),
                videoFilename: z.string(),
                platform: z.string(),
                url: z.string().nullable(),
                note: z.string().nullable(),
                createdAt: z.string(),
                updatedAt: z.string(),
              }),
            ),
          }),
        },
      },
    },
  },
  tags: ["upload-marks"],
});

uploadMarksRoute.openapi(listRoute, async (c) => {
  const { videoFilename } = c.req.valid("query");
  const rows = await db
    .select()
    .from(uploadMarks)
    .where(videoFilename ? eq(uploadMarks.videoFilename, videoFilename) : undefined)
    .orderBy(desc(uploadMarks.createdAt));
  return c.json(
    {
      marks: rows.map((r) => ({
        id: r.id,
        taskId: r.taskId,
        videoFilename: r.videoFilename,
        platform: r.platform,
        url: r.url,
        note: r.note,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
    },
    200,
  );
});

const createRouteDef = createRoute({
  method: "post",
  path: "/",
  request: {
    body: {
      content: { "application/json": { schema: markSchema } },
    },
  },
  responses: {
    200: {
      description: "创建成功",
      content: {
        "application/json": {
          schema: z.object({
            id: z.string(),
            taskId: z.string().nullable(),
            videoFilename: z.string(),
            platform: z.string(),
            url: z.string().nullable(),
            note: z.string().nullable(),
            createdAt: z.string(),
            updatedAt: z.string(),
          }),
        },
      },
    },
    400: {
      description: "非法文件名 / 任务不存在",
      content: { "application/json": { schema: z.object({ error: z.string() }) } },
    },
    404: {
      description: "视频文件不存在",
      content: { "application/json": { schema: z.object({ error: z.string() }) } },
    },
  },
  tags: ["upload-marks"],
});

uploadMarksRoute.openapi(createRouteDef, async (c) => {
  const { videoFilename, platform, url, note, taskId: explicitTaskId } = c.req.valid("json");
  if (!isValidVideoFilename(videoFilename)) {
    return c.json({ error: "非法文件名" }, 400);
  }
  try {
    await stat(join(UPLOADS_DIR, "video", videoFilename));
  } catch {
    return c.json({ error: "视频文件不存在" }, 404);
  }
  // 关联任务：优先显式传入（校验存在，防止孤儿 task_id），否则按 videoFilename 自动反查
  let taskId: string | null = null;
  if (explicitTaskId) {
    const taskRows = await db
      .select({ id: contents.id })
      .from(contents)
      .where(eq(contents.id, explicitTaskId));
    if (taskRows.length === 0) return c.json({ error: "任务不存在" }, 400);
    taskId = explicitTaskId;
  } else {
    taskId = await resolveTaskIdByVideoFilename(videoFilename);
  }
  const id = randomUUID().replaceAll("-", "");
  await db.insert(uploadMarks).values({
    id,
    taskId,
    videoFilename,
    platform,
    url: url ?? null,
    note: note ?? null,
  });
  return c.json(
    {
      id,
      taskId,
      videoFilename,
      platform,
      url: url ?? null,
      note: note ?? null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    200,
  );
});

const patchRouteDef = createRoute({
  method: "patch",
  path: "/{id}",
  request: {
    params: z.object({ id: z.string().min(1).max(32) }),
    body: {
      content: { "application/json": { schema: patchSchema } },
    },
  },
  responses: {
    200: {
      description: "更新成功",
      content: {
        "application/json": {
          schema: z.object({
            success: z.boolean(),
          }),
        },
      },
    },
    400: {
      description: "无更新字段",
      content: { "application/json": { schema: z.object({ error: z.string() }) } },
    },
    404: {
      description: "标记不存在",
      content: { "application/json": { schema: z.object({ error: z.string() }) } },
    },
  },
  tags: ["upload-marks"],
});

uploadMarksRoute.openapi(patchRouteDef, async (c) => {
  const { id } = c.req.valid("param");
  const patch = c.req.valid("json");
  const values: { platform?: string; url?: string | null; note?: string | null } = {};
  if (patch.platform !== undefined) values.platform = patch.platform;
  if (patch.url !== undefined) values.url = patch.url ?? null;
  if (patch.note !== undefined) values.note = patch.note ?? null;
  if (Object.keys(values).length === 0) return c.json({ error: "无更新字段" }, 400);
  // 先确认存在：MySQL affectedRows 在值未变化时为 0，不能作为 404 判据（幂等更新）
  const existing = await db.select().from(uploadMarks).where(eq(uploadMarks.id, id));
  if (existing.length === 0) return c.json({ error: "标记不存在" }, 404);
  await db.update(uploadMarks).set(values).where(eq(uploadMarks.id, id));
  return c.json({ success: true }, 200);
});

const deleteRouteDef = createRoute({
  method: "delete",
  path: "/{id}",
  request: {
    params: z.object({ id: z.string().min(1).max(32) }),
  },
  responses: {
    200: {
      description: "删除成功",
      content: { "application/json": { schema: z.object({ success: z.boolean() }) } },
    },
    404: {
      description: "标记不存在",
      content: { "application/json": { schema: z.object({ error: z.string() }) } },
    },
  },
  tags: ["upload-marks"],
});

uploadMarksRoute.openapi(deleteRouteDef, async (c) => {
  const { id } = c.req.valid("param");
  const result = await db.delete(uploadMarks).where(eq(uploadMarks.id, id));
  if (result[0].affectedRows === 0) return c.json({ error: "标记不存在" }, 404);
  return c.json({ success: true }, 200);
});
