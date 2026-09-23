/**
 * 静态文件服务路由单测 — GET /files/{video|audio|bgm}/:filename
 * 真实 fs：临时 UPLOADS_DIR 造素材文件（env 注入须在模块导入前，故用动态 import）
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const dir = await mkdtemp(join(tmpdir(), "lf-files-route-"));
process.env.UPLOADS_DIR = dir;
const { files } = await import("../routes/files");

beforeAll(async () => {
  for (const kind of ["video", "audio", "bgm"] as const) {
    await mkdir(join(dir, kind), { recursive: true });
    await writeFile(join(dir, kind, "ok.mp4"), "fake-bytes");
    await writeFile(join(dir, kind, "ok.mp3"), "fake-bytes");
  }
});

describe("GET /files/:kind/:filename", () => {
  it("video 命中：200 + video/mp4 + 长缓存头", async () => {
    const res = await files.request("/video/ok.mp4");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("video/mp4");
    expect(res.headers.get("Cache-Control")).toContain("max-age=31536000");
    expect(await res.text()).toBe("fake-bytes");
  });

  it("audio/bgm 命中：audio/mpeg", async () => {
    expect((await files.request("/audio/ok.mp3")).headers.get("Content-Type")).toBe("audio/mpeg");
    expect((await files.request("/bgm/ok.mp3")).status).toBe(200);
  });

  it("文件不存在：404 错误信封", async () => {
    const res = await files.request("/video/missing.mp4");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain("not found");
  });

  it("未声明的路径段（如 .txt 扩展）不在路由表：404", async () => {
    const res = await files.request("/video/ok.txt");
    expect(res.status).toBe(404);
  });
});
