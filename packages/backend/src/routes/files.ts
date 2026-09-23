/**
 * 静态文件服务路由 — GET /files/{bgm|audio|video}/:filename
 * 提供 uploads/ 下的配音音频、成片视频、BGM 文件流（防路径穿越）
 * 规范化：改用 OpenAPIHono + createRoute，纳入 OpenAPI 文档体系（docs/16）
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

import { API_TAGS, apiErrorSchema } from "../lib/api-convention";
import { UPLOADS_DIR } from "../lib/uploads-path";

const filenameParam = z.object({ filename: z.string().min(1) });

/** 为每类媒体资源生成一条文档化 GET 路由（二进制流 + 统一错误信封） */
function mediaRoute(kind: "bgm" | "audio" | "video", mediaType: string, summary: string) {
  return createRoute({
    method: "get",
    path: `/${kind}/{filename}`,
    tags: [API_TAGS.files],
    operationId: `getFile${kind.charAt(0).toUpperCase()}${kind.slice(1)}`,
    summary,
    description: `流式返回 uploads/${kind}/ 下的文件，强缓存 1 年`,
    request: { params: filenameParam },
    responses: {
      200: {
        content: { [mediaType]: { schema: z.string() } },
        description: `文件二进制流（${mediaType}）`,
      },
      400: {
        content: { "application/json": { schema: apiErrorSchema } },
        description: "文件名不合法（含路径穿越字符）",
      },
      404: {
        content: { "application/json": { schema: apiErrorSchema } },
        description: "文件不存在",
      },
    },
  });
}

const bgmRoute = mediaRoute("bgm", "audio/mpeg", "获取 BGM 音乐文件");
const audioRoute = mediaRoute("audio", "audio/mpeg", "获取配音音频文件");
const videoRoute = mediaRoute("video", "video/mp4", "获取成片视频文件");

/** 读文件并返回带缓存头的二进制流；非法文件名 400，不存在 404 */
async function serveFile(
  c: {
    req: { param(name: "filename"): string };
    json(body: unknown, status?: number): Response;
  },
  kind: string,
) {
  const filename = c.req.param("filename");
  if (!filename || filename.includes("..")) {
    return c.json({ error: "Invalid filename" }, 400);
  }
  const filePath = join(UPLOADS_DIR, kind, filename);
  try {
    const buffer = await readFile(filePath);
    const mediaType = kind === "video" ? "video/mp4" : "audio/mpeg";
    return new Response(buffer, {
      headers: { "Content-Type": mediaType, "Cache-Control": "public, max-age=31536000" },
    });
  } catch {
    return c.json({ error: "File not found" }, 404);
  }
}

export const files = new OpenAPIHono()
  .openapi(bgmRoute, (c) => serveFile(c, "bgm"))
  .openapi(audioRoute, (c) => serveFile(c, "audio"))
  .openapi(videoRoute, (c) => serveFile(c, "video"));
