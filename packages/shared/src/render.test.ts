/**
 * fitSceneWordFontSize 单测 — 渲染器与前端预览共用的字号档位（边界值锁定，防档位漂移）
 */
import { describe, expect, it } from "vitest";
import { fitSceneWordFontSize } from "./render";

describe("fitSceneWordFontSize", () => {
  it("四档字号按文本总量分档（<90 / <160 / <240 / ≥240）", () => {
    expect(fitSceneWordFontSize(0)).toBe(42);
    expect(fitSceneWordFontSize(89)).toBe(42);
    expect(fitSceneWordFontSize(90)).toBe(36);
    expect(fitSceneWordFontSize(159)).toBe(36);
    expect(fitSceneWordFontSize(160)).toBe(32);
    expect(fitSceneWordFontSize(239)).toBe(32);
    expect(fitSceneWordFontSize(240)).toBe(28);
    expect(fitSceneWordFontSize(2000)).toBe(28);
  });
});
