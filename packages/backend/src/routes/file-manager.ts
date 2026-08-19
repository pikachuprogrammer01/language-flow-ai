import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
/**
 * 上传文件管理路由
 * GET    /api/files            — uploads 下音频/视频文件列表（含是否被生成记录引用）
 * DELETE /api/files/:filename  — 删除文件（按扩展名判断目录，防路径穿越）
 * 契约：PRD §10.1.5 视频 CRUD 的文件层（记录删除不自动删文件，由本接口管理）
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { contents, uploadMarks } from "../db/schema";
import { logger } from "../lib/logger";

const UPLOADS_DIR = join(import.meta.dirname, "../../uploads");

/** 文件分类 = uploads 子目录（audio=配音 / video=成片 / bgm=素材） */
export const FILE_TYPES = ["audio", "video", "bgm"] as const;
export type FileType = (typeof FILE_TYPES)[number];

/** 收集生成记录引用的文件名与引用记录（audio/video URL 的 basename），用于 inUse + 引用详情 */
async function referencedFiles(): Promise<Map<string, { id: string; title: string }[]>> {
  const rows = await db
    .select({
      id: contents.id,
      title: contents.title,
      audio: contents.audio,
      video: contents.video,
    })
    .from(contents);
  const refs = new Map<string, { id: string; title: string }[]>();
  for (const r of rows) {
    for (const field of [r.audio, r.video]) {
      if (field && typeof field === "object" && "url" in field) {
        const url = String(field.url ?? "");
        if (!url.startsWith("/files/")) continue;
        const name = basename(url);
        const list = refs.get(name) ?? [];
        list.push({ id: r.id, title: r.title });
        refs.set(name, list);
      }
    }
  }
  return refs;
}

export const fileManager = new OpenAPIHono();

const listRoute = createRoute({
  method: "get",
  path: "/",
  request: { query: z.object({ type: z.enum(FILE_TYPES).optional() }) },
  responses: {
    200: {
      description: "文件列表",
      content: {
        "application/json": {
          schema: z.object({
            files: z.array(
              z.object({
                filename: z.string(),
                type: z.enum(FILE_TYPES),
                size: z.number(),
                mtime: z.string(),
                inUse: z.boolean(),
                referencedBy: z.array(z.object({ id: z.string(), title: z.string() })),
              }),
            ),
          }),
        },
      },
    },
    500: { description: "查询失败" },
  },
  tags: ["files"],
});

fileManager.openapi(listRoute, async (c) => {
  const { type } = c.req.valid("query");
  try {
    const refs = await referencedFiles();
    const files: {
      filename: string;
      type: FileType;
      size: number;
      mtime: string;
      inUse: boolean;
      referencedBy: { id: string; title: string }[];
    }[] = [];
    for (const dir of FILE_TYPES) {
      if (type && type !== dir) continue;
      const dirPath = join(UPLOADS_DIR, dir);
      const names = await readdir(dirPath).catch(() => []);
      for (const name of names) {
        const fileType = dir;
        try {
          const info = await stat(join(dirPath, name));
          files.push({
            filename: name,
            type: fileType,
            size: info.size,
            mtime: info.mtime.toISOString(),
            inUse: refs.has(name),
            referencedBy: refs.get(name) ?? [],
          });
        } catch {
          // 文件已被删除，跳过
        }
      }
    }
    files.sort((a, b) => b.mtime.localeCompare(a.mtime));
    return c.json({ files });
  } catch (e) {
    logger.error({ err: e }, "查询文件列表失败");
    return c.json({ error: "查询文件列表失败" }, 500);
  }
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/{filename}",
  request: {
    params: z.object({ filename: z.string().min(1).max(100) }),
    query: z.object({ type: z.enum(FILE_TYPES) }),
  },
  responses: {
    200: {
      description: "删除成功",
      content: { "application/json": { schema: z.object({ success: z.boolean() }) } },
    },
    400: { description: "非法文件名" },
    404: { description: "文件不存在" },
  },
  tags: ["files"],
});

