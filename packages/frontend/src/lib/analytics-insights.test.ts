/**
 * analytics-insights 展示层纯函数测试 — 来源标签 / 无数据语义 / 环比与差值格式 / 趋势图几何
 * 核心纪律（需求 §二十六）：null/缺失一律「暂无数据」，绝不产出假的 0 或假曲线
 */
import { describe, expect, it } from "vitest";
import {
  emptyReasonLabel,
  formatByKind,
  formatChange,
  formatCount,
  formatDiff,
  formatRate,
  funnelBarWidth,
  funnelCoverageText,
  funnelStepHint,
  funnelStepRateText,
  sourceLabel,
  trendGeometry,
} from "./analytics-insights";

describe("来源与空态标签", () => {
  it("五类 source_type 全量中文化（抖音通道已砍除，DOUYIN_* 不再提供映射）", () => {
    expect(sourceLabel("CREATOR_IMPORT")).toBe("创作者导入");
    expect(sourceLabel("PLATFORM_PRODUCTION")).toBe("生产参数");
    expect(sourceLabel("PLATFORM_CALCULATED")).toBe("平台计算");
    expect(sourceLabel("USER_INPUT")).toBe("手动录入");
    expect(sourceLabel("AI_EXTRACTED")).toBe("AI 提取");
    expect(sourceLabel("DOUYIN_OPEN_API")).toBe("DOUYIN_OPEN_API");
    expect(sourceLabel("MYSTERY")).toBe("MYSTERY");
    expect(sourceLabel(null)).toBe("未知来源");
  });

  it("Empty State 原因可解释（尚未同步/平台不提供/未导入/样本不足）", () => {
    expect(emptyReasonLabel("not_imported")).toBe("创作者尚未导入数据");
    expect(emptyReasonLabel("no_metrics")).toBe("已发布但尚未导入任何指标");
    expect(emptyReasonLabel("low_sample")).toBe("样本不足");
    expect(emptyReasonLabel(null)).toBe("");
    expect(emptyReasonLabel("custom_code")).toBe("custom_code");
  });
});

describe("格式化：null ≠ 0", () => {
  it("计数/比例/秒：无数据统一「暂无数据」", () => {
    expect(formatCount(null)).toBe("暂无数据");
    expect(formatRate(undefined)).toBe("暂无数据");
    expect(formatCount(0)).toBe("0"); // 真实的 0 依然显示 0（导入值为 0 是数据）
    expect(formatRate(0.413)).toBe("41.3%");
    expect(formatByKind(33.5, "seconds")).toBe("33.5s");
    expect(formatByKind(null, "count")).toBe("暂无数据");
  });

  it("环比缺对比 → —（不是 0%）", () => {
    expect(formatChange(null)).toBe("—");
    expect(formatChange(0.667)).toBe("+66.7%");
    expect(formatChange(-0.2)).toBe("-20.0%");
  });

  it("差值：比例按百分点 pp，计数按千分位", () => {
    expect(formatDiff(0.11, "rate")).toBe("+11.0pp");
    expect(formatDiff(-0.02, "rate")).toBe("-2.0pp");
    expect(formatDiff(1200, "count")).toBe("+1,200");
    expect(formatDiff(null, "rate")).toBe("—");
  });
});

describe("趋势图几何（缺日无点，不补 0）", () => {
  it("空序列 → 空线空点", () => {
    expect(trendGeometry([])).toEqual({ line: "", dots: [] });
  });

  it("单点居中不画线（避免假斜率）", () => {
    const geo = trendGeometry([{ date: "2026-09-20", value: 120 }], 100, 50, 5);
    expect(geo.line).not.toContain(" "); // 只有一个坐标对
    expect(geo.dots).toHaveLength(1);
    expect(geo.dots[0]?.cx).toBe(50);
  });

  it("全同值水平线居中（不把 min=max 夸大成满幅）", () => {
    const geo = trendGeometry(
      [
        { date: "2026-09-20", value: 50 },
        { date: "2026-09-21", value: 50 },
        { date: "2026-09-22", value: 50 },
      ],
      100,
      50,
      5,
    );
    expect(new Set(geo.dots.map((d) => d.cy))).toEqual(new Set([25]));
    expect(geo.dots.map((d) => d.cx)).toEqual([5, 50, 95]);
  });

  it("日期轴线性分布 + 值域映射（首点左下末点右上）", () => {
    const geo = trendGeometry(
      [
        { date: "2026-09-20", value: 0 },
        { date: "2026-09-22", value: 100 },
      ],
      100,
      100,
      10,
    );
    expect(geo.dots[0]).toMatchObject({ cx: 10, cy: 90 });
    expect(geo.dots[1]).toMatchObject({ cx: 90, cy: 10 });
  });
});

describe("漏斗条宽", () => {
  it("null → 0%；小占比保底可见；上限 100%", () => {
    expect(funnelBarWidth(null)).toBe("0%");
    expect(funnelBarWidth(0.0001)).toBe("2.0%");
    expect(funnelBarWidth(1.5)).toBe("100.0%");
    expect(funnelBarWidth(0.62)).toBe("62.0%");
  });
});

describe("漏斗逐级转化可比性（审查批次 1B：不可比绝不截断伪装）", () => {
  const base = {
    key: "completed",
    label: "完播",
    kind: "rate" as const,
    value: 170.64,
    previousValue: null,
    stepRate: null,
    shareOfPlays: 0.36,
    coverageCount: 1,
    windowRecordCount: 2,
    basisPlays: 474,
    changePct: null,
    sourceTypes: ["CREATOR_IMPORT"],
    emptyReason: null,
  };

  it("computed 才给百分比；其余状态一律「—」并附原因文案", () => {
    expect(funnelStepRateText({ ...base, stepRate: 0.5806, stepRateState: "computed" })).toBe(
      "58.1%",
    );
    for (const state of ["coverage-mismatch", "inverted", "missing", "standalone"] as const) {
      const stage = { ...base, stepRateState: state };
      expect(funnelStepRateText(stage)).toBe("—");
      expect(funnelStepHint(stage).length).toBeGreaterThan(0);
    }
    expect(funnelStepHint({ ...base, stepRateState: "computed" })).toBe("");
  });

  it("倒挂提示文案点名「口径倒挂」，覆盖错位提示点名「覆盖的记录不同」", () => {
    expect(funnelStepHint({ ...base, stepRateState: "inverted" })).toContain("倒挂");
    expect(funnelStepHint({ ...base, stepRateState: "coverage-mismatch" })).toContain("覆盖");
  });

  it("覆盖/折算基数文案：rate 阶段带播放基数；creator 阶段带导入天数", () => {
    expect(funnelCoverageText(base)).toBe("覆盖 1/2 条记录 · 基于 474 次播放折算");
    expect(
      funnelCoverageText({
        ...base,
        kind: "creator",
        coverageCount: 4,
        basisPlays: null,
      }),
    ).toBe("窗口内 4 天导入");
    expect(funnelCoverageText({ ...base, kind: "count", coverageCount: 2, basisPlays: 3474 })).toBe(
      "覆盖 2/2 条记录",
    );
  });
});
