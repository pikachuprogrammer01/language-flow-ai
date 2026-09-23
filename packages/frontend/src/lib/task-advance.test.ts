/**
 * 「继续生产」决策纯函数单测 — 推进动作与可见性口径（副作用编排不在本测范围）
 */
import { describe, expect, it } from "vitest";
import { canAdvance, hasAudioInfo, planAdvance } from "./task-advance";

describe("hasAudioInfo", () => {
  it("url + duration 齐备才算有音频产物", () => {
    expect(hasAudioInfo({ url: "/files/audio/a.mp3", duration: 12.3, format: "mp3" })).toBe(true);
    expect(hasAudioInfo({ url: "/files/audio/a.mp3" })).toBe(false); // 缺 duration
    expect(hasAudioInfo(null)).toBe(false);
    expect(hasAudioInfo("x")).toBe(false);
  });
});

describe("planAdvance", () => {
  it("配音完成 → 只差渲染；无音频 → 先配音再渲染", () => {
    expect(planAdvance({ audio: { url: "u", duration: 1, format: "mp3" } })).toBe("render");
    expect(planAdvance({ audio: null })).toBe("tts-then-render");
    expect(planAdvance({})).toBe("tts-then-render");
  });
});

describe("canAdvance", () => {
  it("仅内容就绪/配音完成/失败可推进；进行中与已完成不出入口", () => {
    expect(canAdvance("content_ready")).toBe(true);
    expect(canAdvance("audio_ready")).toBe(true);
    expect(canAdvance("failed")).toBe(true);
    expect(canAdvance("completed")).toBe(false);
    expect(canAdvance("ai_generating")).toBe(false);
    expect(canAdvance("tts_processing")).toBe(false);
  });
});
