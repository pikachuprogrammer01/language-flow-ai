/**
 * analytics-dashboard.service 纯函数测试 — 漏斗组装 / 同类分组 / 统计口径
 * 覆盖需求 §十一（漏斗与环比）、§十五（账号自身 Benchmark 分组）、§二十六（无数据 ≠ 0）
 * 批次 5A 后 /videos 排序与 /overview 窗口过滤已下推 SQL：排序语义（缺数据恒排末/
 * 无发布时间回退创建时间）由 E2E 页面 B 断言 + 新旧 API 对拍验收，不再在此内存测
 */
import { describe, expect, it, vi } from "vitest";
import type { MetricSourceType } from "../lib/analytics-taxonomy";
import {
  buildFunnelStages,
  durationBandOf,
  isSameGroup,
  meanOf,
  medianOf,
} from "./analytics-dashboard.service";

vi.mock("../db", () => ({ db: {} }));

type FunnelInput = Parameters<typeof buildFunnelStages>[0][number];

let inputSeq = 0;

function input(
  cells: Record<string, { value: number; sourceType?: MetricSourceType; isEstimated?: boolean }>,
): FunnelInput {
  const metrics: Record<
    string,
    { value: number; sourceType: MetricSourceType; isEstimated: boolean; dataDate: null }
  > = {};
  for (const [name, cell] of Object.entries(cells)) {
    metrics[name] = {
      value: cell.value,
      sourceType: cell.sourceType ?? "CREATOR_IMPORT",
      isEstimated: cell.isEstimated ?? false,
      dataDate: null,
    };
  }
  inputSeq += 1;
  return {
    recordId: `rec-${inputSeq}`,
    publishTime: null,
    createdAt: new Date("2026-09-20T00:00:00Z"),
    metrics,
  };
}

const NO_FANS = { current: null, previous: null, currentDays: 0 };

