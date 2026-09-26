/**
 * analytics-metrics.service 测试 — 数值归一化 / 派生指标计算 / 导入字段映射（纯函数）
 * + 写入编排（事务原子性/唯一键竞态/删除存在性，2026-09-26 审查批次 3）
 * 覆盖需求 §五C（派生口径）、§二十一（除零安全）、§二十二（不伪造 0）、§二十四（后端统一计算）
 */
import { describe, expect, it, vi } from "vitest";
import { db } from "../db";
import {
  coerceMetricValue,
  computeDerivedMetrics,
  createPublishRecord,
  deletePublishRecord,
  importCreatorDaily,
  importMetrics,
  mapCreatorDailyRow,
  mapImportRow,
} from "./analytics-metrics.service";

// 纯函数用例不连库；服务模块导入时的池初始化按现有惯例 mock
vi.mock("../db", () => ({ db: {} }));

describe("coerceMetricValue", () => {
  it("计数类：整数与千分位/空格字符串", () => {
    expect(coerceMetricValue(1283220, "count")).toEqual({ ok: true, value: 1283220 });
    expect(coerceMetricValue("1,283,220", "count")).toEqual({ ok: true, value: 1283220 });
    expect(coerceMetricValue(" 500 ", "count")).toEqual({ ok: true, value: 500 });
  });

  it("比例类：小数、百分号字符串与百分数值统一折算 0~1", () => {
    expect(coerceMetricValue(0.413, "rate")).toEqual({ ok: true, value: 0.413 });
    expect(coerceMetricValue("41.3%", "rate")).toEqual({ ok: true, value: 0.413 });
    expect(coerceMetricValue(41.3, "rate")).toEqual({ ok: true, value: 0.413 });
    expect(coerceMetricValue(1, "rate")).toEqual({ ok: true, value: 1 });
  });

  it("空值与占位符不得折算成 0（无数据 ≠ 0）", () => {
    for (const raw of ["", " ", "-", "—", "N/A", "null", "暂无", null, undefined]) {
      const r = coerceMetricValue(raw, "rate");
      expect(r.ok).toBe(false);
    }
  });

  it("非法输入拒绝并给出原因", () => {
    expect(coerceMetricValue("abc", "count")).toEqual({ ok: false, reason: "无法解析为数值" });
    expect(coerceMetricValue(-5, "count")).toEqual({ ok: false, reason: "负值不合法" });
    expect(coerceMetricValue("50%", "count")).toEqual({
      ok: false,
      reason: "计数/时长类指标不接受百分比",
    });
    expect(coerceMetricValue(150, "rate")).toEqual({
      ok: false,
      reason: "比例类指标超出 0~1 范围",
    });
    expect(coerceMetricValue(true, "count")).toEqual({
      ok: false,
      reason: "不支持的值类型",
    });
  });
});

describe("computeDerivedMetrics", () => {
  it("播放量>0：点赞/评论/分享率与互动率", () => {
    const derived = computeDerivedMetrics(
      new Map([
        ["play_count", 100],
        ["like_count", 10],
        ["comment_count", 5],
        ["share_count", 1],
      ]),
      null,
    );
    expect(derived.get("like_rate")).toBeCloseTo(0.1);
    expect(derived.get("comment_rate")).toBeCloseTo(0.05);
    expect(derived.get("share_rate")).toBeCloseTo(0.01);
    expect(derived.get("engagement_rate")).toBeCloseTo(0.16);
    // 未导入的收藏率不产出（不得用 0 填充）
    expect(derived.has("collect_rate")).toBe(false);
  });

  it("播放量为 0 时不产出任何比率（除零防护）", () => {
    const derived = computeDerivedMetrics(
      new Map([
        ["play_count", 0],
        ["like_count", 3],
      ]),
      30,
    );
    expect(derived.size).toBe(0);
  });

  it("互动率要求三项齐备，缺任一不产出", () => {
    const derived = computeDerivedMetrics(
      new Map([
        ["play_count", 100],
        ["like_count", 10],
        ["comment_count", 5],
      ]),
      null,
    );
    expect(derived.has("engagement_rate")).toBe(false);
    expect(derived.get("like_rate")).toBeCloseTo(0.1);
  });

  it("2秒有效播放率 = 1 - 2秒跳出率；平均观看比例需成片时长", () => {
    const derived = computeDerivedMetrics(
      new Map([
        ["bounce_rate_2s", 0.23],
        ["avg_watch_time", 15],
      ]),
      60,
    );
    expect(derived.get("effective_play_rate_2s")).toBeCloseTo(0.77);
    expect(derived.get("avg_watch_ratio")).toBeCloseTo(0.25);
    const noDuration = computeDerivedMetrics(new Map([["avg_watch_time", 15]]), null);
    expect(noDuration.has("avg_watch_ratio")).toBe(false);
  });
});

