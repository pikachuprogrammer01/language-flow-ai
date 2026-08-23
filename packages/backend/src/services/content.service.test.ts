/**
 * content.service 测试（V4.1 生成策略）
 * 覆盖：混合词表（主题词 + 随机补足）、代码全池注入、模型自写英文词补标签、
 * 主题回显验收、反馈重试、失败兜底
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

/** 选词阶段输出：从池中挑选的词（覆盖 STORY_JSON 的全部义项） */
const PICK_JSON = JSON.stringify({
  words: [
    "establishment",
    "equip",
    "contract",
    "expand",
    "improve",
    "market",
    "provide",
    "opportunity",
  ],
});

/** 纯中文故事（无任何标注元任务）：含 8 个候选词中文义项原词 */
const STORY_JSON = JSON.stringify({
  topic: "科技创业",
  title: "职场英语：读一个科技创业故事",
  segments: [
    {
      text: "奥斯丁在一家科技机构工作，负责装备实验室，签下一份合同，计划扩张业务，改善运营，打开市场，提供就业机会。",
    },
  ],
});

/** 词库命中；meaning 须包含故事里的短词义 */
function dictHit(words: string[]) {
  const dict: Record<string, string> = {
    establishment: "机构；组织；建立",
    equip: "装备；配备",
    contract: "合同；契约",
    expand: "扩张；扩展",
    improve: "改善；改进",
    market: "市场；销路",
    provide: "提供；供给",
    opportunity: "机会；时机",
    explore: "探索；探险",
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
  // 随机池与主题词（TOPIC_WORDS_JSON 校验后 4 词）合并需覆盖 STORY_JSON 的全部 8 个义项
  randomWordsMock.mockResolvedValue({
    words: [
      { word: "improve", meaning: "改善；改进", level: "CET4" },
      { word: "market", meaning: "市场；销路", level: "CET4" },
      { word: "provide", meaning: "提供；供给", level: "CET4" },
      { word: "opportunity", meaning: "机会；时机", level: "CET4" },
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
  it("混合词表 + 全池注入：中文义项替换为英文词并生成 ContentDTO", async () => {
    chatCompletionMock
      .mockResolvedValueOnce(TOPIC_WORDS_JSON)
      .mockResolvedValueOnce(PICK_JSON)
      .mockResolvedValueOnce(STORY_JSON);

    const dto = await generateSceneWordContent({ topic: "科技创业", level: "CET4" });

    expect(dto.template).toBe("scene_word");
    expect(dto.status).toBe("content_ready");
    expect(dto.id).toMatch(/^cnt_\d{8}_[0-9a-f]{6}$/);
    expect(isSceneWord(dto)).toBe(true);
    if (!isSceneWord(dto)) throw new Error("unexpected template");
    // 中文义项被替换为英文词，且逐字在文本
    expect(dto.content[0]?.text).toContain("establishment");
    expect(dto.content[0]?.text).toContain("opportunity");
    expect(dto.content[0]?.text).not.toContain("机构");
    expect(dto.words.map((w) => w.word).sort()).toEqual([
      "contract",
      "equip",
      "establishment",
      "expand",
      "improve",
      "market",
      "opportunity",
      "provide",
    ]);
    // 审计来源只含 topic / random（narrative 已废除）
    expect(
      dto.audit.process.candidates.every((c) => c.source === "topic" || c.source === "random"),
    ).toBe(true);
    // 一次成功生成 = 1 次主题词调用 + 1 次选词调用 + 1 次故事调用
    expect(chatCompletionMock).toHaveBeenCalledTimes(3);
  });

  it("wordCount 显式指定时 clamp 到 [8,20] 并写入 prompt", async () => {
    chatCompletionMock
      .mockResolvedValueOnce(TOPIC_WORDS_JSON)
      .mockResolvedValueOnce(PICK_JSON)
      .mockResolvedValueOnce(STORY_JSON)
      .mockResolvedValueOnce(TOPIC_WORDS_JSON)
      .mockResolvedValueOnce(PICK_JSON)
      .mockResolvedValueOnce(STORY_JSON);

    await generateSceneWordContent({ topic: "科技创业", level: "CET4", wordCount: 30 });
    await generateSceneWordContent({ topic: "科技创业", level: "CET4", wordCount: 3 });

    // clamp 后的 targetCount 决定选词阶段要挑几个词（+3 备用余量，上限 MAX）
    expect(chatCompletionMock.mock.calls[1][0][0].content).toContain("挑选 20 个");
    expect(chatCompletionMock.mock.calls[4][0][0].content).toContain("挑选 11 个");
  });

  it("主题回显偏离时反馈重试（第 2 次修正后通过）", async () => {
    const offTopic = withTopic(STORY_JSON, "森林露营");
    chatCompletionMock
      .mockResolvedValueOnce(TOPIC_WORDS_JSON)
      .mockResolvedValueOnce(PICK_JSON)
      .mockResolvedValueOnce(offTopic)
      .mockResolvedValueOnce(STORY_JSON);

    const dto = await generateSceneWordContent({ topic: "科技创业", level: "CET4" });
    expect(dto.title).toBe("职场英语：读一个科技创业故事");
    const retryPrompt = chatCompletionMock.mock.calls[3][0][0].content;
    expect(retryPrompt).toContain("主题偏离");
    expect(retryPrompt).toContain("科技创业");
  });

  it("注入后唯一词不足 8 时反馈重试", async () => {
    const poorStory = JSON.stringify({
      topic: "科技创业",
      title: "t",
      segments: [{ text: "奥斯丁在一家科技机构工作。" }],
    });
    chatCompletionMock
      .mockResolvedValueOnce(TOPIC_WORDS_JSON)
      .mockResolvedValueOnce(PICK_JSON)
      .mockResolvedValueOnce(poorStory)
      .mockResolvedValueOnce(STORY_JSON);

    const dto = await generateSceneWordContent({ topic: "科技创业", level: "CET4" });
    expect(dto.words.length).toBeGreaterThanOrEqual(8);
    const retryPrompt = chatCompletionMock.mock.calls[3][0][0].content;
    expect(retryPrompt).toContain("至少 8");
  });

  it("同词多段重复只算一个（唯一次数不足 8 则重试）", async () => {
    const dupStory = JSON.stringify({
      topic: "科技创业",
      title: "t",
      segments: [
        { text: "奥斯丁在科技机构签下合同，计划扩张业务。" },
        { text: "他继续在这家机构努力。" },
      ],
    });
    chatCompletionMock
      .mockResolvedValueOnce(TOPIC_WORDS_JSON)
      .mockResolvedValueOnce(PICK_JSON)
      .mockResolvedValueOnce(dupStory)
      .mockResolvedValueOnce(STORY_JSON);

    const dto = await generateSceneWordContent({ topic: "科技创业", level: "CET4" });
    expect(dto.words.length).toBeGreaterThanOrEqual(8);
    const retryPrompt = chatCompletionMock.mock.calls[3][0][0].content;
    expect(retryPrompt).toContain("至少 8");
  });

  it("文本中未出现的候选词不注入", async () => {
    // 故事无"装备"义项 → equip 不注入（其余 8 词命中，恰好过下限）
    const story = JSON.stringify({
      topic: "科技创业",
      title: "t",
      segments: [
        {
          text: "奥斯丁在一家科技机构工作，签下一份合同，计划扩张业务，改善运营，打开市场，提供就业机会。",
        },
        { text: "他相信团队会建立更好的未来。" },
      ],
    });
    // 第二段命中"建立"→ establishment 已在第一段注入过，同词只算一个；
    // 全篇唯一 = establishment/contract/expand/improve/market/provide/opportunity = 7 < 8 → 重试后用 STORY_JSON
    chatCompletionMock
      .mockResolvedValueOnce(TOPIC_WORDS_JSON)
      .mockResolvedValueOnce(PICK_JSON)
      .mockResolvedValueOnce(story)
      .mockResolvedValueOnce(STORY_JSON);

    const dto = await generateSceneWordContent({ topic: "科技创业", level: "CET4" });
    expect(dto.words.length).toBeGreaterThanOrEqual(8);
  });

  it("模型自写英文词经词库校验补进标签，编造词被剔除", async () => {
    // explore 是词库词 → 补标签；blah 不在词库 → 剔除
    const story = JSON.stringify({
      topic: "科技创业",
      title: "t",
      segments: [
        {
          text: "奥斯丁在一家科技机构工作，负责装备实验室，签下一份合同，计划扩张业务，改善运营，打开市场，提供就业机会，顺便 explore 了一下 blah。",
        },
      ],
    });
    chatCompletionMock
      .mockResolvedValueOnce(TOPIC_WORDS_JSON)
      .mockResolvedValueOnce(PICK_JSON)
      .mockResolvedValueOnce(story);

    const dto = await generateSceneWordContent({ topic: "科技创业", level: "CET4" });
    const names = dto.words.map((w) => w.word);
    expect(names).toContain("explore");
    expect(names).not.toContain("blah");
  });

  it("修复 qwen 分段数组粘连（segments 拆成多个数组）后正常解析", async () => {
    const glued =
      '{"topic":"科技创业","title":"t","segments":[{"text":"奥斯丁在一家科技机构工作，负责装备实验室。"}],[{"text":"他签下一份合同，计划扩张业务，改善运营，打开市场，提供就业机会。"}]}';
    chatCompletionMock
      .mockResolvedValueOnce(TOPIC_WORDS_JSON)
      .mockResolvedValueOnce(PICK_JSON)
      .mockResolvedValueOnce(glued);

    const dto = await generateSceneWordContent({ topic: "科技创业", level: "CET4" });
    expect(dto.content.length).toBe(2);
    expect(dto.words.map((w) => w.word)).toContain("contract");
  });

  it("英文/混合主题验收通过（英文回显或中文改写均可）", async () => {
    const mixed = withTopic(STORY_JSON, "人工智能创业");
    const en = withTopic(STORY_JSON, "AI startup");
    chatCompletionMock
      .mockResolvedValueOnce(TOPIC_WORDS_JSON)
      .mockResolvedValueOnce(PICK_JSON)
      .mockResolvedValueOnce(mixed)
      .mockResolvedValueOnce(TOPIC_WORDS_JSON)
      .mockResolvedValueOnce(PICK_JSON)
      .mockResolvedValueOnce(en);

    const dto1 = await generateSceneWordContent({ topic: "AI 创业", level: "CET4" });
    expect(dto1.title).toBe("职场英语：读一个科技创业故事");
    const dto2 = await generateSceneWordContent({ topic: "AI startup", level: "CET4" });
    expect(dto2.words.length).toBeGreaterThan(0);
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
