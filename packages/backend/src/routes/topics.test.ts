/**
 * POST /api/topics/suggest 测试
 * 覆盖：成功返回候选 / 无 hint 也可用 / LLM 失败 500 / LLM 未配置 503
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as llm from "../services/llm.service";
import { topics } from "./topics";

vi.mock("../services/llm.service", () => ({
  chatCompletion: vi.fn(),
  extractJson: vi.fn(),
  // 与真实类一致：无参构造（固定消息）
  LlmNotConfiguredError: class LlmNotConfiguredError extends Error {},
}));

const chatMock = vi.mocked(llm.chatCompletion);
const extractMock = vi.mocked(llm.extractJson);

const app = topics;

beforeEach(() => {
  chatMock.mockReset();
  extractMock.mockReset();
});

describe("POST /api/topics/suggest", () => {
  it("返回 LLM 生成的主题候选", async () => {
    chatMock.mockResolvedValue(
      '{"topics":[{"title":"深夜便利店","description":"值夜班的故事"},{"title":"森林露营","description":"野外过夜"}]}',
    );
    extractMock.mockReturnValue({
      topics: [
        { title: "深夜便利店", description: "值夜班的故事" },
        { title: "森林露营", description: "野外过夜" },
      ],
    });

    const res = await app.request("/suggest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hint: "便利店" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { topics: { title: string }[] };
    expect(body.topics).toHaveLength(2);
    expect(body.topics[0].title).toBe("深夜便利店");
  });

  it("无 hint 也可生成（默认覆盖常见场景）", async () => {
    chatMock.mockResolvedValue('{"topics":[{"title":"校园生活","description":"社团招新"}]}');
    extractMock.mockReturnValue({ topics: [{ title: "校园生活", description: "社团招新" }] });

    const res = await app.request("/suggest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
  });

  it("候选为空返回 500", async () => {
    chatMock.mockResolvedValue('{"topics":[]}');
    extractMock.mockReturnValue({ topics: [] });

    const res = await app.request("/suggest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hint: "x" }),
    });
    expect(res.status).toBe(500);
  });

  it("LLM 未配置返回 503", async () => {
    chatMock.mockRejectedValue(new llm.LlmNotConfiguredError());
    const res = await app.request("/suggest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(503);
  });
});
