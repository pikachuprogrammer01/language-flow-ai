/**
 * dashboard.service 聚合单测 — getDashboardSummary 全子查询编排（mock db 链式查询）
 * 链式 Proxy：任意 drizzle 查询链 resolve 同一组「万能行」，各 loader 只读自己关心的字段
 */
import { describe, expect, it, vi } from "vitest";

const ROWS = [
  {
    status: "content_ready",
    n: 2,
    day: new Date().toISOString().slice(0, 10),
    id: "c1",
    title: "旧书店的重生",
    template: "scene_word",
    level: "CET4",
    video: { url: "/files/video/v1.mp4", introStatus: "rendered" },
    audio: null,
    audit: { process: { attempts: [{ reason: "词库校验失败" }] } },
    updatedAt: new Date(),
  },
  {
    status: "completed",
    n: 1,
    day: "2020-01-01",
    id: "c2",
    title: "机场英语",
    template: "scene_word",
    level: "CET4",
    video: { url: "/files/video/v2.mp4" },
    audio: null,
    audit: null,
    updatedAt: new Date(),
  },
];

function chain(): unknown {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return (res: (v: unknown) => void) => res(ROWS);
        return () => chain();
      },
    },
  );
}

vi.mock("../db", () => ({ db: { select: () => chain() } }));

const { getDashboardSummary } = await import("./dashboard.service");
const { aggregateReasons, failureReasonOf } = await import("./dashboard.service");

describe("getDashboardSummary", () => {
  it("聚合产出：今日/待推进/成片/模板占比/失败原因/流水线/最近任务", async () => {
    const s = await getDashboardSummary();
    // statusCounts：两行都 status=content_ready/completed → content_ready 计数 2（同值行聚合由 mock 决定，此处验证形状与联动）
    expect(s.today).toBeGreaterThanOrEqual(1); // 万能行 day=今天 一条
    expect(s.completedVideos).toBe(2); // 两行都带 video
    expect(s.topTemplate).toEqual({ name: "scene_word", share: 100 });
    expect(s.failureReasons.length).toBeGreaterThan(0);
    expect(s.pipeline.publishable).toBe(2); // leftJoin 无标记 → 全部可发布
    expect(s.recent).toHaveLength(2);
    expect(s.recent[0]).toMatchObject({ id: "c1", intro: "rendered" });
    expect(s.recent[1]?.intro).toBe("—"); // 无 introStatus 记录回破折号
  });

  it("failureReasonOf：片头失败优先于审计拒绝原因", async () => {
    expect(failureReasonOf({ id: "x", video: { introStatus: "failed" }, audit: null })).toBe(
      "片头生成失败",
    );
    expect(
      failureReasonOf({
        id: "x",
        video: null,
        audit: { process: { attempts: [{ reason: " 主题偏离 " }] } },
      }),
    ).toBe("主题偏离");
    expect(failureReasonOf({ id: "x", video: null, audit: null })).toBe("未记录原因");
    expect(failureReasonOf({ id: "x", video: {}, audit: { process: {} } })).toBe("未记录原因");
  });
});

describe("aggregateReasons", () => {
  it("相同原因计数合并，保持首次出现顺序；单条不带 ×1", () => {
    expect(aggregateReasons(["片头生成失败", "词库校验失败", "片头生成失败"])).toEqual([
      "片头生成失败 ×2",
      "词库校验失败",
    ]);
    expect(aggregateReasons(["超时"])).toEqual(["超时"]);
    expect(aggregateReasons([])).toEqual([]);
  });
});