fileManager.openapi(deleteRoute, async (c) => {
  const { filename } = c.req.valid("param");
  const { type } = c.req.valid("query");
  // 防路径穿越：只允许对应分类目录下的常规文件名
  if (filename.includes("..") || basename(filename) !== filename) {
    return c.json({ error: "非法文件名" }, 400);
  }
  const filePath = join(UPLOADS_DIR, type, filename);
  try {
    await rm(filePath, { force: false });
  } catch {
    return c.json({ error: "文件不存在" }, 404);
  }
  // 删除联动：清理该文件的上传标记（video 分类），防脏数据；
  // 单独 try-catch：标记清理失败不阻断删除结果，只记日志（避免误报文件不存在）
  if (type === "video") {
    try {
      await db.delete(uploadMarks).where(eq(uploadMarks.videoFilename, filename));
    } catch (e) {
      logger.warn({ err: e, filename }, "清理上传标记失败（文件已删除）");
    }
  }
  return c.json({ success: true });
});

// ── 批量删除（文件管理批量处理） ──

const batchDeleteRoute = createRoute({
  method: "post",
  path: "/batch-delete",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            items: z
              .array(z.object({ filename: z.string().min(1).max(100), type: z.enum(FILE_TYPES) }))
              .min(1)
              .max(100),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "批量删除结果（已删除 / 不存在 / 失败）",
      content: {
        "application/json": {
          schema: z.object({
            deleted: z.number(),
            notFound: z.array(z.string()),
            errors: z.array(z.object({ filename: z.string(), reason: z.string() })),
          }),
        },
      },
    },
  },
  tags: ["files"],
});

fileManager.openapi(batchDeleteRoute, async (c) => {
  const { items } = c.req.valid("json");
  const deleted: string[] = [];
  const notFound: string[] = [];
  const errors: { filename: string; reason: string }[] = [];
  for (const { filename, type } of items) {
    if (filename.includes("..") || basename(filename) !== filename) {
      errors.push({ filename, reason: "非法文件名" });
      continue;
    }
    try {
      await rm(join(UPLOADS_DIR, type, filename), { force: false });
      // 删除联动：清理该文件的上传标记（video 分类），防脏数据；失败只记日志不阻断
      if (type === "video") {
        try {
          await db.delete(uploadMarks).where(eq(uploadMarks.videoFilename, filename));
        } catch (e) {
          logger.warn({ err: e, filename }, "清理上传标记失败（文件已删除）");
        }
      }
      deleted.push(filename);
    } catch {
      notFound.push(filename); // 已删除/不存在视为幂等跳过
    }
  }
  return c.json({ deleted: deleted.length, notFound, errors });
});

// ── 在 Finder 中显示视频（宿主机桥） ──
// 容器内无法调用 macOS Finder：后端把宿主机路径写进 .open-requests/ 标记文件，
// 宿主机 launchd 脚本（scripts/reveal-watcher.sh）收到后执行 open -R 定位视频。

const revealRoute = createRoute({
  method: "post",
  path: "/reveal",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            /** 视频 URL，形如 /files/video/<uuid>.mp4 */
            url: z.string().min(1).max(200),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "已请求在 Finder 中打开",
      content: { "application/json": { schema: z.object({ ok: z.boolean() }) } },
    },
    400: { description: "非法 URL" },
    404: { description: "文件不存在" },
    501: { description: "未配置 HOST_UPLOADS_DIR" },
  },
  tags: ["files"],
});

fileManager.openapi(revealRoute, async (c) => {
  const { url } = c.req.valid("json");
  // 只允许 video 目录下的常规文件名（防路径穿越）
  const prefix = "/files/video/";
  if (!url.startsWith(prefix)) {
    return c.json({ error: "仅支持视频文件" }, 400);
  }
  const filename = url.slice(prefix.length);
  if (!filename || filename.includes("..") || basename(filename) !== filename) {
    return c.json({ error: "非法文件名" }, 400);
  }
  try {
    await stat(join(UPLOADS_DIR, "video", filename));
  } catch {
    return c.json({ error: "文件不存在" }, 404);
  }
  const hostUploadsDir = process.env.HOST_UPLOADS_DIR;
  if (!hostUploadsDir) {
    return c.json({ error: "未配置 HOST_UPLOADS_DIR，无法定位宿主机路径" }, 501);
  }
  const reqDir = join(UPLOADS_DIR, ".open-requests");
  await mkdir(reqDir, { recursive: true });
  await writeFile(
    join(reqDir, `${Date.now()}-${filename}.req`),
    join(hostUploadsDir, "video", filename),
  );
  return c.json({ ok: true });
});
