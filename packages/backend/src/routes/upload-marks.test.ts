/**
 * GET/POST/PATCH/DELETE /api/upload-marks 测试
 * 覆盖：列表 / 一览组装 / 新增 / 更新 / 删除
 */
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db";
import { contents, publishRecords, uploadMarks } from "../db/schema";
import { buildUploadMarksOverview, uploadMarksRoute } from "./upload-marks";

// 标记与派生发布记录同事务：替身常驻提供 transaction（真实回滚由 MySQL 保证），
// 单测仍可按需覆盖 db.transaction 来断言撤销语义。
vi.mock("../db", () => {
  const mod: { db: Record<string, unknown> } = { db: {} };
  mod.db.transaction = async (cb: (tx: unknown) => unknown) => cb(mod.db);
  return mod;
});

/** 测试替身：mock drizzle 链式调用；update/delete 的 affectedRows 可控 */
function fakeDb() {
  const state = { affectedRows: 1, rows: [] as Record<string, unknown>[] };
  const leaf = (r: Record<string, unknown>[]) => ({
    // biome-ignore lint/suspicious/noThenProperty: 模拟 drizzle select builder 的 thenable（await 返回行）
    then: async (resolve: (v: unknown) => void) => resolve(r),
  });
  const mock: Record<string, unknown> = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => leaf(state.rows),
          limit: () => leaf(state.rows),
          ...leaf(state.rows),
        }),
        orderBy: () => leaf(state.rows),
        limit: () => leaf(state.rows),
        ...leaf(state.rows),
      }),
    }),
    insert: () => ({ values: async () => undefined }),
    update: () => ({ set: () => ({ where: async () => [{ affectedRows: state.affectedRows }] }) }),
    delete: () => ({ where: async () => [{ affectedRows: state.affectedRows }] }),
  };
  // 整套链一次性挂上：标记派生发布记录会走 select/insert/update 三种链，
  // 只 cherry-pick 其中一两个方法会让替身在新表上缺方法。
  Object.assign(db, mock);
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

describe("POST /api/upload-marks 标记即发布（派生发布记录）", () => {
  /** 按表分流的替身：records 插入可注入失败，用于验证同事务撤销 */
  function txFake(failPublishInsert = false) {
    const inserted: { table: string; row: Record<string, unknown> }[] = [];
    const tableOf = (t: unknown): string =>
      t === uploadMarks
        ? "marks"
        : t === publishRecords
          ? "records"
          : t === contents
            ? "contents"
            : "unknown";
    const chain = (name: string) => {
      const q: Record<string, unknown> = {};
      q.where = vi.fn(() => q);
      q.limit = vi.fn(() => q);
      q.orderBy = vi.fn(() => q);
      // biome-ignore lint/suspicious/noThenProperty: 模拟 drizzle 查询链的 thenable
      q.then = (resolve: (v: unknown) => void) =>
        resolve(name === "contents" ? [{ title: "线上学习的新支持" }] : []);
      return q;
    };
    const mock = {
      select: vi.fn(() => ({ from: (t: unknown) => chain(tableOf(t)) })),
      insert: vi.fn((t: unknown) => ({
        values: vi.fn((row: Record<string, unknown>) => {
          const name = tableOf(t);
          if (name === "records" && failPublishInsert) return Promise.reject(new Error("boom"));
          inserted.push({ table: name, row });
          return Promise.resolve();
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
      })),
    };
    return Object.assign(mock, { inserted });
  }

  function install(mock: ReturnType<typeof txFake>): void {
    vi.mocked(db).select = mock.select as never;
    vi.mocked(db).insert = mock.insert as never;
    vi.mocked(db).update = mock.update as never;
    vi.mocked(db).transaction = (async (cb: (tx: typeof db) => unknown) => {
      const snapshot = [...mock.inserted];
      try {
        return await cb(db);
      } catch (e) {
        // 替身版回滚：真实语义由 MySQL 事务承担
        mock.inserted.length = 0;
        mock.inserted.push(...snapshot);
        throw e;
      }
    }) as never;
  }

  const post = (body: Record<string, unknown>) =>
    app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("标记落库的同时派生发布记录，结果在响应里可见", async () => {
    const mock = txFake();
    install(mock);
    const res = await post({
      videoFilename: "__mark_tmp.mp4",
      platform: "抖音",
      url: "https://www.douyin.com/video/7412345678901234567",
      taskId: "cnt_20261002_469bc3",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { publishRecord: string; publishRecordHint: string };
    expect(body.publishRecord).toBe("created");
    expect(body.publishRecordHint).toContain("发布记录");
    expect(mock.inserted.find((x) => x.table === "records")?.row).toMatchObject({
      contentId: "cnt_20261002_469bc3",
      platform: "抖音",
      platformVideoId: "7412345678901234567",
      publishTitle: "线上学习的新支持",
      publishStatus: "published",
    });
  });

  it("派生失败时标记一起撤销并回 500，不留「标记成功但分析里没有」", async () => {
    const mock = txFake(true);
    install(mock);
    const res = await post({
      videoFilename: "__mark_tmp.mp4",
      platform: "抖音",
      url: "https://www.douyin.com/video/7412345678901234567",
      taskId: "cnt_20261002_469bc3",
    });
    expect(res.status).toBe(500);
    expect(mock.inserted).toHaveLength(0);
    await expect(res.json()).resolves.toMatchObject({ error: expect.any(String) });
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
