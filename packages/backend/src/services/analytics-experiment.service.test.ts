/**
 * analytics-experiment.service 纯函数测试 — A/B 评估与创建校验（Phase 6）
 * 纪律：小样本只给描述统计不下结论；缺指标不补 0；两组内容不得相交；结论恒附相关非因果
 */
import { describe, expect, it, vi } from "vitest";
import type { VideoRowData } from "./analytics-dashboard.service";
import {
  MIN_EXPERIMENT_SAMPLES,
  evaluateExperiment,
  validateExperimentInput,
} from "./analytics-experiment.service";

vi.mock("../db", () => ({ db: {} }));

function row(contentId: string, completion: number | null): VideoRowData {
  return {
    recordId: `pub_${contentId}`,
    contentId,
    platform: "抖音",
    platformVideoId: null,
    title: "t",
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
    createdAt: new Date(),
    cells:
      completion === null
        ? {}
        : {
            completion_rate: {
              value: completion,
              sourceType: "CREATOR_IMPORT",
              isEstimated: false,
              dataDate: null,
            },
          },
  };
}

const rows = [
  ...Array.from({ length: 8 }, (_, i) => row(`a${i}`, 0.5)),
  ...Array.from({ length: 8 }, (_, i) => row(`b${i}`, 0.3)),
  row("a-no", null), // 缺指标样本不入统计
];

describe("evaluateExperiment", () => {
  it("样本充足：给出中位/差值/样本数与描述性 verdict", () => {
    const out = evaluateExperiment(rows, {
      variantA: { label: "A", contentIds: rows.slice(0, 8).map((r) => r.contentId) },
      variantB: { label: "B", contentIds: rows.slice(8, 16).map((r) => r.contentId) },
      targetMetric: "completion_rate",
    });
    expect(out.medianA).toBe(0.5);
    expect(out.medianB).toBe(0.3);
    expect(out.diff).toBeCloseTo(-0.2);
    expect(out.lowSample).toBe(false);
    expect(out.verdict).toContain("低 20.0pp");
    expect(out.note).toContain("不构成因果");
    expect(out.modelVersion).toBe("ab-descriptive-v1");
  });

  it("小样本：lowSample=true 且 verdict 明确「不构成结论」（§十四）", () => {
    const out = evaluateExperiment(rows, {
      variantA: { label: "A", contentIds: ["a0", "a1"] },
      variantB: { label: "B", contentIds: ["b0", "b1"] },
      targetMetric: "completion_rate",
    });
    expect(out.lowSample).toBe(true);
    expect(out.verdict).toContain("样本不足");
    expect(out.verdict).toContain(String(MIN_EXPERIMENT_SAMPLES));
  });

  it("两组均无指标 → 无法评估（不伪造 0 对比）", () => {
    const out = evaluateExperiment(rows, {
      variantA: { label: "A", contentIds: ["ghost1"] },
      variantB: { label: "B", contentIds: ["ghost2"] },
      targetMetric: "completion_rate",
    });
    expect(out.medianA).toBeNull();
    expect(out.medianB).toBeNull();
    expect(out.verdict).toContain("无法评估");
  });
});

describe("validateExperimentInput", () => {
  const base = {
    variable: "hook",
    variantA: { label: "错误示范", contentIds: ["c1"] },
    variantB: { label: "提问", contentIds: ["c2"] },
    targetMetric: "completion_rate",
  };

  it("合法输入零错误", () => {
    expect(validateExperimentInput(base)).toEqual([]);
  });

  it("变量/指标白名单、空分组、两组相交都拒绝", () => {
    expect(validateExperimentInput({ ...base, variable: "vibes" })).toHaveLength(1);
    expect(validateExperimentInput({ ...base, targetMetric: "clicks" })).toHaveLength(1);
    expect(
      validateExperimentInput({ ...base, variantB: { label: "x", contentIds: [] } }),
    ).toHaveLength(1);
    const overlap = validateExperimentInput({
      ...base,
      variantB: { label: "x", contentIds: ["c1", "c2"] },
    });
    expect(overlap[0]).toContain("不能同时属于");
  });
});
