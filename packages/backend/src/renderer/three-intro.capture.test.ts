import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/llm.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/llm.service")>();
  return {
    ...actual,
    chatCompletion: vi.fn(),
  };
});

const { seekMock } = vi.hoisted(() => ({ seekMock: vi.fn() }));
vi.mock("./playwright", () => ({ screenshotSeekAnimation: seekMock }));

import { chatCompletion } from "../services/llm.service";
import {
  buildThemeFromMotif,
  captureThreeIntro,
  clearIntroThemeCache,
  fallbackIntroTheme,
  isIntroMotif,
  resolveIntroTheme,
} from "./three-intro.capture";

const chatMock = vi.mocked(chatCompletion);

describe("intro theme LLM 归类", () => {
  afterEach(() => {
    clearIntroThemeCache();
    chatMock.mockReset();
  });

  it("isIntroMotif 校验枚举", () => {
    expect(isIntroMotif("night")).toBe(true);
    expect(isIntroMotif("nope")).toBe(false);
  });

  it("LLM 返回 motif 时跟着主题走", async () => {
    chatMock.mockResolvedValueOnce('{"motif":"night","label":"加班夜归"}');
    const t = await resolveIntroTheme("随便编的周五加班回家");
    expect(t.motif).toBe("night");
    expect(t.label).toBe("加班夜归");
    expect(chatMock).toHaveBeenCalledOnce();
  });

  it("同一主题二次命中缓存，不重复调 LLM", async () => {
    chatMock.mockResolvedValueOnce('{"motif":"interview","label":"求职面试"}');
    await resolveIntroTheme("AI推荐的面试主题XYZ");
    await resolveIntroTheme("AI推荐的面试主题XYZ");
    expect(chatMock).toHaveBeenCalledOnce();
  });

  it("LLM 非法 motif 回落 default 配色槽", async () => {
    chatMock.mockResolvedValueOnce('{"motif":"spaceship","label":"怪主题"}');
    const t = await resolveIntroTheme("完全虚构主题");
    expect(t.motif).toBe("default");
  });

  it("LLM 失败时关键词兜底", async () => {
    chatMock.mockRejectedValueOnce(new Error("timeout"));
    const t = await resolveIntroTheme("周五加班夜归路上");
    expect(t.motif).toBe("night");
  });

  it("fallbackIntroTheme 区分面试与夜归", () => {
    expect(fallbackIntroTheme("面试求职").motif).toBe("interview");
    expect(fallbackIntroTheme("加班夜归").motif).toBe("night");
  });

  it("buildThemeFromMotif 带上母题调色板", () => {
    expect(buildThemeFromMotif("coffee", "美食").primary).toBe("#fbbf24");
  });
});

describe("captureThreeIntro", () => {
  afterEach(() => {
    clearIntroThemeCache();
    chatMock.mockReset();
    seekMock.mockReset();
  });

  it("截帧成功：按帧数均分时长产出 RenderFrame[]", async () => {
    chatMock.mockResolvedValue('{"motif":"forest","label":"森林"}');
    seekMock.mockResolvedValue(["a.png", "b.png", "c.png", "d.png"]);
    const frames = await captureThreeIntro({
      topic: "森林探险",
      title: "森林探险",
      highlightWord: "forest",
      workDir: "/tmp/x",
    });
    expect(frames).toHaveLength(4);
    expect(frames?.[0]?.duration).toBeCloseTo(1 / 4, 5); // INTRO_DURATION_SEC 1 / 4 帧
  });

  it("截帧抛错：返回 null（上层据此标 introStatus=failed）", async () => {
    chatMock.mockResolvedValue('{"motif":"default","label":"通用"}');
    seekMock.mockRejectedValue(new Error("webgl lost"));
    const frames = await captureThreeIntro({
      topic: "t",
      title: "t",
      workDir: "/tmp/x",
    });
    expect(frames).toBeNull();
  });
});
