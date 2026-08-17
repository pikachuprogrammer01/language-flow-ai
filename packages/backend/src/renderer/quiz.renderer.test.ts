import type { ContentDTO, QuizItem } from "@ai-english/shared";
/**
 * QuizRenderer 帧时长测试
 * 覆盖（用户确认 2026-08-18）：
 *   - 题目帧 = 该题朗读比例 × 配音时长 + 1s 缓冲（读完选项不马上切）
 *   - 答案帧 = 2.5s 解析 + 0.8s 题间间隔
 *   - beepTimes = 每题答案帧起点（提示音）
 */
import { describe, expect, it, vi } from "vitest";
import { QuizRenderer } from "./quiz.renderer";

vi.mock("./playwright", () => ({
  screenshotHtmls: vi.fn(async (htmls: unknown[]) => htmls.map((_, i) => `/tmp/frame-${i}.png`)),
}));

const QUIZ_DTO: ContentDTO & { content: QuizItem[] } = {
  id: "cnt_20260818_000001",
  template: "quiz",
  title: "校园英语：词汇选择题",
  level: "CET4",
  targetDuration: 20,
  content: [
    {
      stem: "resolve 的意思是？",
      options: ["决定", "市场", "合同", "学校"],
      correctIndex: 0,
      explanation: "resolve 意为决定。",
      word: { word: "resolve", meaning: "决定", level: "CET4" },
    },
    {
      stem: "market 的意思是？",
      options: ["市场", "决定", "合同", "学校"],
      correctIndex: 0,
      explanation: "market 意为市场。",
      word: { word: "market", meaning: "市场", level: "CET4" },
    },
  ],
  words: [],
  style: { background: "white" },
  voice: { id: "female_01" },
  audio: { url: "/files/audio/quiz.mp3", duration: 10, format: "mp3" },
  status: "content_ready",
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z",
};

describe("QuizRenderer", () => {
  it("题目帧=朗读比例+1s；答案帧=2.5s解析+0.8s题间间隔；beepTimes=答案帧起点", async () => {
    const renderer = new QuizRenderer();
    const result = await renderer.render(QUIZ_DTO, "/tmp/work");

    expect(result.frames).toHaveLength(4); // 2 题 × 2 帧
    // 答案帧 = 2.5 + 0.8 = 3.3s
    expect(result.frames[1].duration).toBeCloseTo(3.3, 1);
    expect(result.frames[3].duration).toBeCloseTo(3.3, 1);
    // 总时长 = 配音 + 2 题 × (1s 缓冲 + 3.3s 答案帧)
    expect(result.totalDuration).toBeCloseTo(10 + 2 * (1.0 + 3.3), 1);
    // beepTimes = 每题答案帧起点
    expect(result.beepTimes).toEqual([
      result.frames[0].duration,
      result.frames[0].duration + 3.3 + result.frames[2].duration,
    ]);
    // 题目帧 ≥ 朗读比例 + 1s（读完不马上切）
    expect(result.frames[0].duration).toBeGreaterThan(1.0);
  });
});
