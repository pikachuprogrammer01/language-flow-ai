/**
 * POST /api/content/generate 测试
 * 覆盖：200 生成成功 / 400 参数校验（topic 缺失、level 非法、wordCount 越界、非 JSON）/ 503 LLM 未配置 / 500 LLM 失败
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as contentService from "../services/content.service";
import { LlmNotConfiguredError } from "../services/llm.service";
import { content } from "./content";

vi.mock("../services/content.service", () => ({
  generateSceneWordContent: vi.fn(),
}));

const generateMock = vi.mocked(contentService.generateSceneWordContent);

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
    expect(generateMock).toHaveBeenCalledWith({ topic: "科技创业", level: "CET4" });
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
  });
});
