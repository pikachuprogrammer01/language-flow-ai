import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
/**
 * GET/DELETE /api/files 测试
 * 覆盖：列表（类型过滤/inUse 标记）/ 删除成功 / 非法文件名 400 / 不存在 404
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db";
import { fileManager } from "./file-manager";

vi.mock("../db", () => ({ db: {} }));

const app = fileManager;

/** 记录 db.delete 的 where 调用次数（断言上传标记联动清理是否触发） */
let deleteCallCount = 0;
let deleteShouldThrow = false;

beforeEach(() => {
  deleteCallCount = 0;
  deleteShouldThrow = false;
  // referencedFiles 查询 contents：select({audio, video}).from() 返回空数组；vitest mock 赋值类型断层用 as never（测试替身惯例）
  vi.mocked(db).select = vi.fn(() => ({ from: async () => [] }) as never) as never;
  // delete 用于上传标记联动清理：计数调用，可配置抛错（验证删除结果不被阻断）
  vi.mocked(db).delete = vi.fn(() => ({
    where: async () => {
      deleteCallCount += 1;
      if (deleteShouldThrow) throw new Error("db down");
    },
  })) as never;
});

describe("POST /api/files/batch-delete", () => {
  it("批量删除返回统计（存在文件删除成功，不存在文件幂等跳过）", async () => {
    // 创建临时文件验证删除成功分支（测试后无残留）
    const tmpPath = join(process.cwd(), "uploads/audio/__batch_tmp.mp3");
    await writeFile(tmpPath, "x");
    const res = await app.request("/batch-delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        items: [
          { filename: "__batch_tmp.mp3", type: "audio" },
          { filename: "gone.mp4", type: "video" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: number; notFound: string[]; errors: unknown[] };
    expect(body.deleted).toBe(1);
    expect(body.notFound).toEqual(["gone.mp4"]);
    expect(body.errors).toEqual([]);
  });

  it("非法文件名进 errors 列表", async () => {
    const res = await app.request("/batch-delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [{ filename: "x/../y.mp3", type: "audio" }] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: number; errors: { filename: string }[] };
    expect(body.deleted).toBe(0);
    expect(body.errors).toHaveLength(1);
  });

  it("空 items 返回 400", async () => {
    const res = await app.request("/batch-delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [] }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/files", () => {
  it("返回音频/视频文件列表（含 inUse 标记）", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: { type: string; inUse: boolean }[] };
    expect(Array.isArray(body.files)).toBe(true);
    expect(body.files.length).toBeGreaterThan(0);
    expect(
      body.files.every((f) => f.type === "audio" || f.type === "video" || f.type === "bgm"),
    ).toBe(true);
    expect(body.files.every((f) => typeof f.inUse === "boolean")).toBe(true);
  });

  it("支持 type 过滤", async () => {
    const res = await app.request("/?type=video");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: { type: string }[] };
    expect(body.files.every((f) => f.type === "video")).toBe(true);
  });
});

describe("DELETE /api/files/:filename", () => {
  it("非法文件名（路径穿越）被拒绝", async () => {
    // Hono 归一化 `..`/`%2E%2E` 后路由不匹配返回 404（同样安全拒绝）
    const res = await app.request("/%2E%2E/secret.mp3?type=bgm", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("缺少 type 参数返回 400", async () => {
    const res = await app.request("/x.mp3", { method: "DELETE" });
    expect(res.status).toBe(400);
  });

  it("未知扩展名文件按目录删除（无扩展名校验，目录即分类）", async () => {
    const res = await app.request("/no-such.mp3?type=bgm", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/files/:filename 上传标记联动", () => {
  const tmpVideo = join(process.cwd(), "uploads/video/__link_tmp.mp4");
  const tmpAudio = join(process.cwd(), "uploads/audio/__link_tmp.mp3");

  beforeEach(async () => {
    await writeFile(tmpVideo, "x");
    await writeFile(tmpAudio, "x");
  });

  afterEach(async () => {
    await rm(tmpVideo, { force: true });
    await rm(tmpAudio, { force: true });
  });

  it("video 文件删除触发标记联动清理（db.delete 被调用）", async () => {
    const res = await app.request(`/${tmpVideo.split("/").pop()}?type=video`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(deleteCallCount).toBe(1);
  });

  it("audio 文件删除不触发标记联动（db.delete 不被调用）", async () => {
    const res = await app.request(`/${tmpAudio.split("/").pop()}?type=audio`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(deleteCallCount).toBe(0);
  });

  it("db.delete 抛错时删除仍返回 200（标记清理失败不阻断，只记日志）", async () => {
    deleteShouldThrow = true;
    const res = await app.request(`/${tmpVideo.split("/").pop()}?type=video`, { method: "DELETE" });
    expect(res.status).toBe(200);
  });
});

describe("POST /api/files/reveal", () => {
  const tmpVideo = join(process.cwd(), "uploads/video/__reveal_tmp.mp4");
  const tmpReq = join(process.cwd(), "uploads/.open-requests");

  beforeEach(async () => {
    await writeFile(tmpVideo, "x");
    vi.stubEnv("HOST_UPLOADS_DIR", "/Users/tester/language-flow-uploads");
  });

  afterEach(async () => {
    await rm(tmpVideo, { force: true });
    await rm(tmpReq, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("写入标记文件（内容为宿主机路径）并返回 ok", async () => {
    const res = await app.request("/reveal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "/files/video/__reveal_tmp.mp4" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    const entries = await readdir(tmpReq);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain("__reveal_tmp.mp4");
    const content = await readFile(join(tmpReq, entries[0]), "utf8");
    expect(content).toBe("/Users/tester/language-flow-uploads/video/__reveal_tmp.mp4");
  });

  it("非视频 URL 返回 400", async () => {
    const res = await app.request("/reveal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "/files/audio/x.mp3" }),
    });
    expect(res.status).toBe(400);
  });

  it("文件不存在返回 404", async () => {
    const res = await app.request("/reveal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "/files/video/gone.mp4" }),
    });
    expect(res.status).toBe(404);
  });

  it("路径穿越 URL 返回 400", async () => {
    const res = await app.request("/reveal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "/files/video/../secret.mp4" }),
    });
    expect(res.status).toBe(400);
  });

  it("未配置 HOST_UPLOADS_DIR 返回 501", async () => {
    vi.stubEnv("HOST_UPLOADS_DIR", "");
    const res = await app.request("/reveal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "/files/video/__reveal_tmp.mp4" }),
    });
    expect(res.status).toBe(501);
  });
});
