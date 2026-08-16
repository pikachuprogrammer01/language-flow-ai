/**
 * content.service 测试
 * 覆盖：LLM 输出解析 → 词库过滤 → ContentDTO 组装；结构不符 / 词库无命中 / extractJson
 */
import { isSceneWord } from "@ai-english/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({ db: {} }));

vi.mock("./llm.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./llm.service")>();
  return { ...actual, chatCompletion: vi.fn() };
});

vi.mock("./cet.service", () => ({
  validateWords: vi.fn(),
}));

import { validateWords } from "./cet.service";
import { generateSceneWordContent } from "./content.service";
import { chatCompletion, extractJson } from "./llm.service";

const chatCompletionMock = vi.mocked(chatCompletion);
const validateWordsMock = vi.mocked(validateWords);

const LLM_OUTPUT = JSON.stringify({
  title: "职场英语：读一个科技创业故事",
  segments: [
    {
      text: "奥斯丁在一家科技establishment工作，负责equip实验室。",
      words: [
        { word: "establishment", meaning: "机构" },
        { word: "equip", meaning: "装备" },
      ],
    },
  ],
});

beforeEach(() => {
  chatCompletionMock.mockReset();
  validateWordsMock.mockReset();
});

describe("extractJson", () => {
  it("提取 ```json 围栏内的对象", () => {
    const out = extractJson<{ a: number }>('以下是结果：\n```json\n{"a": 1}\n```\n结束');
    expect(out.a).toBe(1);
  });

  it("提取裸 JSON（容忍前后杂质文本）", () => {
    const out = extractJson<{ a: number }>('前缀 {"a": 2} 后缀');
    expect(out.a).toBe(2);
  });

  it("无 JSON 对象时抛错", () => {
    expect(() => extractJson("没有任何 JSON")).toThrow();
  });
});

describe("generateSceneWordContent", () => {
  it("LLM 输出 → 词库过滤 → ContentDTO（status=content_ready, template=scene_word）", async () => {
    chatCompletionMock.mockResolvedValue(LLM_OUTPUT);
    // 两个词都命中词库
    validateWordsMock.mockResolvedValue({
      matchedWords: [
        { word: "establishment", meaning: "机构", level: "CET4" },
        { word: "equip", meaning: "装备", level: "CET4" },
      ],
      unmatchedWords: [],
    });

    const dto = await generateSceneWordContent({
      topic: "科技创业",
      level: "CET4",
      wordCount: 5,
      targetDuration: 30,
    });

    expect(dto.template).toBe("scene_word");
    expect(dto.status).toBe("content_ready");
    expect(dto.level).toBe("CET4");
    expect(dto.targetDuration).toBe(30);
    expect(dto.title).toBe("职场英语：读一个科技创业故事");
    expect(dto.id).toMatch(/^cnt_\d{8}_[0-9a-f]{6}$/);
    expect(isSceneWord(dto)).toBe(true);
    if (!isSceneWord(dto)) throw new Error("unexpected template");
    expect(dto.content[0].words[0]).toEqual({
      word: "establishment",
      meaning: "机构",
      level: "CET4",
    });
    expect(dto.words).toHaveLength(2);
    expect(chatCompletionMock).toHaveBeenCalledTimes(1);
  });

  it("词库未命中的词被丢弃，词义以词库为准", async () => {
    chatCompletionMock.mockResolvedValue(LLM_OUTPUT);
    // equip 不在词库（LLM 自造词），establishment 命中且词义以词库为准
    validateWordsMock.mockResolvedValue({
      matchedWords: [{ word: "establishment", meaning: "机构", level: "CET4" }],
      unmatchedWords: ["equip"],
    });

    const dto = await generateSceneWordContent({ topic: "x", level: "CET4" });
    expect(isSceneWord(dto)).toBe(true);
    if (!isSceneWord(dto)) throw new Error("unexpected template");
    expect(dto.content[0].words).toEqual([
      { word: "establishment", meaning: "机构", level: "CET4" },
    ]);
  });

  it("LLM 输出结构不符抛错", async () => {
    chatCompletionMock.mockResolvedValue('{"title":"x"}');
    await expect(generateSceneWordContent({ topic: "x", level: "CET4" })).rejects.toThrow(
      "LLM 输出结构不符合契约",
    );
  });

  it("词库校验后无可用词汇抛错", async () => {
    chatCompletionMock.mockResolvedValue(LLM_OUTPUT);
    validateWordsMock.mockResolvedValue({
      matchedWords: [],
      unmatchedWords: ["establishment", "equip"],
    });
    await expect(generateSceneWordContent({ topic: "x", level: "CET4" })).rejects.toThrow(
      "词库校验后无可用词汇",
    );
  });
});
