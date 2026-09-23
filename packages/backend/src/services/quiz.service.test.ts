/**
 * quiz.service 单测 — 答案代码构造策略的验收/重试/兜底链路
 * mock 边界：cet.service 抽词 + llm.service.chatCompletion（extractJson 用真实实现，保证解析链路同样被验）
 */
import { isQuiz } from "@ai-english/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as cetService from "./cet.service";
import * as llmService from "./llm.service";
import { generateQuizContent } from "./quiz.service";

vi.mock("../db", () => ({ db: {} }));
vi.mock("./cet.service", () => ({ randomWords: vi.fn(), validateWords: vi.fn() }));
vi.mock("./llm.service", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  chatCompletion: vi.fn(),
}));

const randomWordsMock = vi.mocked(cetService.randomWords);
const chatMock = vi.mocked(llmService.chatCompletion);

/** 8 个词满足 MIN_WORDS_PER_CONTENT(5) 验收下限 */
const PICKED = Array.from({ length: 8 }, (_, i) => ({
  word: `word${i}`,
  meaning: `释义${i}`,
  level: "CET4",
}));

const validLlmJson = JSON.stringify({
  title: "校园英语：词汇选择题",
  questions: PICKED.map((w) => ({ word: w.word, explanation: `${w.word} 意为“${w.meaning}”。` })),
});

beforeEach(() => {
  randomWordsMock.mockReset();
  chatMock.mockReset();
  randomWordsMock.mockResolvedValue({ words: PICKED, missing: [] } as never);
});

describe("generateQuizContent 正常路径", () => {
  it("答案由代码构造：正确项恒为词库释义原文，选项 4 个且题干含目标词", async () => {
    chatMock.mockResolvedValue(validLlmJson);
    const dto = await generateQuizContent({ topic: "校园", level: "CET4" });
    expect(dto.template).toBe("quiz");
    if (!isQuiz(dto)) throw new Error("expected quiz content");
    expect(dto.status).toBe("content_ready");
    expect(dto.content).toHaveLength(8);
    for (const item of dto.content) {
      expect(item.options).toHaveLength(4);
      expect(item.options[item.correctIndex]).toBe(
        dto.words.find((w) => w.word === item.word.word)?.meaning,
      );
      expect(item.stem).toContain(item.word.word);
    }
    expect(dto.audit.process.attempts.at(-1)?.result).toBe("accepted");
  });

  it("干扰项不足 3 个时以占位补齐到 4 选项", async () => {
    randomWordsMock.mockResolvedValue({
      words: PICKED.slice(0, 5).map((w, i) => (i === 0 ? w : { ...w, meaning: "同一个释义" })),
      missing: [],
    } as never);
    chatMock.mockResolvedValue(
      JSON.stringify({
        title: "t",
        questions: PICKED.slice(0, 5).map((w) => ({ word: w.word, explanation: "释义说明文字" })),
      }),
    );
    const dto = await generateQuizContent({ topic: "校园", level: "CET4" });
    if (!isQuiz(dto)) throw new Error("expected quiz content");
    const first = dto.content[0];
    if (!first) throw new Error("expected content");
    expect(first.options).toHaveLength(4);
    expect(first.options[first.correctIndex]).toBe("释义0");
  });
});

describe("generateQuizContent 异常与重试", () => {
  it("词库不足验收下限时不发 LLM 请求直接抛错", async () => {
    randomWordsMock.mockResolvedValue({ words: PICKED.slice(0, 3), missing: [] } as never);
    await expect(generateQuizContent({ topic: "t", level: "CET4" })).rejects.toThrow("词库");
    expect(chatMock).not.toHaveBeenCalled();
  });

  it("LLM 输出非法 JSON：3 次重试后抛可读原因", async () => {
    chatMock.mockResolvedValue("对不起，我无法输出 JSON");
    await expect(generateQuizContent({ topic: "t", level: "CET4" })).rejects.toThrow(
      "选择题生成未通过验收",
    );
    expect(chatMock).toHaveBeenCalledTimes(3);
  });

  it("题目含词表外单词：首轮拒绝携带反馈重试，次轮通过", async () => {
    chatMock
      .mockResolvedValueOnce(
        JSON.stringify({
          title: "t",
          questions: [{ word: "fabricated", explanation: "编造的词不在词表" }],
        }),
      )
      .mockResolvedValueOnce(validLlmJson);
    const dto = await generateQuizContent({ topic: "t", level: "CET4" });
    expect(dto.content).toHaveLength(8);
    const attempts = dto.audit.process.attempts;
    expect(attempts[0]?.result).toBe("rejected");
    expect(attempts[1]?.result).toBe("accepted");
    // 第二轮 prompt 必须携带上轮失败反馈（重试带因）
    const secondPrompt = chatMock.mock.calls[1]?.[0]?.[0]?.content ?? "";
    expect(secondPrompt).toContain("上次生成的错误");
  });

  it("LLM 调用抛错：计入 attempts 并最终抛出", async () => {
    chatMock.mockRejectedValue(new Error("LLM 服务不可用"));
    await expect(generateQuizContent({ topic: "t", level: "CET4" })).rejects.toThrow(
      "选择题生成未通过验收",
    );
  });
});
