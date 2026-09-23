/**
 * llm-engine 状态机单测 — 过渡态广播 / 失败与降级提示 / 冷加载看门狗 / 订阅对账生命周期
 * （llm.service 三个原子操作全部 mock，不发真实请求；定时器用 vi fake timers 驱动）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineSnapshot } from "./llm-engine";
import type { LlmStatus } from "./llm.service";

const { probeMock, wakeMock, sleepMock } = vi.hoisted(() => ({
  probeMock: vi.fn(),
  wakeMock: vi.fn(),
  sleepMock: vi.fn(),
}));
vi.mock("./llm.service", () => ({
  probeLlm: probeMock,
  wakeLlm: wakeMock,
  sleepLlm: sleepMock,
}));

const { getLlmEngineSnapshot, resetLlmEngineForTest, sleepEngine, subscribeLlmEvents, wakeEngine } =
  await import("./llm-engine");

const READY: LlmStatus = { connected: true, model: "qwen2.5:7b", installed: true, loaded: true };
const DOWN: LlmStatus = { connected: false, model: "qwen2.5:7b", reason: "connect ECONNREFUSED" };
/** 已装未加载（黄灯待机） */
const STANDBY: LlmStatus = { connected: true, model: "qwen2.5:7b", installed: true, loaded: false };

let events: EngineSnapshot[] = [];
let unsubscribes: (() => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  resetLlmEngineForTest(); // 单例状态机：每个用例从干净状态开始
  probeMock.mockReset();
  wakeMock.mockReset();
  sleepMock.mockReset();
  // 订阅即触发的对账也走 probeLlm：给桩默认值，防用例忘设时 reconcile 拿到 undefined 抛错
  probeMock.mockResolvedValue(STANDBY);
  events = [];
});

afterEach(() => {
  for (const u of unsubscribes) u();
  unsubscribes = [];
  resetLlmEngineForTest(); // 兜底停表，防泄漏到下一用例
  vi.useRealTimers();
});

/** 订阅并收集广播（每个用例结束由 afterEach 统一退订） */
function capture(): void {
  unsubscribes.push(
    subscribeLlmEvents((s) => {
      events.push(s);
    }),
  );
}

describe("wakeEngine", () => {
  it("启动失败：进入 starting 后回 idle，error 给出服务级原因", async () => {
    wakeMock.mockResolvedValue(DOWN);
    capture();
    const status = await wakeEngine();
    expect(status).toEqual(DOWN);
    expect(events.some((e) => e.phase === "starting" && !!e.progress)).toBe(true);
    const last = events.at(-1);
    expect(last?.phase).toBe("idle");
    expect(last?.error).toContain("Ollama 服务启动失败");
  });

  it("一次到位：wakeLlm 返回已加载 → idle 且无 error", async () => {
    wakeMock.mockResolvedValue(READY);
    probeMock.mockResolvedValue(READY);
    capture();
    await wakeEngine();
    const snap = getLlmEngineSnapshot();
    expect(snap.phase).toBe("idle");
    expect(snap.error).toBeUndefined();
    expect(snap.status.loaded).toBe(true);
  });

  it("冷加载看门狗：starting(加载中文案) → 探测到 loaded 转 idle；过渡态重复调用幂等不二次拉起", async () => {
    wakeMock.mockResolvedValue(STANDBY);
    probeMock.mockResolvedValue(STANDBY);
    capture();
    const running = wakeEngine();
    await vi.advanceTimersByTimeAsync(0); // 放 wakeLlm 微任务链，进入「加载进内存」进度态
    expect(getLlmEngineSnapshot().phase).toBe("starting");
    expect(getLlmEngineSnapshot().progress).toContain("加载进内存");
    // 过渡态中的重复点击：幂等返回当前状态，不再触发 wakeLlm
    await wakeEngine();
    expect(wakeMock).toHaveBeenCalledTimes(1);
    await running;
    probeMock.mockResolvedValue(READY);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(getLlmEngineSnapshot().phase).toBe("idle");
    expect(getLlmEngineSnapshot().status.loaded).toBe(true);
  });

  it("加载超时（5 分钟）→ error 提示可重试", async () => {
    wakeMock.mockResolvedValue(STANDBY);
    probeMock.mockResolvedValue(STANDBY);
    capture();
    await wakeEngine();
    await vi.advanceTimersByTimeAsync(304_000);
    const snap = getLlmEngineSnapshot();
    expect(snap.phase).toBe("idle");
    expect(snap.error).toContain("加载超时");
  });

  it("加载途中引擎失联 → error 如实播报", async () => {
    wakeMock.mockResolvedValue(STANDBY);
    probeMock.mockResolvedValue(DOWN);
    capture();
    await wakeEngine();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(getLlmEngineSnapshot().error).toContain("失联");
  });
});