describe("mapImportRow（动态字段映射）", () => {
  const mapping = {
    播放量: "play_count",
    完播率: "completion_rate",
    点赞: "like_rate",
    未知列: "not_a_metric",
  };

  it("已映射且可导入的字段生成 draft，保留来源原始列名", () => {
    const { drafts, skipped } = mapImportRow({ 播放量: "1,283,220", 完播率: "41.3%" }, mapping);
    expect(drafts).toEqual([
      { metricName: "play_count", metricValue: 1283220, sourceField: "播放量" },
      { metricName: "completion_rate", metricValue: 0.413, sourceField: "完播率" },
    ]);
    expect(skipped).toEqual([]);
  });

  it("派生指标不接受导入；未知指标名拒绝；未映射字段不静默丢弃", () => {
    const { drafts, skipped } = mapImportRow({ 点赞: 0.1, 未知列: 1, 其它列: 2 }, mapping);
    expect(drafts).toEqual([]);
    expect(skipped).toEqual([
      { field: "点赞", reason: "like_rate 为派生/预留指标，不接受导入" },
      { field: "未知列", reason: "未知指标 not_a_metric" },
      { field: "其它列", reason: "字段未映射" },
    ]);
  });

  it("值非法的字段逐列跳过并携带原因", () => {
    const { drafts, skipped } = mapImportRow({ 播放量: "-" }, mapping);
    expect(drafts).toEqual([]);
    expect(skipped).toEqual([{ field: "播放量", reason: "空值或占位符" }]);
  });
});

describe("coerceMetricValue · 时长秒后缀（创作者导出真实格式 3.94s）", () => {
  it("seconds 单位接受 s/秒 后缀；其他单位不受影响", () => {
    expect(coerceMetricValue("3.94s", "seconds")).toEqual({ ok: true, value: 3.94 });
    expect(coerceMetricValue("48秒", "seconds")).toEqual({ ok: true, value: 48 });
    expect(coerceMetricValue("12sec", "seconds")).toEqual({ ok: true, value: 12 });
    expect(coerceMetricValue("60", "seconds")).toEqual({ ok: true, value: 60 });
    // count 不接受 s 后缀（不是时长）
    expect(coerceMetricValue("708s", "count").ok).toBe(false);
  });
});

describe("mapCreatorDailyRow（账号日汇总动态列映射，真实表格格式）", () => {
  const mapping = {
    日期: "statDate", // 未知字段（不在账号日目录）
    总播放量: "playIncrement",
    总点赞量: "likeIncrement",
    总分享量: "shareIncrement",
    总评论量: "commentIncrement",
    "5秒完播率": "watchRate5s",
    "2秒跳出率": "bounceRate2s",
    封面点击率: "coverClickRate",
    平均播放时长: "avgWatchTime",
    投稿量: "postCount",
  };

  it("抖音全量指标导出行 → 全部合法字段归一化落值", () => {
    const { fields, skipped } = mapCreatorDailyRow(
      {
        日期: "2026-09-17",
        总播放量: "708",
        总点赞量: 24,
        总分享量: 3,
        总评论量: 2,
        "5秒完播率": "15.08%",
        "2秒跳出率": "78.07%",
        封面点击率: "0.00%",
        平均播放时长: "3.94s",
        投稿量: "1",
      },
      mapping,
    );
    expect(fields).toEqual({
      playIncrement: 708,
      likeIncrement: 24,
      shareIncrement: 3,
      commentIncrement: 2,
      watchRate5s: 0.1508,
      bounceRate2s: 0.7807,
      coverClickRate: 0,
      avgWatchTime: 3.94,
      postCount: 1,
    });
    // 日期列映射到 statDate 不在字段目录 → 逐列回原因不静默丢
    expect(skipped).toEqual([{ field: "日期", reason: "未知账号日字段「statDate」" }]);
  });

  it("未映射列/占位符/非法值逐列回原因", () => {
    const { fields, skipped } = mapCreatorDailyRow(
      { 陌生列: "x", 总播放量: "-", 封面点击率: "abc" },
      { 总播放量: "playIncrement", 封面点击率: "coverClickRate" },
    );
    expect(fields).toEqual({});
    expect(skipped).toEqual([
      { field: "陌生列", reason: "未映射列" },
      { field: "总播放量", reason: "空值或占位符" },
      { field: "封面点击率", reason: "无法解析为数值" },
    ]);
  });

  it("count 类四舍五入取整（比例/时长保留小数）", () => {
    const { fields } = mapCreatorDailyRow(
      { 总播放量: "708.6", 平均播放时长: "3.949s" },
      {
        总播放量: "playIncrement",
        平均播放时长: "avgWatchTime",
      },
    );
    expect(fields.playIncrement).toBe(709);
    expect(fields.avgWatchTime).toBe(3.949);
  });
});

