/**
 * content.service 测试
 * 覆盖：两阶段生成（主题词 + 故事）、代码注入（中文词义 → 英文词）、主题回显验收、反馈重试、失败兜底
 */
import { isSceneWord } from "@ai-english/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({ db: {} }));

vi.mock("./llm.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./llm.service")>();
  return { ...actual, chatCompletion: vi.fn() };
});

vi.mock("./cet.service", () => ({
  randomWords: vi.fn(),
  validateWords: vi.fn(),
}));

import { randomWords, validateWords } from "./cet.service";
import { generateSceneWordContent } from "./content.service";
import { chatCompletion, extractJson } from "./llm.service";

const chatCompletionMock = vi.mocked(chatCompletion);
const validateWordsMock = vi.mocked(validateWords);
const randomWordsMock = vi.mocked(randomWords);

const TOPIC_WORDS_JSON = JSON.stringify({
  words: ["establishment", "equip", "contract", "expand"],
});

/** 纯中文故事（含候选词中文义项：机构/装备/合同） */
const STORY_JSON = JSON.stringify({
  topic: "科技创业",
  title: "职场英语：读一个科技创业故事",
  segments: [
    {
      text: "奥斯丁在一家科技机构工作，负责装备实验室，并签下一份合同。",
    },
  ],
});

/** 词库命中（establishment/equip/contract/expand）；词义含模型/故事里的短词义 */
function dictHit(words: string[]) {
  const dict: Record<string, string> = {
    establishment: "机构；组织；建立",
    equip: "装备；配备",
    contract: "合同；契约",
    expand: "扩张；扩展",
  };
  const matched = words.filter((w) => dict[w.toLowerCase()] !== undefined);
  const unmatched = words.filter((w) => !matched.includes(w));
  return {
    matchedWords: matched.map((w) => ({
      word: w,
      meaning: dict[w.toLowerCase()],
      level: "CET4" as const,
    })),
    unmatchedWords: unmatched,
  };
}

function withTopic(json: string, topic: string): string {
  const obj = JSON.parse(json) as { topic: string };
  obj.topic = topic;
  return JSON.stringify(obj);
}

beforeEach(() => {
  chatCompletionMock.mockReset();
  validateWordsMock.mockReset();
  validateWordsMock.mockImplementation(async (words: string[]) => dictHit(words));
  randomWordsMock.mockReset();
  randomWordsMock.mockResolvedValue({
    words: [
      { word: "contract", meaning: "合同；契约", level: "CET4" },
      { word: "expand", meaning: "扩张；扩展", level: "CET4" },
    ],
  });
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

  it("JSON 后带尾部杂质（多余 } 或文字）时回溯解析", () => {
    const out = extractJson<{ a: number }>('{"a": 1} 这是说明文字 } 更多');
    expect(out.a).toBe(1);
  });

  it("JSON 后带未闭合围栏时解析成功", () => {
    const out = extractJson<{ a: number }>('```json\n{"a": 3}');
    expect(out.a).toBe(3);
  });
});

describe("generateSceneWordContent", () => {
  it("两阶段生成：中文故事 → 代码注入英文词 → ContentDTO", async () => {
    chatCompletionMock.mockResolvedValueOnce(TOPIC_WORDS_JSON).mockResolvedValueOnce(STORY_JSON);

    const dto = await generateSceneWordContent({ topic: "科技创业", level: "CET4", wordCount: 5 });

    expect(dto.template).toBe("scene_word");
    expect(dto.status).toBe("content_ready");
    expect(dto.title).toBe("职场英语：读一个科技创业故事");
    expect(dto.id).toMatch(/^cnt_\d{8}_[0-9a-f]{6}$/);
    expect(isSceneWord(dto)).toBe(true);
    if (!isSceneWord(dto)) throw new Error("unexpected template");
    // 中文词义被替换为英文词，且逐字在文本
    expect(dto.content[0].text).toContain("establishment");
    expect(dto.content[0].text).toContain("equip");
    expect(dto.content[0].text).toContain("contract");
    expect(dto.content[0].text).not.toContain("机构");
    expect(dto.content[0].words.map((w) => w.word).sort()).toEqual([
      "contract",
      "equip",
      "establishment",
    ]);
    expect(chatCompletionMock).toHaveBeenCalledTimes(2);
  });

  it("主题回显偏离时反馈重试（第 2 次修正后通过）", async () => {
    const offTopic = withTopic(STORY_JSON, "森林露营");
    chatCompletionMock
      .mockResolvedValueOnce(TOPIC_WORDS_JSON)
      .mockResolvedValueOnce(offTopic) // 第一次主题偏离
      .mockResolvedValueOnce(TOPIC_WORDS_JSON)
      .mockResolvedValueOnce(STORY_JSON); // 第二次修正

    const dto = await generateSceneWordContent({ topic: "科技创业", level: "CET4" });
    expect(dto.title).toBe("职场英语：读一个科技创业故事");
    // 重试时 prompt 应包含失败反馈
    const retryPrompt = chatCompletionMock.mock.calls[3][0][0].content;
    expect(retryPrompt).toContain("主题偏离");
    expect(retryPrompt).toContain("科技创业");
  });

  it("词数不足时反馈重试", async () => {
    // 故事只含"机构"（注入后 1 词 < min 2）
    const poorStory = JSON.stringify({
      topic: "科技创业",
      title: "t",
      segments: [{ text: "奥斯丁在一家科技机构工作。" }],
    });
    chatCompletionMock
      .mockResolvedValueOnce(TOPIC_WORDS_JSON)
      .mockResolvedValueOnce(poorStory)
      .mockResolvedValueOnce(TOPIC_WORDS_JSON)
      .mockResolvedValueOnce(STORY_JSON);

    const dto = await generateSceneWordContent({ topic: "科技创业", level: "CET4" });
    expect(dto.content.length).toBeGreaterThan(0);
  });

  it("文本中未出现的候选词不注入", async () => {
    // 故事含"机构/合同/扩张"，无"装备" → equip 不注入
    const story = JSON.stringify({
      topic: "科技创业",
      title: "t",
      segments: [{ text: "奥斯丁在科技机构签下合同，计划扩张业务。" }],
    });
    chatCompletionMock.mockResolvedValueOnce(TOPIC_WORDS_JSON).mockResolvedValueOnce(story);

    const dto = await generateSceneWordContent({ topic: "科技创业", level: "CET4", wordCount: 3 });
    expect(isSceneWord(dto)).toBe(true);
    if (!isSceneWord(dto)) throw new Error("unexpected template");
    const words = dto.content[0].words.map((w) => w.word).sort();
    expect(words).toEqual(["contract", "establishment", "expand"]);
    expect(words).not.toContain("equip");
  });

  it("3 次均未通过验收时抛出可读原因", async () => {
    const offTopic = withTopic(STORY_JSON, "森林露营");
    chatCompletionMock.mockResolvedValue(TOPIC_WORDS_JSON).mockResolvedValue(offTopic);

    await expect(generateSceneWordContent({ topic: "科技创业", level: "CET4" })).rejects.toThrow(
      "内容生成未通过验收",
    );
  });

  it("LLM 输出非法 JSON 时反馈重试并最终失败", async () => {
    chatCompletionMock
      .mockResolvedValue(TOPIC_WORDS_JSON)
      .mockResolvedValue("不是 JSON 的输出内容");

    await expect(generateSceneWordContent({ topic: "x", level: "CET4" })).rejects.toThrow(
      "未通过验收",
    );
  });
});
