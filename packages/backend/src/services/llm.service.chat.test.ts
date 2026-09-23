/**
 * chatCompletion / probeLlm 补充分支单测 — mock 全局 fetch，不发真实 LLM 请求
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LlmNotConfiguredError, chatCompletion, probeLlm } from "./llm.service";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("LLM_BASE_URL", "http://localhost:11434/v1");
  vi.stubEnv("LLM_API_KEY", "test-key");
  vi.stubEnv("LLM_MODEL", "qwen2.5:7b");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("chatCompletion", () => {
  it("成功：带 Bearer 头与 model/messages/temperature，返回助手文本", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "回复内容" } }] }), {
        status: 200,
      }),
    );
    const out = await chatCompletion([{ role: "user", content: "hi" }], { temperature: 0.2 });
    expect(out).toBe("回复内容");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:11434/v1/chat/completions");
    expect(init.headers).toMatchObject({ Authorization: "Bearer test-key" });
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "qwen2.5:7b",
      temperature: 0.2,
    });
  });

  it("未配置端点：抛 LlmNotConfiguredError 且不发请求", async () => {
    vi.stubEnv("LLM_API_KEY", "");
    await expect(chatCompletion([{ role: "user", content: "x" }])).rejects.toBeInstanceOf(
      LlmNotConfiguredError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("HTTP 非 2xx：错误信息含状态码与响应片段", async () => {
    fetchMock.mockResolvedValue(new Response("model not found", { status: 404 }));
    await expect(chatCompletion([{ role: "user", content: "x" }])).rejects.toThrow("404");
  });

  it("响应缺 choices[0].message.content：抛可读错误", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    await expect(chatCompletion([{ role: "user", content: "x" }])).rejects.toThrow("缺少");
  });

  it("超时：AbortSignal 中断挂起的请求", async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      void _url;
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });
    await expect(
      chatCompletion([{ role: "user", content: "x" }], { timeoutMs: 50 }),
    ).rejects.toBeInstanceOf(DOMException);
  });
});

describe("probeLlm 补充分支", () => {
  it("/api/ps 请求异常：省略 loaded 不阻断（云端兼容语义）", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/models"))
        return new Response(JSON.stringify({ data: [{ id: "qwen2.5:7b" }] }), { status: 200 });
      throw new Error("ps endpoint gone");
    });
    const status = await probeLlm();
    expect(status).toEqual({ connected: true, model: "qwen2.5:7b", installed: true });
  });
});