// ── 写入编排：事务原子性 / 唯一键竞态 / 删除存在性（审查批次 3，2026-09-26） ──

/** select 链（thenable，按调用顺序弹出预置结果集） */
function thenableChain(rows: unknown[]) {
  const q: Record<string, unknown> = {};
  q.from = vi.fn(() => q);
  q.where = vi.fn(() => q);
  q.limit = vi.fn(() => q);
  q.orderBy = vi.fn(() => q);
  // biome-ignore lint/suspicious/noThenProperty: 模拟 Drizzle 查询链的 thenable，让 await chain 直接拿预置行集
  q.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
    if (rows instanceof Error) reject(rows);
    else resolve(rows);
  };
  return q;
}

function insertChain(rejectWith?: unknown) {
  const settle = (resolve: (v: unknown) => void, reject: (e: unknown) => void): void => {
    if (rejectWith === undefined) resolve(undefined);
    else reject(rejectWith);
  };
  return vi.fn(() => ({
    values: vi.fn(() => ({
      onDuplicateKeyUpdate: vi.fn(() => new Promise<unknown>((res, rej) => settle(res, rej))),
      // biome-ignore lint/suspicious/noThenProperty: 同上，模拟不带 onDuplicateKeyUpdate 的 await insert().values() 路径
      then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
        settle(resolve, reject),
    })),
  }));
}

function makeExecutor(selectResults: unknown[][], insertReject?: unknown) {
  const queue = [...selectResults];
  return {
    select: vi.fn(() => thenableChain(queue.shift() ?? [])),
    insert: insertChain(insertReject),
    delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
  };
}

/** 把 fake 方法临时挂到被 mock 的 db 单例上，跑完原样移除 */
async function withFakeDb<T>(fake: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
  const target = db as unknown as Record<string, unknown>;
  const keys = Object.keys(fake);
  Object.assign(target, fake);
  try {
    return await run();
  } finally {
    for (const k of keys) delete target[k];
  }
}

describe("createPublishRecord 并发竞态兑底（审查批次 3）", () => {
  const dupErr = Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY" });

  it("先查无重复但插入撞唯一键 → duplicate（路由可回 409，不再是 500）", () => {
    // 第二个结果集 = 空行集（[]）：重复预查无命中，才能走到插入竞态路径
    const queue: unknown[][] = [[{ id: "c1", video: null }], []];
    return withFakeDb(
      {
        select: vi.fn(() => thenableChain(queue.shift() ?? [])),
        insert: insertChain(dupErr),
      },
      async () => {
        const r = await createPublishRecord({
          contentId: "c1",
          platform: "抖音",
          platformVideoId: "v-1",
        });
        expect(r).toEqual({ kind: "duplicate" });
      },
    );
  });

  it("非唯一键异常原样抛出（不吞错误）", () => {
    const queue: unknown[][] = [[{ id: "c1", video: null }], []];
    return withFakeDb(
      {
        select: vi.fn(() => thenableChain(queue.shift() ?? [])),
        insert: insertChain(new Error("conn lost")),
      },
      async () => {
        await expect(
          createPublishRecord({ contentId: "c1", platform: "抖音", platformVideoId: "v-1" }),
        ).rejects.toThrow("conn lost");
      },
    );
  });
});

