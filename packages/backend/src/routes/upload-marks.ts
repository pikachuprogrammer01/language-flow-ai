// 视频上传标记路由
// GET    /api/upload-marks           — 标记列表（可选按 videoFilename 过滤）
// GET    /api/upload-marks/overview  — 一览页（标记 + 关联视频信息，支持 platform/keyword）
// POST   /api/upload-marks           — 新增标记（videoFilename + platform 必填，url/note 可选）
// PATCH  /api/upload-marks/:id       — 修改标记
// DELETE /api/upload-marks/:id       — 删除标记
// 语义：表示视频已上传到外部平台；一个视频可多条标记（多个平台）
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { contents, uploadMarks } from "../db/schema";
import { resolveTaskIdByVideoFilename } from "../db/upload-marks-helper";
import { API_TAGS } from "../lib/api-convention";
import { logger } from "../lib/logger";
import { derivePublishIntent } from "../lib/publish-derivation";
import {
  type MarkDeriveOutcome,
  upsertPublishRecordFromMark,
} from "../services/analytics-metrics.service";

import { UPLOADS_DIR } from "../lib/uploads-path";

/** 标记派生发布记录的结果说明（响应可见，不静默） */
const PUBLISH_OUTCOME_HINT: Record<MarkDeriveOutcome, string> = {
  created: "已按标记登记发布记录",
  filled: "已补齐既有发布记录的空位字段",
  unchanged: "既有发布记录无需变更",
  "skipped-no-content": "该标记未绑定生成记录，无法登记发布记录",
  "conflict-work-id-owned": "该作品链接已被另一条记录占用，未覆盖",
};

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

/** 一览页关联视频信息（来自 contents） */
const overviewVideoSchema = z.object({
  title: z.string(),
  template: z.enum(["scene_word", "word_card", "quiz"]),
  level: z.enum(["CET4", "CET6"]),
  wordsCount: z.number(),
  duration: z.number().nullable(),
});

const overviewMarkSchema = z.object({
  id: z.string(),
  taskId: z.string().nullable(),
  videoFilename: z.string(),
  platform: z.string(),
  url: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  video: overviewVideoSchema.nullable(),
});

