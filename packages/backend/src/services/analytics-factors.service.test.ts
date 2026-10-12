/**
 * analytics-factors.service 纯函数测试 — 维度取值与分组统计（页面 D 口径）
 * 纪律（需求 §十四/§十五）：分组统计非因果；每组必携样本数；<8 标 lowSample；缺指标样本剔除
 */
import { describe, expect, it, vi } from "vitest";
import type { VideoRowData } from "./analytics-dashboard.service";
import {
  type FactorDimension,
  computeFactorGroups,
  dimensionValueOf,
} from "./analytics-factors.service";

vi.mock("../db", () => ({ db: {} }));

function row(over: Partial<VideoRowData> & { recordId: string }): VideoRowData {
  return {
    contentId: `cnt_${over.recordId}`,
    platform: "抖音",
    platformVideoId: null,
    title: over.recordId,
    template: "scene_word",
    level: "CET4",
    scene: null,
    contentFormat: null,
    hook: null,
    emotion: null,
    ctaType: null,
    voiceId: null,
    bgm: null,
    subtitleType: null,
    promptVersion: null,
    segmentCount: null,
    speechRate: null,
    durationSec: 30,
    publishTime: null,
    createdAt: new Date("2026-09-01T02:00:00Z"),
    cells: {},
    ...over,
  };
}

const cell = (value: number) => ({
  value,
  sourceType: "CREATOR_IMPORT" as const,
  isEstimated: false,
  dataDate: null,
});

describe("dimensionValueOf", () => {
  it("未标注归入「未标注」桶（不剔除样本）", () => {
    expect(dimensionValueOf(row({ recordId: "a" }), "hook")).toBe("未标注");
    expect(dimensionValueOf(row({ recordId: "a", hook: "mistake" }), "hook")).toBe("mistake");
  });

  it("派生分档：时长带/语速带/段落带/发布时段", () => {
    expect(dimensionValueOf(row({ recordId: "a", durationSec: 48 }), "durationBand")).toBe("30_60");
    expect(dimensionValueOf(row({ recordId: "a", speechRate: 1.25 }), "speechRateBand")).toBe(
      "快（>1.1×）",
    );
    expect(dimensionValueOf(row({ recordId: "a", segmentCount: 8 }), "segmentCountBand")).toBe(
      "多（≥7段）",
    );
    expect(dimensionValueOf(row({ recordId: "a" }), "publishHourBand")).toBe("凌晨 0-6 时");
  });

  it("voice 维度映射 voiceId", () => {
    expect(dimensionValueOf(row({ recordId: "a", voiceId: "female_01" }), "voice")).toBe(
      "female_01",
    );
  });
});

