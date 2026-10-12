/**
 * analytics-recommend.service 纯函数测试 — 最优组选择 / 建议清单诚实性 / 结构骨架
 * 纪律：非估算真实样本 <8 不出参数建议（§十四）；跨平台混合或未声明窗口只给
 * data_readiness（docs/22 §6.2）；建议必携 reason + sourceSampleCount + sourceMetric
 */
import { describe, expect, it, vi } from "vitest";
import {
  type FactorGroup,
  MIN_GROUP_SAMPLES,
  computeFactorGroups,
} from "./analytics-factors.service";
import {
  buildRecommendations,
  buildStructureSkeleton,
  pickBestGroup,
  recommendDraftsFromPayload,
  scopeTextOf,
  valueLabelOf,
} from "./analytics-recommend.service";

vi.mock("../db", () => ({ db: {} }));

function group(
  value: string,
  median: number,
  /** 真实（非估算）样本数：行动门槛只看这个 */
  realSampleCount: number,
  coveredSampleCount = realSampleCount,
): FactorGroup {
  return {
    value,
    sampleCount: coveredSampleCount,
    realSampleCount,
    median,
    mean: median,
    diff: 0,
    lowSample: realSampleCount < MIN_GROUP_SAMPLES,
    recordIds: [],
  };
}

describe("pickBestGroup", () => {
  it("剔除未标注与低真实样本组；中位数最高者胜", () => {
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

  it("覆盖面样本够但真实样本不足 8（估算值凑数）→ null", () => {
    expect(pickBestGroup([group("mistake", 0.9, 5, 40)])).toBeNull();
  });
});

describe("scopeTextOf", () => {
  it("平台与窗口都写进文案，未限时如实说未限定", () => {
    expect(scopeTextOf({ platform: "抖音", windowDays: 30 })).toBe("抖音 · 近 30 天");
    expect(scopeTextOf({ platform: null, windowDays: null })).toBe("未限定平台 · 全部历史");
  });
});

type RowInput = Parameters<typeof buildRecommendations>[0];

function row(over: Partial<RowInput[number]> & { recordId: string }): RowInput[number] {
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
    cells: { completion_rate: cellValue(0.4) },
    ...over,
  } as RowInput[number];
}

function cellValue(value: number, isEstimated = false) {
  return {
    value,
    sourceType: "CREATOR_IMPORT" as const,
    isEstimated,
    dataDate: null,
  };
}

const DOUYIN_90D = { platform: "抖音", windowDays: 90 };

function rowsWithHook(hook: string, count: number, value: number, isEstimated = false) {
  return Array.from({ length: count }, (_, i) =>
    row({
      recordId: `${hook}${i}`,
      hook,
      cells: { completion_rate: cellValue(value, isEstimated) },
    }),
  );
}

describe("buildRecommendations", () => {
  it("同平台同窗口 8 个真实样本 → actionable，且 reason 自带口径", () => {
    const drafts = buildRecommendations(
      [...rowsWithHook("mistake", 8, 0.5), ...rowsWithHook("question", 9, 0.2)],
      "completion_rate",
      DOUYIN_90D,
    );
    const hook = drafts.find((d) => d.recommendationType === "hook");
    expect(hook?.recommendation.value).toBe("mistake");
    expect(hook?.recommendation.label).toBe("错误示范");
    expect(hook?.kind).toBe("actionable");
    expect(hook?.sourceSampleCount).toBeGreaterThanOrEqual(MIN_GROUP_SAMPLES);
    expect(hook?.reason).toContain("抖音 · 近 90 天");
    expect(hook?.reason).toContain("不是因果结论");
    expect(hook?.sourceMetric).toBe("completion_rate");
  });

  it("7 个真实样本 → 只产出 data_readiness（不给参数改动结论）", () => {
    const drafts = buildRecommendations(
      rowsWithHook("mistake", 7, 0.5),
      "completion_rate",
      DOUYIN_90D,
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.kind).toBe("data_readiness");
    expect(drafts[0]?.recommendationType).toBe("data_readiness");
    expect(drafts[0]?.reason).toContain("最小真实样本量");
    expect(drafts[0]?.confidence).toBeNull();
  });

  it("估算值堆不过门槛：10 条里有 3 条估算 → 真实 7 条，仍只给 data_readiness", () => {
    const mixedEstimate = [
      ...rowsWithHook("mistake", 3, 0.9, true),
      ...rowsWithHook("mistake", 7, 0.1),
    ];
    const drafts = buildRecommendations(mixedEstimate, "completion_rate", DOUYIN_90D);
    expect(drafts[0]?.recommendationType).toBe("data_readiness");
    expect(drafts[0]?.reason).toContain("估算值，不计入行动门槛");
  });

  it("跨平台样本集 → 拒绝出参数建议（口径不可比）", () => {
    const twoPlatforms = [
      ...rowsWithHook("mistake", 8, 0.5),
      ...rowsWithHook("mistake", 8, 0.9, false).map((r) => ({ ...r, platform: "快手" })),
    ];
    const drafts = buildRecommendations(twoPlatforms, "completion_rate", DOUYIN_90D);
    expect(drafts.every((d) => d.kind === "data_readiness")).toBe(true);
    expect(drafts[0]?.reason).toContain("口径不可比");
    expect(drafts[0]?.reason).toContain("快手");
  });

  it("未指定 days 时「全部历史」也算一个明示窗口：同平台够样本仍可出建议", () => {
    const drafts = buildRecommendations(rowsWithHook("mistake", 9, 0.5), "completion_rate", {
      platform: "抖音",
      windowDays: null,
    });
    expect(drafts.some((d) => d.kind === "actionable")).toBe(true);
    expect(drafts.find((d) => d.kind === "actionable")?.reason).toContain("全部历史");
  });

  it("空数据同样产出数据准备建议", () => {
    const drafts = buildRecommendations([], "completion_rate", DOUYIN_90D);
    expect(drafts[0]?.recommendationType).toBe("data_readiness");
  });

  it("建议文案禁用因果措辞（只允许相关/观察/建议）", () => {
    const drafts = buildRecommendations(
      [...rowsWithHook("mistake", 9, 0.5), ...rowsWithHook("question", 9, 0.2)],
      "completion_rate",
      DOUYIN_90D,
    );
    for (const d of drafts) {
      for (const banned of ["导致", "保证提升", "一定会", "因果证明"]) {
        expect(d.reason).not.toContain(banned);
      }
    }
  });
});

describe("recommendDraftsFromPayload（生成链路复用同一份分组结果）", () => {
  it("与 buildRecommendations 同口径：不重复算统计也能出同样的建议", () => {
    const rows = [...rowsWithHook("mistake", 9, 0.5), ...rowsWithHook("question", 8, 0.2)];
    const scope = DOUYIN_90D;
    const payload = computeFactorGroups(rows, "completion_rate", ["hook"], scope);
    const fromPayload = recommendDraftsFromPayload(payload);
    expect(fromPayload.find((d) => d.recommendationType === "hook")?.recommendation.value).toBe(
      "mistake",
    );
    // 只给了 hook 一个维度时不会凭空产出别的维度的建议
    expect(
      fromPayload.every((d) => d.recommendationType === "hook" || d.kind === "data_readiness"),
    ).toBe(true);
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
