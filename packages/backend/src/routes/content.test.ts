/**
 * POST /api/content/generate 测试
 * 覆盖：200 生成成功 / 400 参数校验（topic 缺失、level 非法、wordCount 越界、非 JSON）/ 503 LLM 未配置 / 500 LLM 失败
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as contentService from "../services/content.service";
import { LlmNotConfiguredError } from "../services/llm.service";
import * as quizService from "../services/quiz.service";
import * as wordCardService from "../services/word-card.service";
import { content } from "./content";

// content.ts 现在会在生成成功后落库（db.insert），测试环境无 DATABASE_URL
vi.mock("../db", () => ({ db: { insert: () => ({ values: async () => undefined }) } }));

// 保留真实导出的 ContentRejectedError：路由用 instanceof 判类型，
// mock 里少掉这个类会让 `err instanceof undefined` 直接抛 TypeError（比原来的 bug 更糟）
vi.mock("../services/content.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/content.service")>();
  return { ...actual, generateSceneWordContent: vi.fn() };
});

vi.mock("../services/word-card.service", () => ({
  generateWordCardContent: vi.fn(),
}));

vi.mock("../services/quiz.service", () => ({
  generateQuizContent: vi.fn(),
}));

const generateMock = vi.mocked(contentService.generateSceneWordContent);
const wordCardMock = vi.mocked(wordCardService.generateWordCardContent);
const quizMock = vi.mocked(quizService.generateQuizContent);

const DTO = {
  id: "cnt_20260817_000001",
  template: "scene_word",
  title: "职场英语：读一个科技创业故事",
  level: "CET4",
  targetDuration: 60,
  content: [
    {
      text: "奥斯丁在一家科技establishment工作。",
      words: [{ word: "establishment", meaning: "机构", level: "CET4" }],
    },
  ],
  words: [{ word: "establishment", meaning: "机构", level: "CET4" }],
  style: { background: "white" },
  voice: { id: "female_01" },
  status: "content_ready",
  createdAt: "2026-08-17T00:00:00.000Z",
  updatedAt: "2026-08-17T00:00:00.000Z",
};

async function postGenerate(body: unknown): Promise<Response> {
  return content.request("/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  generateMock.mockReset();
});

describe("POST /api/content/generate", () => {
  it("合法请求返回 200 与 ContentDTO", async () => {
    generateMock.mockResolvedValue(DTO as never);
    const res = await postGenerate({ topic: "科技创业", level: "CET4" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content.template).toBe("scene_word");
    expect(body.content.status).toBe("content_ready");
    expect(generateMock).toHaveBeenCalledWith({
      topic: "科技创业",
      level: "CET4",
      template: "scene_word",
    });
  });

  it("template=word_card 时走单词卡片生成器", async () => {
    wordCardMock.mockResolvedValue({ ...DTO, template: "word_card" } as never);

    const res = await postGenerate({
      topic: "生活场景",
      level: "CET4",
      template: "word_card",
    });
    expect(res.status).toBe(200);
    expect(wordCardMock).toHaveBeenCalledWith({
      topic: "生活场景",
      level: "CET4",
      template: "word_card",
    });
  });

  it("template=quiz 时走选择题生成器", async () => {
    quizMock.mockResolvedValue({ ...DTO, template: "quiz" } as never);

    const res = await postGenerate({ topic: "校园场景", level: "CET4", template: "quiz" });
    expect(res.status).toBe(200);
    expect(quizMock).toHaveBeenCalledWith({
      topic: "校园场景",
      level: "CET4",
      template: "quiz",
    });
  });

  it("缺少 topic 返回 400", async () => {
    const res = await postGenerate({ level: "CET4" });
    expect(res.status).toBe(400);
  });

  it("level 非法返回 400", async () => {
    const res = await postGenerate({ topic: "x", level: "CET8" });
    expect(res.status).toBe(400);
  });

  it("wordCount 越界返回 400", async () => {
    const res = await postGenerate({ topic: "x", level: "CET4", wordCount: 20 });
    expect(res.status).toBe(400);
  });

  it("非 JSON 请求体返回 400", async () => {
    const res = await content.request("/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  it("LLM 未配置返回 503", async () => {
    generateMock.mockRejectedValue(new LlmNotConfiguredError());
    const res = await postGenerate({ topic: "x", level: "CET4" });
    expect(res.status).toBe(503);
  });

  it("LLM 生成失败返回 500", async () => {
    generateMock.mockRejectedValue(new Error("llm timeout"));
    const res = await postGenerate({ topic: "x", level: "CET4" });
    expect(res.status).toBe(500);
    // 非验收类异常不外泄细节
    expect((await res.json()).error).toBe("Content generation failed");
  });

  it("验收没过时把服务端算出的原因回给前端，而不是压成一句 Content generation failed", async () => {
    generateMock.mockRejectedValue(
      new contentService.ContentRejectedError(
        "内容生成未通过验收：已重试 3 轮仍被拒（有效词不足：仅 5 个（要求至少 8 个））。本地模型偶尔会连续被拒，可直接重试或换个主题再试",
      ),
    );
    const res = await postGenerate({ topic: "x", level: "CET4" });
    expect(res.status).toBe(500);
    const body = await res.json();
    // 界面上只有一行错误块：原因不在响应里，用户就只剩「HTTP 500」可看
    expect(body.error).toContain("有效词不足：仅 5 个");
    expect(body.error).toContain("可直接重试或换个主题再试");
  });
});
