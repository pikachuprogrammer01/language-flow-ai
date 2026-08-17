/**
 * GET/DELETE /api/files 测试
 * 覆盖：列表（类型过滤/inUse 标记）/ 删除成功 / 非法文件名 400 / 不存在 404
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db";
import { fileManager } from "./file-manager";

vi.mock("../db", () => ({ db: {} }));

const app = fileManager;

beforeEach(() => {
  // referencedFiles 查询 contents：select({audio, video}).from() 返回空数组；vitest mock 赋值类型断层用 as never（测试替身惯例）
  vi.mocked(db).select = vi.fn(() => ({ from: async () => [] }) as never) as never;
});

describe("GET /api/files", () => {
  it("返回音频/视频文件列表（含 inUse 标记）", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { files: { type: string; inUse: boolean }[] };
    expect(Array.isArray(body.files)).toBe(true);
    expect(body.files.length).toBeGreaterThan(0);
    expect(body.files.every((f) => f.type === "audio" || f.type === "video")).toBe(true);
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
    const res = await app.request("/%2E%2E/secret.mp3", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("未知扩展名返回 400", async () => {
    const res = await app.request("/x.txt", { method: "DELETE" });
    expect(res.status).toBe(400);
  });

  it("不存在的文件返回 404", async () => {
    const res = await app.request("/no-such-file.mp3", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});