describe("buildFunnelStages", () => {
  it("齐备数据：Σ播放、Σ播放×比例 逐级求和；覆盖一致时 stepRate/share 可比", () => {
    const current = [
      input({
        play_count: { value: 1000 },
        effective_play_rate_2s: { value: 0.8 },
        completion_rate: { value: 0.5 },
        profile_visit_count: { value: 20, sourceType: "PLATFORM_CALCULATED" },
      }),
      input({
        play_count: { value: 500 },
        effective_play_rate_2s: { value: 0.6 },
      }),
    ];
    const stages = buildFunnelStages(current, [], NO_FANS);
    const plays = stages.find((s) => s.key === "plays");
    const effective = stages.find((s) => s.key === "effective_2s");
    expect(plays?.value).toBe(1500);
    expect(plays?.stepRateState).toBe("first");
    expect(plays?.shareOfPlays).toBe(1);
    expect(plays?.coverageCount).toBe(2);
    expect(plays?.windowRecordCount).toBe(2);
    // 两阶段覆盖记录集一致（都含 r1+r2）→ 可比；1000×0.8 + 500×0.6 = 1100
    expect(effective?.value).toBe(1100);
    expect(effective?.stepRateState).toBe("computed");
    expect(effective?.stepRate).toBeCloseTo(1100 / 1500);
    expect(effective?.basisPlays).toBe(1500);
    expect(effective?.shareOfPlays).toBeCloseTo(1100 / 1500);
    // 完播：仅第一条有 completion_rate → Σ=500；上一阶段（5秒）无数据 → missing 不可比
    const completed = stages.find((s) => s.key === "completed");
    expect(completed?.value).toBe(500);
    expect(completed?.coverageCount).toBe(1);
    expect(completed?.basisPlays).toBe(1000);
    expect(completed?.stepRate).toBeNull();
    expect(completed?.stepRateState).toBe("missing");
    expect(completed?.shareOfPlays).toBeCloseTo(0.5);
    // 主页访问来源集合如实标注
    expect(stages.find((s) => s.key === "profile_visits")?.sourceTypes).toContain(
      "PLATFORM_CALCULATED",
    );
    // 空窗口对比 → changePct null（不是 -100%）
    expect(completed?.previousValue).toBeNull();
    expect(completed?.changePct).toBeNull();
  });

  it("覆盖记录集不一致 → stepRate null + coverage-mismatch（不硬算转化也不截断）", () => {
    // 播放覆盖两条记录，2秒只有第一条有比例 → 不可比（114% 类错位的路径之一）
    const current = [
      input({
        play_count: { value: 12000 },
        effective_play_rate_2s: { value: 0.82 },
      }),
      input({ play_count: { value: 3000 } }),
    ];
    const stages = buildFunnelStages(current, [], NO_FANS);
    const effective = stages.find((s) => s.key === "effective_2s");
    expect(effective?.value).toBe(9840);
    expect(effective?.stepRate).toBeNull();
    expect(effective?.stepRateState).toBe("coverage-mismatch");
    expect(effective?.coverageCount).toBe(1);
    expect(effective?.windowRecordCount).toBe(2);
    // 占比分母改用覆盖播放 12000（而非混合覆盖的 15000）→ 不被低估
    expect(effective?.basisPlays).toBe(12000);
    expect(effective?.shareOfPlays).toBeCloseTo(0.82);
  });

  it("同覆盖但源数据倒挂（完播率 > 5秒观看率）→ inverted，绝不产出 >100% 转化", () => {
    const current = [
      input({
        play_count: { value: 474 },
        watch_rate_5s: { value: 0.3159 },
        completion_rate: { value: 0.36 },
      }),
    ];
    const stages = buildFunnelStages(current, [], NO_FANS);
    const five = stages.find((s) => s.key === "watch_5s");
    const completed = stages.find((s) => s.key === "completed");
    expect(five?.value).toBe(149.74);
    expect(completed?.value).toBe(170.64);
    expect(completed?.stepRate).toBeNull();
    expect(completed?.stepRateState).toBe("inverted");
    // 全部阶段都不存在 >1 的 stepRate
    expect(stages.every((s) => s.stepRate === null || s.stepRate <= 1)).toBe(true);
  });

  it("全部缺比例 → 该阶段 value=null + emptyReason，不落 0", () => {
    const stages = buildFunnelStages([input({ play_count: { value: 10 } })], [], NO_FANS);
    const five = stages.find((s) => s.key === "watch_5s");
    expect(five?.value).toBeNull();
    expect(five?.emptyReason).toBe("missing_rate_or_plays");
    expect(five?.sourceTypes).toEqual([]);
    expect(five?.coverageCount).toBe(0);
    const follows = stages.find((s) => s.key === "follows");
    expect(follows?.value).toBeNull();
    expect(follows?.emptyReason).toBe("not_imported");
    expect(follows?.note).toContain("不含单视频归因");
  });

  it("账号增长独立项：不入观看漏斗链路，无 stepRate/shareOfPlays，环比与天数保留", () => {
    const stages = buildFunnelStages([], [], { current: 120, previous: 100, currentDays: 5 });
    const follows = stages.find((s) => s.key === "follows");
    expect(follows?.value).toBe(120);
    expect(follows?.previousValue).toBe(100);
    expect(follows?.stepRate).toBeNull();
    expect(follows?.stepRateState).toBe("standalone");
    expect(follows?.shareOfPlays).toBeNull();
    expect(follows?.basisPlays).toBeNull();
    expect(follows?.coverageCount).toBe(5);
    expect(follows?.changePct).toBeCloseTo(0.2);
    expect(follows?.sourceTypes).toEqual(["CREATOR_IMPORT"]);
  });
});

describe("同类分组与统计（需求 §十五/§十四）", () => {
  it("时长带分档边界", () => {
    expect(durationBandOf(14.9)).toBe("lt_15");
    expect(durationBandOf(15)).toBe("15_30");
    expect(durationBandOf(30)).toBe("30_60");
    expect(durationBandOf(60)).toBe("60_120");
    expect(durationBandOf(120)).toBe("gte_120");
    expect(durationBandOf(null)).toBeNull();
  });

  it("scene/形态未标注时不参与过滤（未标注 ≠ 不匹配）", () => {
    const subject = {
      contentId: "a",
      template: "scene_word",
      scene: "restaurant",
      contentFormat: null,
      durationBand: "30_60",
    };
    expect(isSameGroup(subject, { ...subject, contentId: "b", scene: "restaurant" })).toBe(true);
    expect(isSameGroup(subject, { ...subject, contentId: "b", scene: null })).toBe(true);
    expect(isSameGroup(subject, { ...subject, contentId: "b", scene: "hotel" })).toBe(false);
    expect(isSameGroup(subject, { ...subject, contentId: "b", template: "word_card" })).toBe(false);
    expect(isSameGroup(subject, { ...subject, contentId: "b", durationBand: "15_30" })).toBe(false);
  });

  it("中位数/均值：偶数取中间均值，空集 null（不是 0）", () => {
    expect(medianOf([1, 2, 3])).toBe(2);
    expect(medianOf([1, 2, 3, 4])).toBe(2.5);
    expect(medianOf([])).toBeNull();
    expect(meanOf([2, 4])).toBe(3);
    expect(meanOf([])).toBeNull();
  });
});
