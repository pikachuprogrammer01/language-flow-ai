/**
 * LLM 引擎状态路由测试 — /status 透传 probeLlm，/wake /sleep 委托引擎状态机，/stream SSE 推流
 * （引擎内部逻辑在 llm-engine.test.ts 单测，此处只验路由层编排与响应契约）
 */
import { describe, expect, it, vi } from "vitest";
import * as llmEngine from "../services/llm-engine";
import * as llmService from "../services/llm.service";
import { llm } from "./llm";

vi.mock("../services/llm.service", () => ({
  probeLlm: vi.fn(),
}));

vi.mock("../services/llm-engine", () => ({
  wakeEngine: vi.fn(),
  sleepEngine: vi.fn(),
  getLlmEngineSnapshot: vi.fn(),
  subscribeLlmEvents: vi.fn(() => () => {}),
}));

const probeMock = vi.mocked(llmService.probeLlm);
const wakeMock = vi.mocked(llmEngine.wakeEngine);
const sleepMock = vi.mocked(llmEngine.sleepEngine);
const snapshotMock = vi.mocked(llmEngine.getLlmEngineSnapshot);
const subscribeMock = vi.mocked(llmEngine.subscribeLlmEvents);

describe("GET /api/llm/status", () => {
  it("连通时返回 connected=true + model", async () => {
    probeMock.mockResolvedValue({ connected: true, model: "qwen2.5:7b" });
    const res = await llm.request("/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: true, model: "qwen2.5:7b" });
  });

  it("未连通时返回原因（HTTP 仍 200，状态是数据不是错误）", async () => {
    probeMock.mockResolvedValue({ connected: false, model: "qwen2.5:7b", reason: "连接被拒绝" });
    const res = await llm.request("/status");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { connected: boolean; reason: string };
    expect(body.connected).toBe(false);
    expect(body.reason).toBe("连接被拒绝");
  });
});

describe("POST /api/llm/wake · POST /api/llm/sleep", () => {
  it("wake 委托 wakeEngine 并透传其即时状态（后续进展走 SSE）", async () => {
    wakeMock.mockResolvedValue({ connected: true, model: "qwen2.5:7b", loaded: false });
    const res = await llm.request("/wake", { method: "POST" });
    expect(res.status).toBe(200);
    expect(wakeMock).toHaveBeenCalledTimes(1);
    expect(await res.json()).toEqual({ connected: true, model: "qwen2.5:7b", loaded: false });
  });

  it("sleep 委托 sleepEngine（典型回探为红灯未连接）", async () => {
    sleepMock.mockResolvedValue({
      connected: false,
      model: "qwen2.5:7b",
      reason: "connect ECONNREFUSED",
    });
    const res = await llm.request("/sleep", { method: "POST" });
    expect(res.status).toBe(200);
    expect(sleepMock).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as { connected: boolean };
    expect(body.connected).toBe(false);
  });
});

describe("GET /api/llm/stream（SSE）", () => {
  it("连接即订阅事件并推送当前快照帧（event: status + EngineSnapshot JSON）", async () => {
    snapshotMock.mockReturnValue({
      phase: "idle",
      status: { connected: true, model: "qwen2.5:7b", installed: true, loaded: true },
    });
    const res = await llm.request("/stream");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");
    expect(subscribeMock).toHaveBeenCalledTimes(1);
    if (!res.body) throw new Error("SSE 响应缺少 body");
    const reader = res.body.getReader();
    const { value } = await reader.read();
    const frame = new TextDecoder().decode(value);
    expect(frame).toContain("event: status");
    expect(frame).toContain('"loaded":true');
    reader.releaseLock();
    await res.body.cancel().catch(() => {});
  });
});
