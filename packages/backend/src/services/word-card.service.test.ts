/**
 * word-card.service 单测 — 词库定释义 + LLM 造卡的验收/重试/兜底链路
 * mock 边界：cet.service 抽词 + llm.service.chatCompletion（extractJson 走真实实现）
 */
import { isWordCard } from "@ai-english/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as cetService from "./cet.service";
import * as llmService from "./llm.service";
import { generateWordCardContent } from "./word-card.service";

vi.mock("../db", () => ({ db: {} }));
vi.mock("./cet.service", () => ({ randomWords: vi.fn(), validateWords: vi.fn() }));
vi.mock("./llm.service", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  chatCompletion: vi.fn(),
}));

const randomWordsMock = vi.mocked(cetService.randomWords);
const chatMock = vi.mocked(llmService.chatCompletion);

const PICKED = Array.from({ length: 6 }, (_, i) => ({
  word: `w${i}`,
  meaning: `n.含义${i}`,
  level: "CET4",
}));

const validLlmJson = JSON.stringify({
  title: "生活英语：常用词卡片",
  cards: PICKED.map((w) => ({
    word: w.word,
    pos: "n.",
    example: `This is sentence number one about ${w.word} for testing.`,
    exampleMeaning: `这是关于 ${w.word} 的例句`,
  })),
});

beforeEach(() => {
  randomWordsMock.mockReset();
  chatMock.mockReset();
  randomWordsMock.mockResolvedValue({ words: PICKED, missing: [] } as never);
});

describe("generateWordCardContent 正常路径", () => {
  it("释义以词库为准（LLM 不参与释义），六卡全量落 ContentDTO", async () => {
    chatMock.mockResolvedValue(validLlmJson);
    const dto = await generateWordCardContent({ topic: "生活", level: "CET4" });
    expect(dto.template).toBe("word_card");
    if (!isWordCard(dto)) throw new Error("expected word_card content");
    expect(dto.content).toHaveLength(6);
    for (const card of dto.content) {
      expect(PICKED.some((w) => w.word === card.word)).toBe(true);
      expect(card.example).toContain(card.word);
    }
    // 词库原文释义覆盖 LLM 输出
    expect(dto.content[0]?.meaning).toBe("n.含义0");
  });
});

describe("generateWordCardContent 异常与重试", () => {
  it("词库不足：直接抛错不调 LLM", async () => {
    randomWordsMock.mockResolvedValue({ words: PICKED.slice(0, 2), missing: [] } as never);
    await expect(generateWordCardContent({ topic: "t", level: "CET4" })).rejects.toThrow(
      "无法生成卡片",
    );
    expect(chatMock).not.toHaveBeenCalled();
  });

  it("词表外卡片丢弃触发重试，二轮通过后审计留两笔", async () => {
    chatMock
      .mockResolvedValueOnce(
        JSON.stringify({
          title: "t",
          cards: [
            {
              word: "ghost",
              pos: "n.",
              example: "not in list at all here",
              exampleMeaning: "不在列表",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(validLlmJson);
    const dto = await generateWordCardContent({ topic: "t", level: "CET4" });
    expect(dto.content).toHaveLength(6);
    expect(dto.audit.process.attempts.map((a) => a.result)).toEqual(["rejected", "accepted"]);
  });

  it("输出非法 JSON 3 次：抛可读验收失败原因", async () => {
    chatMock.mockResolvedValue("这不是 JSON");
    await expect(generateWordCardContent({ topic: "t", level: "CET4" })).rejects.toThrow(
      "单词卡片生成未通过验收",
    );
    expect(chatMock).toHaveBeenCalledTimes(3);
  });
});