/** 校验文件名：只允许 video 目录下的常规文件名（防路径穿越） */
function isValidVideoFilename(filename: string): boolean {
  return !filename.includes("..") && basename(filename) === filename;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** 派生发布记录用的生成标题（读不到内容时返回 null，不造标题） */
async function readContentTitle(tx: Tx, contentId: string): Promise<string | null> {
  const [row] = await tx
    .select({ title: contents.title })
    .from(contents)
    .where(eq(contents.id, contentId))
    .limit(1);
  return row?.title ?? null;
}

/** 从 contents.video JSON 提取文件名 */
function videoFilenameFromTask(video: unknown): string | null {
  if (video && typeof video === "object" && "url" in video && typeof video.url === "string") {
    return video.url.split("/").pop() ?? null;
  }
  return null;
}

/** 从 contents.video JSON 提取时长 */
function videoDurationFromTask(video: unknown): number | null {
  if (video && typeof video === "object" && "duration" in video) {
    const d = Number((video as { duration?: unknown }).duration);
    return Number.isFinite(d) ? d : null;
  }
  return null;
}

type MarkRow = {
  id: string;
  taskId: string | null;
  videoFilename: string;
  platform: string;
  url: string | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type TaskRow = {
  id: string;
  title: string;
  template: "scene_word" | "word_card" | "quiz";
  level: "CET4" | "CET6";
  words: unknown;
  video: unknown;
};

export type OverviewMark = z.infer<typeof overviewMarkSchema>;

/** 组装一览行：taskId 优先，其次按 videoFilename 回退；支持 platform/keyword 过滤 */
export function buildUploadMarksOverview(
  markRows: MarkRow[],
  taskRows: TaskRow[],
  filters: { platform?: string; keyword?: string } = {},
): OverviewMark[] {
  const byId = new Map(taskRows.map((t) => [t.id, t]));
  const byFilename = new Map<string, TaskRow>();
  for (const t of taskRows) {
    const name = videoFilenameFromTask(t.video);
    if (name) byFilename.set(name, t);
  }
  const kw = filters.keyword?.trim().toLowerCase() ?? "";
  const out: OverviewMark[] = [];
  for (const m of markRows) {
    if (filters.platform && m.platform !== filters.platform) continue;
    const task = (m.taskId ? byId.get(m.taskId) : undefined) ?? byFilename.get(m.videoFilename);
    const video = task
      ? {
          title: task.title,
          template: task.template,
          level: task.level,
          wordsCount: Array.isArray(task.words) ? task.words.length : 0,
          duration: videoDurationFromTask(task.video),
        }
      : null;
    if (kw) {
      const hay = [
        m.platform,
        m.url ?? "",
        m.note ?? "",
        m.videoFilename,
        video?.title ?? "",
        video?.level ?? "",
      ]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(kw)) continue;
    }
    out.push({
      id: m.id,
      taskId: m.taskId,
      videoFilename: m.videoFilename,
      platform: m.platform,
      url: m.url,
      note: m.note,
      createdAt: m.createdAt.toISOString(),
      updatedAt: m.updatedAt.toISOString(),
      video,
    });
  }
  return out;
}

export const uploadMarksRoute = new OpenAPIHono();

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: [API_TAGS.uploadMarks],
  operationId: "listUploadMarks",
  summary: "上传标记列表（按视频文件名）",
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

const overviewRoute = createRoute({
  method: "get",
  path: "/overview",
  tags: [API_TAGS.uploadMarks],
  operationId: "getUploadMarksOverview",
  summary: "上传标记一览（关联任务元数据）",
  request: {
    query: z.object({
      platform: z.string().max(50).optional(),
      keyword: z.string().max(100).optional(),
    }),
  },
  responses: {
    200: {
      description: "上传标记一览（含关联视频信息）",
      content: {
        "application/json": {
          schema: z.object({
            marks: z.array(overviewMarkSchema),
            platforms: z.array(z.string()),
          }),
        },
      },
    },
  },
});

uploadMarksRoute.openapi(overviewRoute, async (c) => {
  const { platform, keyword } = c.req.valid("query");
  const markRows = await db.select().from(uploadMarks).orderBy(desc(uploadMarks.createdAt));
  const taskRows = await db
    .select({
      id: contents.id,
      title: contents.title,
      template: contents.template,
      level: contents.level,
      words: contents.words,
      video: contents.video,
    })
    .from(contents)
    .where(sql`${contents.video} is not null`);
  const marks = buildUploadMarksOverview(markRows, taskRows, { platform, keyword });
  const platforms = [...new Set(markRows.map((m) => m.platform))].sort();
  return c.json({ marks, platforms }, 200);
});

const createRouteDef = createRoute({
  method: "post",
  path: "/",
  tags: [API_TAGS.uploadMarks],
  operationId: "createUploadMark",
  summary: "新增上传标记",
  request: {
    body: {
      content: { "application/json": { schema: markSchema } },
    },
  },
  responses: {
    200: {
      description: "创建成功（并按标记派生发布记录，结果见 publishRecord）",
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
            publishRecord: z.enum([
              "created",
              "filled",
              "unchanged",
              "skipped-no-content",
              "conflict-work-id-owned",
            ]),
            publishRecordHint: z.string(),
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
    500: {
      description: "标记或派生发布记录失败（同事务整体回滚，标记不会单独落库）",
      content: { "application/json": { schema: z.object({ error: z.string() }) } },
    },
  },
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
  const now = new Date();
  let outcome: MarkDeriveOutcome = "skipped-no-content";
  try {
    await db.transaction(async (tx) => {
      await tx
        .insert(uploadMarks)
        .values({ id, taskId, videoFilename, platform, url: url ?? null, note: note ?? null });
      outcome = await upsertPublishRecordFromMark(
        tx,
        derivePublishIntent({
          contentId: taskId,
          platform,
          url: url ?? null,
          videoFilename,
          markedAt: now,
          contentTitle: taskId ? await readContentTitle(tx, taskId) : null,
        }),
      );
    });
  } catch (e) {
    logger.error({ err: e }, "上传标记或派生发布记录失败");
    return c.json({ error: "标记失败，未保存" }, 500);
  }
  return c.json(
    {
      id,
      taskId,
      videoFilename,
      platform,
      url: url ?? null,
      note: note ?? null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      publishRecord: outcome,
      publishRecordHint: PUBLISH_OUTCOME_HINT[outcome],
    },
    200,
  );
});

const patchRouteDef = createRoute({
  method: "patch",
  path: "/{id}",
  tags: [API_TAGS.uploadMarks],
  operationId: "updateUploadMark",
  summary: "更新上传标记备注",
  request: {
    params: z.object({ id: z.string().min(1).max(32) }),
    body: {
      content: { "application/json": { schema: patchSchema } },
    },
  },
  responses: {
    200: {
      description: "更新成功（并按需补派生发布记录）",
      content: {
        "application/json": {
          schema: z.object({
            success: z.boolean(),
            publishRecord: z.enum([
              "created",
              "filled",
              "unchanged",
              "skipped-no-content",
              "conflict-work-id-owned",
            ]),
            publishRecordHint: z.string(),
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
    500: {
      description: "更新或派生发布记录失败（同事务整体回滚）",
      content: { "application/json": { schema: z.object({ error: z.string() }) } },
    },
  },
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
  const mark = existing[0];
  // 改平台/改链接可能引入新的发布事实（如抖音→快手）：同规则再派生一次，幂等；
  // 旧平台的既有记录保留为历史，不级联删（指标挂在发布记录上，删了会连带毁掉已导入数据）
  let outcome: MarkDeriveOutcome = "skipped-no-content";
  try {
    await db.transaction(async (tx) => {
      await tx.update(uploadMarks).set(values).where(eq(uploadMarks.id, id));
      const contentId = mark.taskId;
      outcome = await upsertPublishRecordFromMark(
        tx,
        derivePublishIntent({
          contentId,
          platform: values.platform ?? mark.platform,
          url: values.url !== undefined ? values.url : mark.url,
          videoFilename: mark.videoFilename,
          markedAt: new Date(),
          contentTitle: contentId ? await readContentTitle(tx, contentId) : null,
        }),
      );
    });
  } catch (e) {
    logger.error({ err: e }, "更新上传标记或派生发布记录失败");
    return c.json({ error: "更新失败，未保存" }, 500);
  }
  return c.json(
    { success: true, publishRecord: outcome, publishRecordHint: PUBLISH_OUTCOME_HINT[outcome] },
    200,
  );
});

const deleteRouteDef = createRoute({
  method: "delete",
  path: "/{id}",
  tags: [API_TAGS.uploadMarks],
  operationId: "deleteUploadMark",
  summary: "删除上传标记",
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
});

uploadMarksRoute.openapi(deleteRouteDef, async (c) => {
  const { id } = c.req.valid("param");
  const result = await db.delete(uploadMarks).where(eq(uploadMarks.id, id));
  if (result[0].affectedRows === 0) return c.json({ error: "标记不存在" }, 404);
  return c.json({ success: true }, 200);
});
