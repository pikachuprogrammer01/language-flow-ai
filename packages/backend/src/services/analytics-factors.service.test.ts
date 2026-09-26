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
});