describe("deletePublishRecord 存在性语义（审查批次 3）", () => {
  it("记录存在 → true 且执行删除", () =>
    withFakeDb(
      {
        select: vi.fn(() => thenableChain([{ id: "pub_1" }])),
        delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
      },
      async () => {
        expect(await deletePublishRecord("pub_1")).toBe(true);
      },
    ));

  it("记录不存在 → false（路由回 404，不再假报删除成功）", () =>
    withFakeDb(
      {
        select: vi.fn(() => thenableChain([])),
        delete: vi.fn(),
      },
      async () => {
        expect(await deletePublishRecord("missing")).toBe(false);
      },
    ));
});

describe("importMetrics / importCreatorDaily 事务边界（审查批次 3）", () => {
  it("导入成功：原始写 + 派生重算全部走同一事务，重算不再游离在事务外", () =>
    withFakeDb(
      {
        select: vi.fn(() => thenableChain([{ id: "rec1" }])),
        transaction: vi.fn((cb: (tx: unknown) => Promise<unknown>) =>
          cb(
            makeExecutor([
              [{ id: "rec1", contentId: "c1" }], // recompute：发布记录
              [{ video: { duration: 30 } }], // 成片时长
              [
                { metricName: "play_count", metricValue: 1000 },
                { metricName: "like_count", metricValue: 100 },
              ], // 存量指标
            ]),
          ),
        ),
      },
      async () => {
        const results = await importMetrics({
          sourceType: "CREATOR_IMPORT",
          metricMapping: { 播放: "play_count", 点赞: "like_count" },
          rows: [{ match: { recordId: "rec1" }, values: { 播放: 1000, 点赞: 100 } }],
        });
        expect(results[0]?.ok).toBe(true);
        expect(results[0]?.written).toEqual(["play_count", "like_count"]);
        expect(results[0]?.derived).toEqual(["like_rate"]);
      },
    ));

  it("事务内任一步失败 → 该行报 error，绝不留下事务外的派生补写", () =>
    withFakeDb(
      {
        select: vi.fn(() => thenableChain([{ id: "rec1" }])),
        transaction: vi.fn((cb: (tx: unknown) => Promise<unknown>) =>
          cb(makeExecutor([], Object.assign(new Error("dup"), { code: "ER_DUP_ENTRY" }))),
        ),
      },
      async () => {
        const results = await importMetrics({
          sourceType: "CREATOR_IMPORT",
          metricMapping: { 播放: "play_count" },
          rows: [{ match: { recordId: "rec1" }, values: { 播放: 10 } }],
        });
        expect(results[0]?.ok).toBe(false);
        expect(results[0]?.error).toContain("dup");
        expect(results[0]?.derived).toEqual([]);
      },
    ));

  it("账号日导入：账号 upsert + 视频写 + 派生重算单行单事务（无 db 级旁路写）", () =>
    withFakeDb(
      {
        select: vi.fn(() => thenableChain([{ id: "rec1", contentId: "c1" }])),
        transaction: vi.fn((cb: (tx: unknown) => Promise<unknown>) =>
          cb(
            makeExecutor([
              [{ id: "rec1", contentId: "c1" }],
              [{ video: { duration: 30 } }],
              [
                { metricName: "play_count", metricValue: 500 },
                { metricName: "like_count", metricValue: 25 },
              ],
            ]),
          ),
        ),
      },
      async () => {
        const results = await importCreatorDaily({
          platform: "抖音",
          sourceType: "CREATOR_IMPORT",
          fieldMapping: { 播放: "playIncrement", 点赞: "likeIncrement" },
          rows: [
            {
              statDate: "2026-09-20",
              values: { 播放: 500, 点赞: 25 },
              attribution: { mode: "video", recordId: "rec1" },
            },
          ],
        });
        expect(results[0]?.ok).toBe(true);
        expect(results[0]?.dailyWritten).toEqual(["playIncrement", "likeIncrement"]);
        expect(results[0]?.videoWritten).toContain("play_count");
        expect(results[0]?.videoDerived).toEqual(["like_rate"]);
      },
    ));
});