describe("sleepEngine", () => {
  it("完全停止：回 idle、无 error/notice（红灯即成功终态）", async () => {
    sleepMock.mockResolvedValue(DOWN);
    capture();
    await sleepEngine();
    const snap = getLlmEngineSnapshot();
    expect(snap.phase).toBe("idle");
    expect(snap.error).toBeUndefined();
    expect(snap.notice).toBeUndefined();
  });

  it("容器内降级：模型卸载成功但服务未停 → notice（非 error）提示手动退出", async () => {
    sleepMock.mockResolvedValue(STANDBY);
    capture();
    await sleepEngine();
    const snap = getLlmEngineSnapshot();
    expect(snap.phase).toBe("idle");
    expect(snap.error).toBeUndefined();
    expect(snap.notice).toContain("模型已卸载");
  });

  it("关闭失败：模型仍在内存 → error", async () => {
    sleepMock.mockResolvedValue(READY);
    capture();
    await sleepEngine();
    expect(getLlmEngineSnapshot().error).toContain("关闭失败");
  });
});

describe("subscribeLlmEvents / 对账生命周期", () => {
  it("首个订阅者立即对账；无变化不广播；退订后定时器停摆", async () => {
    probeMock.mockResolvedValue(READY);
    const unsub = subscribeLlmEvents(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(probeMock).toHaveBeenCalledTimes(1); // 首订阅即探一次
    await vi.advanceTimersByTimeAsync(30_000);
    expect(probeMock).toHaveBeenCalledTimes(2); // 30s 对账一次
    unsub();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(probeMock).toHaveBeenCalledTimes(2); // 无订阅者不再探测
  });

  it("idle 状态下外部变化被捕获并广播；引擎自行恢复就绪时清掉陈旧 error", async () => {
    probeMock.mockResolvedValue(DOWN);
    capture();
    await vi.advanceTimersByTimeAsync(0);
    expect(events.some((e) => e.status.connected === false)).toBe(true);
    probeMock.mockResolvedValue(READY);
    await vi.advanceTimersByTimeAsync(30_000);
    const last = events.at(-1);
    expect(last?.status.connected).toBe(true);
    expect(last?.error).toBeUndefined();
  });
});

describe("wake/sleep 流程异常（原子操作自身抛错不致状态机卡死）", () => {
  it("wakeLlm 抛错 → 回 idle 且 error 播报「启动流程异常」", async () => {
    wakeMock.mockRejectedValue(new Error("brew exploded"));
    capture();
    await wakeEngine();
    const last = events.at(-1);
    expect(last?.phase).toBe("idle");
    expect(last?.error).toContain("启动流程异常");
    expect(last?.error).toContain("brew exploded");
  });

  it("sleepLlm 抛错 → 回 idle 且 error 播报「关闭流程异常」", async () => {
    sleepMock.mockRejectedValue(new Error("kill exploded"));
    capture();
    await sleepEngine();
    const last = events.at(-1);
    expect(last?.phase).toBe("idle");
    expect(last?.error).toContain("关闭流程异常");
  });
});
