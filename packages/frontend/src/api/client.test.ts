/**
 * api/client 的错误映射（真实闭环批次三收尾时补）
 *
 * 钉的是「失败原因能不能走到界面上」这一件事：服务端已经把可执行的原因
 * （有效词不足、要求至少 8 个…）放进响应体，客户端早先只报 `HTTP 500`，
 * 用户看到的就是一个状态码。这里用 stub fetch 固定两种终态。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("generateContent 的错误播报", () => {
  it("服务端给了原因：原文抛出去，让错误块能照着下一步", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse(500, {
        error:
          "内容生成未通过验收：已重试 3 轮仍被拒（有效词不足：仅 5 个（要求至少 8 个））。本地模型偶尔会连续被拒，可直接重试或换个主题再试",
      }),
    );
    const { generateContent } = await import("./client");
    await expect(generateContent({ topic: "量子色动力学", level: "CET4" })).rejects.toThrow(
      "有效词不足：仅 5 个",
    );
  });

  it("服务端没给原因（网关/HTML 错误页）：退回状态码，不编造一句「成功」", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response("<html>502 Bad Gateway</html>", {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
    );
    const { generateContent } = await import("./client");
    await expect(generateContent({ topic: "x", level: "CET4" })).rejects.toThrow(
      "生成失败（HTTP 502）",
    );
  });
});
