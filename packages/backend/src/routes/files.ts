import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";

const uploadsDir = join(import.meta.dirname, "../../uploads");

// 静态文件服务 — 提供 uploads/ 下的音频和视频文件
export const files = new Hono()
  .get("/bgm/:filename", async (c) => {
    const filename = c.req.param("filename");
    if (!filename || filename.includes("..")) {
      return c.json({ error: "Invalid filename" }, 400);
    }
    const filePath = join(uploadsDir, "bgm", filename);
    try {
      const buffer = await readFile(filePath);
      return new Response(buffer, {
        headers: { "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=31536000" },
      });
    } catch {
      return c.json({ error: "File not found" }, 404);
    }
  })
  .get("/audio/:filename", async (c) => {
    const filename = c.req.param("filename");
    if (!filename || filename.includes("..")) {
      return c.json({ error: "Invalid filename" }, 400);
    }
    const filePath = join(uploadsDir, "audio", filename);
    try {
      const buffer = await readFile(filePath);
      return new Response(buffer, {
        headers: { "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=31536000" },
      });
    } catch {
      return c.json({ error: "File not found" }, 404);
    }
  })
  .get("/video/:filename", async (c) => {
    const filename = c.req.param("filename");
    if (!filename || filename.includes("..")) {
      return c.json({ error: "Invalid filename" }, 400);
    }
    const filePath = join(uploadsDir, "video", filename);
    try {
      const buffer = await readFile(filePath);
      return new Response(buffer, {
        headers: { "Content-Type": "video/mp4", "Cache-Control": "public, max-age=31536000" },
      });
    } catch {
      return c.json({ error: "File not found" }, 404);
    }
  });
