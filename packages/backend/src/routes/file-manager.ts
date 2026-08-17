import { readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
/**
 * 上传文件管理路由
 * GET    /api/files            — uploads 下音频/视频文件列表（含是否被生成记录引用）
 * DELETE /api/files/:filename  — 删除文件（按扩展名判断目录，防路径穿越）
 * 契约：PRD §10.1.5 视频 CRUD 的文件层（记录删除不自动删文件，由本接口管理）
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { db } from "../db";
import { contents } from "../db/schema";
import { logger } from "../lib/logger";

const UPLOADS_DIR = join(import.meta.dirname, "../../uploads");

/** 按扩展名判断文件类型与所属目录 */
function typeOf(filename: string): "audio" | "video" | null {
  if (filename.endsWith(".mp3")) return "audio";
  if (filename.endsWith(".mp4")) return "video";
  return null;
}

/** 收集生成记录引用的文件名（audio/video URL 的 basename），用于 inUse 标记 */
async function referencedFiles(): Promise<Set<string>> {
  const rows = await db.select({ audio: contents.audio, video: contents.video }).from(contents);
  const refs = new Set<string>();
  for (const r of rows) {
    for (const field of [r.audio, r.video]) {
      if (field && typeof field === "object" && "url" in field) {
        const url = String(field.url ?? "");
        if (url.startsWith("/files/")) refs.add(basename(url));
      }
    }
  }
  return refs;
}

export const fileManager = new OpenAPIHono();

const listRoute = createRoute({
  method: "get",
  path: "/",
  request: { query: z.object({ type: z.enum(["audio", "video"]).optional() }) },
  responses: {
    200: {
      description: "文件列表",
      content: {
        "application/json": {
          schema: z.object({
            files: z.array(
              z.object({
                filename: z.string(),
                type: z.enum(["audio", "video"]),
                size: z.number(),
                mtime: z.string(),
                inUse: z.boolean(),
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
      type: "audio" | "video";
      size: number;
      mtime: string;
      inUse: boolean;
    }[] = [];
    for (const dir of ["audio", "video"] as const) {
      if (type && type !== dir) continue;
      const dirPath = join(UPLOADS_DIR, dir);
      const names = await readdir(dirPath).catch(() => []);
      for (const name of names) {
        const fileType = typeOf(name);
        if (!fileType) continue;
        try {
          const info = await stat(join(dirPath, name));
          files.push({
            filename: name,
            type: fileType,
            size: info.size,
            mtime: info.mtime.toISOString(),
            inUse: refs.has(name),
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
  request: { params: z.object({ filename: z.string().min(1).max(100) }) },
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
  const fileType = typeOf(filename);
  // 防路径穿越：只允许 uploads/audio|video 下的常规文件名
  if (!fileType || filename.includes("..") || basename(filename) !== filename) {
    return c.json({ error: "非法文件名" }, 400);
  }
  const filePath = join(UPLOADS_DIR, fileType, filename);
  try {
    await rm(filePath, { force: false });
    return c.json({ success: true });
  } catch {
    return c.json({ error: "文件不存在" }, 404);
  }
});
