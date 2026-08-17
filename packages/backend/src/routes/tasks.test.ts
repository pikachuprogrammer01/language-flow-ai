/**
 * POST/GET/PATCH/DELETE /api/tasks 测试
 * 覆盖：列表（分页/status 过滤/总条数）/ 详情 / 更新（404+成功）/ 删除（404+成功）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db";
import { cetWords } from "../db/schema";
import { tasks } from "./tasks";

vi.mock("../db", () => ({ db: {} }));

/** 测试替身：drizzle builder 是 thenable（where() 可直接 await），mock 需同时支持链式调用与 await */
function fakeDb(rows: Record<string, unknown>[] = [], wordRows: Record<string, unknown>[] = []) {
  const leaf = (r: Record<string, unknown>[]) => ({
    // biome-ignore lint/suspicious/noThenProperty: 模拟 drizzle select builder 的 thenable（await 返回行）
    then: async (resolve: (v: unknown) => void) => resolve(r),
  });
  const limitResult = (r: Record<string, unknown>[]) => ({ offset: () => leaf(r), ...leaf(r) });
  // update().set() 的参数捕获（断言审计/回写逻辑）
  const sets: Record<string, unknown>[] = [];
  const mock = {
    select: () => ({
      from: (t?: unknown) =>
        t === cetWords
          ? { where: () => limitResult(wordRows) }
          : {
              where: () => ({
                orderBy: () => ({ limit: () => limitResult(rows) }),
                limit: () => limitResult(rows),
                ...leaf(rows),
              }),
              orderBy: () => ({ limit: () => limitResult(rows) }),
              limit: () => limitResult(rows),
            },
    }),
    insert: () => ({ values: async () => undefined }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        sets.push(v);
        return { where: async () => undefined };
      },
    }),
    delete: () => ({ where: async () => undefined }),
  };
  return Object.assign(mock, { __sets: sets }) as unknown as typeof db & {
    __sets: Record<string, unknown>[];
  };
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
    const body = (await res.json()) as {
      tasks: {
        id: string;
        title: string;
        status: string;
        wordsCount: number;
        textPreview: string;
      }[];
      total: number;
    };
    expect(body.tasks).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(body.tasks[0]).toMatchObject({
      id: "t1",
      title: "科技创业故事",
      status: "content_ready",
      auditSummary: { hasAudit: false, candidates: 0, attempts: 0, modifications: 0 },
    });
    expect(body.tasks[0].wordsCount).toBe(0);
    expect(body.tasks[0].textPreview).toBe("x");
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

  it("带 content 时同步重建词汇清单（保留原词义 + 词库补新词）", async () => {
    const updated = {
      ...ROW,
      content: [
        {
          text: "He found a contract in the library.",
          words: [
            { word: "contract", meaning: "合同", level: "CET4" },
            { word: "library", meaning: "图书馆", level: "CET4" },
          ],
        },
      ],
      words: [
        { word: "contract", meaning: "合同", level: "CET4" },
        { word: "library", meaning: "图书馆", level: "CET4" },
      ],
    };
    // select 三次：查存在 / 查词库（cetWords）/ 查更新后
    vi.mocked(db)
      .select.mockImplementationOnce(fakeDb([ROW]).select)
      .mockImplementationOnce(
        fakeDb([], [{ word: "library", meaning: "图书馆", level: "CET4" }]).select,
      )
      .mockImplementationOnce(fakeDb([updated]).select);

    const res = await app.request("/t1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: [
          {
            text: "He found a contract in the library.",
            words: [{ word: "contract", meaning: "合同", level: "CET4" }],
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    // 顶层 words 跟随重建：保留 contract（原词义）+ 词库补入 library
    expect(json.words).toEqual([
      { word: "contract", meaning: "合同", level: "CET4" },
      { word: "library", meaning: "图书馆", level: "CET4" },
    ]);
    // 段内 words 同样重建（library 补入）
    expect(json.content[0].words).toHaveLength(2);
  });

  it("PATCH 时审计档案追加修改日志（audit.modifications）", async () => {
    const withAudit = {
      ...ROW,
      audit: {
        input: { topic: "科技创业", level: "CET4", template: "scene_word" },
        process: { candidates: [], attempts: [] },
        createdAt: "2026-08-17T10:00:00.000Z",
        modifications: [{ at: "2026-08-17T11:00:00.000Z", fields: ["content"] }],
      },
    };
    const dbMock = fakeDb([withAudit]);
    // select 两次：查存在 / 查更新后
    vi.mocked(db)
      .select.mockImplementationOnce(dbMock.select)
      .mockImplementationOnce(fakeDb([{ ...withAudit, title: "新标题" }]).select);
    vi.mocked(db).update.mockImplementation(dbMock.update as never);

    const res = await app.request("/t1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "新标题" }),
    });
    expect(res.status).toBe(200);
    const audit = dbMock.__sets[0]?.audit as {
      modifications: { at: string; fields: string[] }[];
    };
    expect(audit.modifications).toHaveLength(2); // 原有 1 条 + 本次追加 1 条
    expect(audit.modifications[1]).toMatchObject({ fields: ["title"] });
    expect(typeof audit.modifications[1].at).toBe("string");
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
