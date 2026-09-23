/**
 * 状态映射工具单测 — statusVariant / 中文标签 / 相对时间（列表与工作台共用口径）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STATUS_LABEL, TEMPLATE_LABEL, relativeTime, statusVariant } from "./status";

describe("statusVariant", () => {
  it("完成=ok / 失败=bad / 三种进行中=run / 中间态=warn / 其他=neutral", () => {
    expect(statusVariant("completed")).toBe("ok");
    expect(statusVariant("failed")).toBe("bad");
    for (const s of ["ai_generating", "tts_processing", "video_rendering", "rendering"]) {
      expect(statusVariant(s)).toBe("run");
    }
    for (const s of ["content_ready", "audio_ready", "draft"]) {
      expect(statusVariant(s)).toBe("warn");
    }
    expect(statusVariant("unknown_state")).toBe("neutral");
  });
});

describe("标签映射", () => {
  it("八状态与三模板全量中文化（不允许裸枚举漏到界面）", () => {
    expect(Object.keys(STATUS_LABEL)).toHaveLength(8);
    expect(STATUS_LABEL.audio_ready).toBe("配音完成");
    expect(TEMPLATE_LABEL.scene_word).toBe("情景背词");
    expect(TEMPLATE_LABEL.quiz).toBe("选择题");
  });
});

describe("relativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T12:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("分钟/小时/昨天/日期四档", () => {
    expect(relativeTime("2026-09-23T11:59:30Z")).toBe("刚刚");
    expect(relativeTime("2026-09-23T11:57:00Z")).toBe("3 分钟前");
    expect(relativeTime("2026-09-23T09:00:00Z")).toBe("3 小时前");
    expect(relativeTime("2026-09-22T11:30:00Z")).toBe("昨天");
    expect(relativeTime("2026-09-15T12:00:00Z")).toBe(
      new Date("2026-09-15T12:00:00Z").toLocaleDateString("zh-CN"),
    );
  });

  it("非法时间原样返回（不崩）", () => {
    expect(relativeTime("not-a-date")).toBe("not-a-date");
  });
});
