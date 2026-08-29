/**
 * GET/POST/PATCH/DELETE /api/upload-marks 测试
 * 覆盖：列表 / 一览组装 / 新增 / 更新 / 删除
 */
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db";
import { buildUploadMarksOverview, uploadMarksRoute } from "./upload-marks";

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
        ...leaf(state.rows),
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

describe("buildUploadMarksOverview", () => {
  const mark = {
    id: "m1",
    taskId: "t1",
    videoFilename: "a.mp4",
    platform: "抖音",
    url: "https://v.douyin.com/x",
    note: "情景英语四级词汇-第1集",
    createdAt: new Date("2026-08-20T10:00:00Z"),
    updatedAt: new Date("2026-08-20T10:00:00Z"),
  };
  const task = {
    id: "t1",
    title: "森林探险",
    template: "scene_word" as const,
    level: "CET4" as const,
    words: ["a", "b", "c"],
    video: { url: "/files/video/a.mp4", duration: 12.5 },
  };

  it("按 taskId 关联视频信息", () => {
    const rows = buildUploadMarksOverview([mark], [task]);
    expect(rows).toHaveLength(1);
    expect(rows[0].video).toEqual({
      title: "森林探险",
      template: "scene_word",
      level: "CET4",
      wordsCount: 3,
      duration: 12.5,
    });
  });

  it("taskId 缺失时按文件名回退", () => {
    const orphan = { ...mark, taskId: null };
    const rows = buildUploadMarksOverview([orphan], [task]);
    expect(rows[0].video?.title).toBe("森林探险");
  });

  it("无匹配任务时 video 为 null", () => {
    const rows = buildUploadMarksOverview(
      [{ ...mark, taskId: null, videoFilename: "gone.mp4" }],
      [],
    );
    expect(rows[0].video).toBeNull();
  });

  it("platform 过滤", () => {
    const rows = buildUploadMarksOverview(
      [mark, { ...mark, id: "m2", platform: "小红书" }],
      [task],
      { platform: "小红书" },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].platform).toBe("小红书");
  });

  it("keyword 过滤标题与备注", () => {
    const byTitle = buildUploadMarksOverview([mark], [task], { keyword: "森林" });
    expect(byTitle).toHaveLength(1);
    const byNote = buildUploadMarksOverview([mark], [task], { keyword: "第1集" });
    expect(byNote).toHaveLength(1);
    const miss = buildUploadMarksOverview([mark], [task], { keyword: "不存在" });
    expect(miss).toHaveLength(0);
  });
});

describe("GET /api/upload-marks", () => {
  it("返回标记列表", async () => {
    const mocked = fakeDb();
    vi.mocked(db).select = mocked.select as never;
    mocked.__state.rows = [
      {
        id: "m1",
        taskId: null,
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

describe("GET /api/upload-marks/overview", () => {
  it("返回一览列表与平台枚举", async () => {
    const mocked = fakeDb();
    vi.mocked(db).select = mocked.select as never;
    mocked.__state.rows = [
      {
        id: "m1",
        taskId: null,
        videoFilename: "__mark_tmp.mp4",
        platform: "抖音",
        url: "https://v.douyin.com/x",
        note: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const res = await app.request("/overview");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      marks: { id: string; platform: string; video: unknown }[];
      platforms: string[];
    };
    expect(body.marks).toHaveLength(1);
    expect(body.marks[0].platform).toBe("抖音");
    expect(body.platforms).toEqual(["抖音"]);
  });
});

describe("POST /api/upload-marks", () => {
  it("新增标记成功（视频文件存在，自动反查绑定任务）", async () => {
    const mocked = fakeDb();
    vi.mocked(db).insert = mocked.insert as never;
    vi.mocked(db).select = mocked.select as never;
    mocked.__state.rows = [
      {
        id: "cnt_001",
        video: { url: "/files/video/__mark_tmp.mp4", duration: 10 },
      },
    ];
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
    const body = (await res.json()) as {
      id: string;
      taskId: string | null;
      platform: string;
      videoFilename: string;
    };
    expect(body.id).toHaveLength(32);
    expect(body.platform).toBe("抖音");
    expect(body.videoFilename).toBe("__mark_tmp.mp4");
    expect(body.taskId).toBe("cnt_001");
  });

  it("新增标记：无匹配任务时 taskId 为 null", async () => {
    const mocked = fakeDb();
    vi.mocked(db).insert = mocked.insert as never;
    vi.mocked(db).select = mocked.select as never;
    mocked.__state.rows = [];
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ videoFilename: "__mark_tmp.mp4", platform: "抖音" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { taskId: string | null };
    expect(body.taskId).toBeNull();
  });

  it("新增标记：显式传入不存在的 taskId 返回 400", async () => {
    const mocked = fakeDb();
    vi.mocked(db).insert = mocked.insert as never;
    vi.mocked(db).select = mocked.select as never;
    mocked.__state.rows = [];
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        videoFilename: "__mark_tmp.mp4",
        platform: "抖音",
        taskId: "cnt_ghost",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("新增标记：显式传入存在的 taskId 直接绑定", async () => {
    const mocked = fakeDb();
    vi.mocked(db).insert = mocked.insert as never;
    vi.mocked(db).select = mocked.select as never;
    mocked.__state.rows = [{ id: "cnt_ok" }];
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        videoFilename: "__mark_tmp.mp4",
        platform: "抖音",
        taskId: "cnt_ok",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { taskId: string | null };
    expect(body.taskId).toBe("cnt_ok");
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
    mocked.__state.rows = [{ id: "m1" }];
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
    mocked.__state.rows = [];
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