describe("computeFactorGroups", () => {
  const rows = [
    row({ recordId: "r1", hook: "mistake", cells: { completion_rate: cell(0.4) } }),
    row({ recordId: "r2", hook: "mistake", cells: { completion_rate: cell(0.2) } }),
    row({ recordId: "r3", hook: "question", cells: { completion_rate: cell(0.1) } }),
    row({ recordId: "r4", cells: {} }), // 无目标指标 → 剔除
  ];

  it("账号中位/组中位/差值/样本数齐备；缺指标样本不入统计", () => {
    const out = computeFactorGroups(rows, "completion_rate", ["hook"]);
    expect(out.accountSampleCount).toBe(3);
    expect(out.accountMedian).toBeCloseTo(0.2);
    const hook = out.dimensions[0];
    expect(hook?.dimension).toBe("hook");
    const mistake = hook?.groups.find((g) => g.value === "mistake");
    expect(mistake?.sampleCount).toBe(2);
    expect(mistake?.median).toBeCloseTo(0.3);
    expect(mistake?.mean).toBeCloseTo(0.3);
    expect(mistake?.diff).toBeCloseTo(0.1);
    expect(mistake?.lowSample).toBe(true); // 2 < 8
    // 未标注桶存在（r4 无指标不入任何组）
    expect(hook?.groups.find((g) => g.value === "未标注")).toBeUndefined();
  });

  it("空样本 → 中位 null，不伪造 0", () => {
    const out = computeFactorGroups([], "completion_rate", ["scene"]);
    expect(out.accountMedian).toBeNull();
    expect(out.dimensions[0]?.groups).toEqual([]);
    expect(out.note).toContain("相关性");
    expect(out.note).toContain("不构成因果");
  });

  it("多维度并行输出（页面 D 因子卡）", () => {
    const dims: FactorDimension[] = ["hook", "durationBand", "template"];
    const out = computeFactorGroups(rows, "completion_rate", dims);
    expect(out.dimensions.map((d) => d.dimension)).toEqual(dims);
    expect(out.dimensions[2]?.groups[0]?.value).toBe("scene_word");
  });

  it("每组带 recordIds：推荐证据要能回连到具体发布记录与导入行", () => {
    const out = computeFactorGroups(rows, "completion_rate", ["hook"]);
    const mistake = out.dimensions[0]?.groups.find((g) => g.value === "mistake");
    expect(mistake?.recordIds).toEqual(["r1", "r2"]);
  });

  it("估算值计入覆盖面样本，但不计入行动门槛的真实样本", () => {
    const estimated = (value: number) => ({
      value,
      sourceType: "CREATOR_IMPORT" as const,
      isEstimated: true,
      dataDate: null,
    });
    const many = Array.from({ length: 10 }, (_, i) =>
      row({
        recordId: `e${i}`,
        hook: "mistake",
        cells: { completion_rate: i < 3 ? estimated(0.9) : cell(0.1) },
      }),
    );
    const out = computeFactorGroups(many, "completion_rate", ["hook"], {
      platform: "抖音",
      windowDays: 30,
    });
    const mistake = out.dimensions[0]?.groups.find((g) => g.value === "mistake");
    // 10 条都有值 → 覆盖面 10；其中 3 条是估算 → 真实样本只有 7，不足 8
    expect(mistake?.sampleCount).toBe(10);
    expect(mistake?.realSampleCount).toBe(7);
    expect(mistake?.lowSample).toBe(true);
    expect(out.accountRealSampleCount).toBe(7);
  });

  it("7 个真实样本仍是低样本（门槛按非估算值数，四舍五入不算过关）", () => {
    const seven = Array.from({ length: 7 }, (_, i) =>
      row({ recordId: `s${i}`, hook: "mistake", cells: { completion_rate: cell(0.3) } }),
    );
    const out = computeFactorGroups(seven, "completion_rate", ["hook"]);
    expect(out.dimensions[0]?.groups[0]?.lowSample).toBe(true);
  });

  it("8 个真实样本达到门槛 → 不再标 lowSample", () => {
    const eight = Array.from({ length: 8 }, (_, i) =>
      row({ recordId: `g${i}`, hook: "mistake", cells: { completion_rate: cell(0.3) } }),
    );
    const out = computeFactorGroups(eight, "completion_rate", ["hook"]);
    expect(out.dimensions[0]?.groups[0]?.lowSample).toBe(false);
  });

  it("样本跨平台时 note 明示不可比（这是拒绝出参数建议的依据）", () => {
    const mixed = [
      row({ recordId: "d1", platform: "抖音", cells: { completion_rate: cell(0.4) } }),
      row({ recordId: "k1", platform: "快手", cells: { completion_rate: cell(0.2) } }),
    ];
    const out = computeFactorGroups(mixed, "completion_rate", ["hook"]);
    expect(out.mixedPlatform).toBe(true);
    expect(out.note).toContain("口径不可比");
    expect(out.note).toContain("不作为参数改动依据");
  });

  it("响应自述统计范围：平台与窗口原样回显，不隐含收窄也不假装全量", () => {
    const out = computeFactorGroups(rows, "completion_rate", ["hook"], {
      platform: "抖音",
      windowDays: 30,
    });
    expect(out.scope).toEqual({ platform: "抖音", windowDays: 30 });
    expect(out.mixedPlatform).toBe(false);
    const unspecified = computeFactorGroups(rows, "completion_rate", ["hook"]);
    expect(unspecified.scope).toEqual({ platform: null, windowDays: null });
  });
});
