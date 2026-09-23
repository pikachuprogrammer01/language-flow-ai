/** analytics-copy 纯函数单测 */
import { describe, expect, it } from "vitest";
import { buildCopyLines } from "./analytics-copy";

describe("buildCopyLines", () => {
  it("scene_word：取各段 text，过滤空段", () => {
    const lines = buildCopyLines("scene_word", [
      { text: "First paragraph.", words: [] },
      { text: "" },
      { text: "Second one." },
    ]);
    expect(lines).toEqual(["First paragraph.", "Second one."]);
  });

  it("word_card：词性/释义/例句拼接", () => {
    const lines = buildCopyLines("word_card", [
      { word: "deadline", pos: "n.", meaning: "截止日期", example: "The deadline is Friday." },
      { word: "launch", meaning: "发射" },
    ]);
    expect(lines[0]).toBe("deadline（n.） 截止日期 — The deadline is Friday.");
    expect(lines[1]).toBe("launch 发射");
  });

  it("quiz：题干 + 答案 + 解析", () => {
    const lines = buildCopyLines("quiz", [
      { stem: "选错词", options: ["a", "b", "c", "d"], correctIndex: 1, explanation: "因为" },
    ]);
    expect(lines[0]).toBe("选错词 ｜ 答案：B. b ｜ 因为");
  });

  it("非法结构回退空数组；correctIndex 越界不出答案段", () => {
    expect(buildCopyLines("scene_word", null)).toEqual([]);
    expect(buildCopyLines("scene_word", ["not-object"])).toEqual([]);
    const line = buildCopyLines("quiz", [{ stem: "s", options: [], correctIndex: 5 }])[0];
    expect(line).toBe("s");
  });
});
