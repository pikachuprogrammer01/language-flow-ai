/**
 * analytics-recommend.service 纯函数测试 — 最优组选择 / 建议清单诚实性 / 结构骨架
 * 纪律：样本 <8 不出参数建议（§十四）；无合格组 → data_readiness 建议（不硬凑）；
 * 建议必携 reason + sourceSampleCount + sourceMetric（§八.8/§十二）
 */
import { describe, expect, it, vi } from "vitest";
import type { FactorGroup } from "./analytics-factors.service";
import {
  MIN_GROUP_SAMPLES,
  buildRecommendations,
  buildStructureSkeleton,
  pickBestGroup,
  valueLabelOf,
} from "./analytics-recommend.service";

vi.mock("../db", () => ({ db: {} }));

function group(value: string, median: number, sampleCount: number): FactorGroup {
  return {
    value,
    sampleCount,
    median,
    mean: median,
    diff: 0,
    lowSample: sampleCount < MIN_GROUP_SAMPLES,
  };
}

describe("pickBestGroup", () => {
  it("剔除未标注与低样本组；中位数最高者胜", () => {
    const best = pickBestGroup([
      group("未标注", 0.9, 30),
      group("mistake", 0.5, 10),
      group("question", 0.3, 20),
    ]);
    expect(best?.value).toBe("mistake");
  });

  it("全部低样本 → null（小样本不下结论）", () => {
    expect(pickBestGroup([group("mistake", 0.9, 3)])).toBeNull();
  });
});

type RowInput = Parameters<typeof buildRecommendations>[0];

function row(over: Partial<RowInput[number]> & { recordId: string }): RowInput[number] {
  const cell = (value: number) => ({
    value,
    sourceType: "CREATOR_IMPORT" as const,
    isEstimated: false,
    dataDate: null,
  });
  return {
    contentId: `cnt_${over.recordId}`,
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
    cells: { completion_rate: cell(0.4) },
    ...over,
  } as RowInput[number];
}

describe("buildRecommendations", () => {
  it("充足样本：每个合格维度出一条带理由/样本数的建议", () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, i) =>
        row({
          recordId: `m${i}`,
          hook: "mistake",
          cells: {
            completion_rate: {
              value: 0.5,
              sourceType: "CREATOR_IMPORT",
              isEstimated: false,
              dataDate: null,
            },
          },
        }),
      ),
      ...Array.from({ length: 9 }, (_, i) =>
        row({
          recordId: `q${i}`,
          hook: "question",
          cells: {
            completion_rate: {
              value: 0.2,
              sourceType: "CREATOR_IMPORT",
              isEstimated: false,
              dataDate: null,
            },
          },
        }),
      ),
    ];
    const drafts = buildRecommendations(rows);
    const hook = drafts.find((d) => d.recommendationType === "hook");
    expect(hook?.recommendation.value).toBe("mistake");
    expect(hook?.recommendation.label).toBe("错误示范");
    expect(hook?.sourceSampleCount).toBeGreaterThanOrEqual(MIN_GROUP_SAMPLES);
    expect(hook?.reason).toContain("中位");
    expect(hook?.sourceMetric).toBe("completion_rate");
  });

  it("样本不足 → 只产出 data_readiness 诚实建议（不硬凑参数建议）", () => {
    const drafts = buildRecommendations([row({ recordId: "a", hook: "mistake" })]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.recommendationType).toBe("data_readiness");
    expect(drafts[0]?.reason).toContain("最小样本量");
    expect(drafts[0]?.confidence).toBeNull();
  });

  it("空数据同样产出数据准备建议", () => {
    const drafts = buildRecommendations([]);
    expect(drafts[0]?.recommendationType).toBe("data_readiness");
  });
});

describe("buildStructureSkeleton", () => {
  const segments = [
    { idx: 0, segmentType: "intro", startTime: 0, endTime: 1, knowledgePoint: null },
    { idx: 1, segmentType: "story_segment", startTime: 1, endTime: 25, knowledgePoint: "flight" },
    { idx: 2, segmentType: "story_segment", startTime: 25, endTime: 48, knowledgePoint: null },
  ] as const;

  it("片头保留标签，正文连续编号；占比合计≈1", () => {
    const skeleton = buildStructureSkeleton([...segments], 48);
    expect(skeleton[0]?.label).toBe("片头");
    expect(skeleton[1]?.label).toBe("正文第 1 段");
    expect(skeleton[2]?.label).toBe("正文第 2 段");
    const shareSum = skeleton.reduce((s, x) => s + x.durationShare, 0);
    expect(shareSum).toBeCloseTo(1, 2);
    expect(skeleton[1]?.knowledgePoint).toBe("flight");
  });

  it("无段落或零时长 → 空骨架（不造结构）", () => {
    expect(buildStructureSkeleton([], 48)).toEqual([]);
    expect(buildStructureSkeleton([...segments], 0)).toEqual([]);
  });

  it("valueLabelOf：已知值中文化，未知值原样", () => {
    expect(valueLabelOf("airport")).toBe("机场");
    expect(valueLabelOf("custom_x")).toBe("custom_x");
  });
});
