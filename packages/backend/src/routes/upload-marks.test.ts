/**
 * GET/POST/PATCH/DELETE /api/upload-marks 测试
 * 覆盖：列表 / 新增（成功/文件不存在/非法文件名）/ 更新（成功/404）/ 删除（成功/404）
 */
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db";
import { uploadMarksRoute } from "./upload-marks";

vi.mock("../db", () => ({ db: {} }));

/** 测试替身：mock drizzle 链式调用；update/delete 的 affectedRows 可控 */
function fakeDb() {
  const state = { affectedRows: 1, rows: [] as Record<string, unknown>[] };
  const leaf = (r: Record<string, unknown>[]) => ({
    // biome-ignore lint/suspicious/noThenProperty: 模拟 drizzle select builder 的 thenable（await 返回行）
    then: async (resolve: (v: unknown) => void) => resolve(r),
  });
  const mock = {
    select: () => ({
      from: () => ({
        where: () => ({ orderBy: () => leaf(state.rows), ...leaf(state.rows) }),
        orderBy: () => leaf(state.rows),
      }),
    }),
    insert: () => ({ values: async () => undefined }),
    update: () => ({ set: () => ({ where: async () => [{ affectedRows: state.affectedRows }] }) }),
    delete: () => ({ where: async () => [{ affectedRows: state.affectedRows }] }),
  };
  return Object.assign(mock, { __state: state }) as unknown as typeof db & {
    __state: typeof state;
  };
}

const app = uploadMarksRoute;
const tmpVideo = join(process.cwd(), "uploads/video/__mark_tmp.mp4");

beforeEach(async () => {
  await writeFile(tmpVideo, "x");
});

afterEach(async () => {
  await rm(tmpVideo, { force: true });
});

describe("GET /api/upload-marks", () => {
  it("返回标记列表", async () => {
    const mocked = fakeDb();
    vi.mocked(db).select = mocked.select as never;
    mocked.__state.rows = [
      {
        id: "m1",
        videoFilename: "__mark_tmp.mp4",
        platform: "抖音",
        url: null,
        note: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { marks: { id: string; platform: string }[] };
    expect(body.marks).toHaveLength(1);
    expect(body.marks[0].platform).toBe("抖音");
  });
});

describe("POST /api/upload-marks", () => {
  it("新增标记成功（视频文件存在）", async () => {
    vi.mocked(db).insert = fakeDb().insert as never;
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        videoFilename: "__mark_tmp.mp4",
        platform: "抖音",
        url: "https://v.douyin.com/x",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; platform: string; videoFilename: string };
    expect(body.id).toHaveLength(32);
    expect(body.platform).toBe("抖音");
    expect(body.videoFilename).toBe("__mark_tmp.mp4");
  });

  it("视频文件不存在返回 404", async () => {
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ videoFilename: "gone.mp4", platform: "抖音" }),
    });
    expect(res.status).toBe(404);
  });

  it("非法文件名（路径穿越）返回 400", async () => {
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ videoFilename: "../secret.mp4", platform: "抖音" }),
    });
    expect(res.status).toBe(400);
  });

  it("platform 缺失返回 400", async () => {
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ videoFilename: "__mark_tmp.mp4" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/upload-marks/:id", () => {
  it("更新成功（幂等：值未变化也返回 success，不依赖 affectedRows）", async () => {
    const mocked = fakeDb();
    mocked.__state.rows = [{ id: "m1" }]; // 标记存在
    vi.mocked(db).select = mocked.select as never;
    vi.mocked(db).update = mocked.update as never;
    const res = await app.request("/m1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "小红书" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
  });

  it("标记不存在返回 404（select 判据）", async () => {
    const mocked = fakeDb();
    mocked.__state.rows = []; // 标记不存在
    vi.mocked(db).select = mocked.select as never;
    const res = await app.request("/m1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "小红书" }),
    });
    expect(res.status).toBe(404);
  });

  it("空更新返回 400", async () => {
    const res = await app.request("/m1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/upload-marks/:id", () => {
  it("删除成功", async () => {
    vi.mocked(db).delete = fakeDb().delete as never;
    const res = await app.request("/m1", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(true);
  });

  it("标记不存在返回 404", async () => {
    const mocked = fakeDb();
    mocked.__state.affectedRows = 0;
    vi.mocked(db).delete = mocked.delete as never;
    const res = await app.request("/m1", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});
