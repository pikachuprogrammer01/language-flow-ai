/**
 * import-batch 前端纯函数测试 — 步骤状态机 / 粒度文案 / evidence 人话翻译 / 行动作红线 / 格式化
 * 重点断言：账号日级永无 assign（禁止归属单个视频的前端红线）；证据翻译不丢项
 */
import { describe, expect, it } from "vitest";
import {
  canCommit,
  canGotoStep,
  evidenceChecklist,
  formatDuration,
  formatFileSize,
  granularityMeta,
  rowActions,
  statusPillMeta,
  stepOfBatchStatus,
  stepperStates,
} from "./import-batch";

describe("stepOfBatchStatus / 步进器", () => {
  it("批次状态 → 步骤映射全覆盖", () => {
    expect(stepOfBatchStatus("draft")).toBe(1);
    expect(stepOfBatchStatus("granularity_confirmed")).toBe(2);
    expect(stepOfBatchStatus("rules_set")).toBe(2);
    expect(stepOfBatchStatus("prematched")).toBe(3);
    expect(stepOfBatchStatus("preflight_ok")).toBe(4);
    expect(stepOfBatchStatus("committed")).toBe(4);
    expect(stepOfBatchStatus("rolled_back")).toBe(4);
  });

  it("已到达步骤可点回，未到达锁定", () => {
    expect(canGotoStep(2, 3)).toBe(true);
    expect(canGotoStep(4, 3)).toBe(false);
    const states = stepperStates(3 as const, 2 as const);
    expect(states[1]).toBe("done");
    expect(states[2]).toBe("current");
    expect(states[3]).toBe("done");
    expect(states[4]).toBe("locked");
  });
});

describe("granularityMeta", () => {
  it("三态文案：强=绿可精准匹配；弱=橙全需人工确认；账号日=红禁止归属", () => {
    expect(granularityMeta("work_level_strong").tone).toBe("success");
    expect(granularityMeta("work_level_weak").tone).toBe("warning");
    const day = granularityMeta("account_day_level");
    expect(day.tone).toBe("danger");
    expect(day.headline).toBe("无法精确归属到单条作品");
    expect(day.note).toContain("禁止");
  });
});

describe("evidenceChecklist", () => {
  it("结构化证据逐条翻译（含 ✓/✗），不展示裸置信度", () => {
    const items = evidenceChecklist({
      platformWorkIdExact: true,
      accountMapped: true,
      mappedAccount: "主账号",
      publishTimeDiffSeconds: 22,
      titleSimilarity: 0.96,
    });
    expect(items.map((i) => i.text)).toEqual([
      "平台作品 ID 一致",
      "账号已经映射（主账号）",
      "发布时间相差 22 秒",
      "标题相似度 96.0%（编辑距离口径）",
    ]);
    expect(items.every((i) => i.ok)).toBe(true);
  });

  it("账号未映射与作品 ID 缺失为 ✗ 项（诚实展示弱项）", () => {
    const items = evidenceChecklist({
      accountMapped: false,
      workIdMissing: true,
      dateMatched: true,
      titleSimilarity: 1,
    });
    expect(items.find((i) => i.text.includes("账号"))?.ok).toBe(false);
    expect(items.find((i) => i.text === "作品 ID 缺失")?.ok).toBe(false);
  });

  it("null 值项跳过（无数据不渲染）", () => {
    expect(evidenceChecklist({ publishTimeDiffSeconds: null, titleSimilarity: undefined })).toEqual(
      [],
    );
  });

  it("无账号列（accountMapped=null）不渲染账号项；未登记（false）才显示 ✗", () => {
    expect(evidenceChecklist({ platformWorkIdExact: true, accountMapped: null })).toEqual([
      { ok: true, text: "平台作品 ID 一致" },
    ]);
    expect(evidenceChecklist({ accountMapped: false })[0]).toEqual({
      ok: false,
      text: "账号未在映射表中登记",
    });
  });
});

describe("rowActions 红线", () => {
  it("账号日级行：只有 accountDay/ignore，绝无 assign/confirm", () => {
    const actions = rowActions("account_day_level", false);
    expect(actions.assign).toBe(false);
    expect(actions.confirm).toBe(false);
    expect(actions.accountDay).toBe(true);
    expect(actions.ignore).toBe(true);
  });

  it("conflict 行：assign/external/accountDay/ignore 全开；unique 行只 confirm", () => {
    const conflict = rowActions("conflict", false);
    expect(conflict.assign).toBe(true);
    expect(conflict.external).toBe(true);
    const unique = rowActions("unique_match", false);
    expect(unique.confirm).toBe(true);
    expect(unique.assign).toBe(false);
  });

  it("已裁决行可 reset 回系统建议", () => {
    expect(rowActions("confirmed", true).reset).toBe(true);
    expect(rowActions("conflict", false).reset).toBe(false);
  });
});

describe("状态 pill 与杂项", () => {
  it("六态全覆盖且命名对齐需求书", () => {
    expect(statusPillMeta("unique_match").label).toBe("唯一匹配");
    expect(statusPillMeta("conflict").label).toBe("待确认");
    expect(statusPillMeta("unmatched").label).toBe("未匹配");
    expect(statusPillMeta("account_day_level").label).toBe("账号日级");
    expect(statusPillMeta("confirmed").label).toBe("已确认");
    expect(statusPillMeta("ignored").label).toBe("已忽略");
  });

  it("canCommit 只在报告 pass 时放行", () => {
    expect(canCommit(null)).toBe(false);
    expect(canCommit({ pass: false })).toBe(false);
    expect(canCommit({ pass: true })).toBe(true);
  });

  it("文件大小/时长人话格式化", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2_411_520)).toBe("2.3 MB");
    expect(formatDuration(58)).toBe("00:58");
    expect(formatDuration(null)).toBe("—");
  });
});
