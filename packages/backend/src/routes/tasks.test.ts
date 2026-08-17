/**
 * POST/GET/PATCH/DELETE /api/tasks 测试
 * 覆盖：列表（分页/status 过滤/总条数）/ 详情 / 更新（404+成功）/ 删除（404+成功）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db";
import { tasks } from "./tasks";

vi.mock("../db", () => ({ db: {} }));

/** 测试替身：drizzle builder 是 thenable（where() 可直接 await），mock 需同时支持链式调用与 await */
function fakeDb(rows: Record<string, unknown>[] = []) {
  // biome-ignore lint/suspicious/noThenProperty: 模拟 drizzle select builder 的 thenable（await 返回行）
  const leaf = () => ({ then: async (resolve: (v: unknown) => void) => resolve(rows) });
  const limitResult = () => ({ offset: () => leaf(), ...leaf() });
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({ limit: () => limitResult() }),
          limit: () => limitResult(),
          ...leaf(),
        }),
        orderBy: () => ({ limit: () => limitResult() }),
        limit: () => limitResult(),
      }),
    }),
    insert: () => ({ values: async () => undefined }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    delete: () => ({ where: async () => undefined }),
  } as unknown as typeof db;
}

const ROW = {
  id: "t1",
  template: "scene_word",
  title: "科技创业故事",
  level: "CET4",
  targetDuration: 60,
  content: [{ text: "x", words: [] }],
  words: [],
  style: { background: "#000" },
  voice: { id: "zh-CN-XiaoxiaoNeural" },
  audio: null,
  video: null,
  status: "content_ready",
  createdAt: new Date("2026-08-17T10:00:00Z"),
  updatedAt: new Date("2026-08-17T10:00:00Z"),
};

const app = tasks;

beforeEach(() => {
  // vitest mock 赋值类型断层，as never 为测试替身惯例
  vi.mocked(db).select = vi.fn(fakeDb().select) as never;
  vi.mocked(db).update = vi.fn(fakeDb().update) as never;
  vi.mocked(db).delete = vi.fn(fakeDb().delete) as never;
});

describe("GET /api/tasks", () => {
  it("返回任务列表与总数（默认分页）", async () => {
    const list = fakeDb([ROW]);
    const count = fakeDb([{ count: 1 }]);
    vi.mocked(db)
      .select.mockReturnValueOnce(list.select() as never)
      .mockReturnValueOnce(count.select() as never);

    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: unknown[]; total: number };
    expect(body.tasks).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.tasks[0]).toMatchObject({
      id: "t1",
      title: "科技创业故事",
      status: "content_ready",
    });
  });

  it("支持 status 过滤", async () => {
    vi.mocked(db).select.mockImplementation(fakeDb([]).select);
    const res = await app.request("/?status=completed");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { total: number };
    expect(body.total).toBe(0);
  });

  it("非法 status 返回 400", async () => {
    const res = await app.request("/?status=bad");
    expect(res.status).toBe(400);
  });
});

describe("GET /api/tasks/:id", () => {
  it("返回任务详情（全量）", async () => {
    vi.mocked(db).select.mockImplementation(fakeDb([ROW]).select);
    const res = await app.request("/t1");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "t1", status: "content_ready" });
  });

  it("不存在返回 404", async () => {
    vi.mocked(db).select.mockImplementation(fakeDb([]).select);
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/tasks/:id", () => {
  it("更新 title/status/video 后返回新记录", async () => {
    const updated = {
      ...ROW,
      title: "新标题",
      status: "completed",
      video: { url: "/files/video/x.mp4", duration: 12, format: "mp4" },
    };
    // 第一次 select（查存在）返回旧记录，第二次 select（查更新后）返回新记录
    vi.mocked(db)
      .select.mockImplementationOnce(fakeDb([ROW]).select)
      .mockImplementationOnce(fakeDb([updated]).select);

    const res = await app.request("/t1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "新标题",
        status: "completed",
        video: { url: "/files/video/x.mp4", duration: 12, format: "mp4" },
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ title: "新标题", status: "completed" });
  });

  it("不存在返回 404", async () => {
    vi.mocked(db).select.mockImplementation(fakeDb([]).select);
    const res = await app.request("/nope", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "completed" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/tasks/:id", () => {
  it("删除成功", async () => {
    vi.mocked(db).select.mockImplementation(fakeDb([ROW]).select);
    const res = await app.request("/t1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });

  it("不存在返回 404", async () => {
    vi.mocked(db).select.mockImplementation(fakeDb([]).select);
    const res = await app.request("/nope", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});
