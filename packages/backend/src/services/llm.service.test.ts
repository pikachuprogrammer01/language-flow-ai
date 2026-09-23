/**
 * probeLlm / wakeLlm / sleepLlm 测试 — LLM 引擎探测与一键启停（mock 全局 fetch/child_process，不发真实请求）
 * 覆盖：未配置 / 服务不可达 / 模型未安装 / 已安装未加载 / 完全就绪 / 超时；唤醒端点分流（回环/容器/云端）；matchModelName 纯函数
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matchModelName, probeLlm, sleepLlm, wakeLlm } from "./llm.service";

const fetchMock = vi.fn();
// brew 停服务走 child_process.execFile：整体 mock，默认成功回调（sleepLlm 内部动态 import 同样被拦截）
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

beforeEach(() => {
  execFileMock.mockReset();
  execFileMock.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => cb(null),
  );
});

/** 按 URL 路由 fetch 响应（/models 与 /api/ps 各自可控） */
function stubEndpoints(models: unknown, ps: unknown): void {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith("/models")) return new Response(JSON.stringify(models), { status: 200 });
    if (url.endsWith("/api/ps")) return new Response(JSON.stringify(ps), { status: 200 });
    return new Response("{}", { status: 404 });
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("LLM_BASE_URL", "http://localhost:11434/v1");
  vi.stubEnv("LLM_API_KEY", "ollama");
  vi.stubEnv("LLM_MODEL", "qwen2.5:7b");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("probeLlm", () => {
  it("未配置 base/key 时直接判定未连接并给出原因", async () => {
    vi.stubEnv("LLM_BASE_URL", "");
    const status = await probeLlm();
    expect(status).toEqual({
      connected: false,
      model: "qwen2.5:7b",
      reason: "LLM_BASE_URL/LLM_API_KEY 未配置",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("引擎可达且模型已安装已加载时返回完全就绪", async () => {
    stubEndpoints({ data: [{ id: "qwen2.5:7b" }] }, { models: [{ name: "qwen2.5:7b" }] });
    const status = await probeLlm();
    expect(status).toEqual({
      connected: true,
      model: "qwen2.5:7b",
      installed: true,
      loaded: true,
    });
  });

  it("服务可达但模型未安装 → installed=false 带原因", async () => {
    stubEndpoints({ data: [{ id: "llama3:8b" }] }, { models: [] });
    const status = await probeLlm();
    expect(status).toEqual({
      connected: true,
      model: "qwen2.5:7b",
      installed: false,
      reason: "模型 qwen2.5:7b 未安装",
    });
  });

  it("模型已安装但未加载进内存 → loaded=false（待机态）", async () => {
    stubEndpoints({ data: [{ id: "qwen2.5:7b" }] }, { models: [] });
    const status = await probeLlm();
    expect(status.installed).toBe(true);
    expect(status.loaded).toBe(false);
    expect(status.reason).toContain("未常驻内存");
    expect(status.reason).toContain("不影响可用性");
  });

  it("/api/ps 不可用（云端兼容端点）时省略 loaded，不阻断就绪判定", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/models"))
        return new Response(JSON.stringify({ data: [{ id: "qwen2.5:7b" }] }), { status: 200 });
      return new Response("{}", { status: 404 });
    });
    const status = await probeLlm();
    expect(status).toEqual({ connected: true, model: "qwen2.5:7b", installed: true });
  });

  it("引擎返回非 2xx 时带 HTTP 状态原因", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 500 }));
    const status = await probeLlm();
    expect(status.connected).toBe(false);
    expect(status.reason).toContain("500");
  });

  it("网络错误时透出错误信息", async () => {
    fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));
    const status = await probeLlm();
    expect(status).toEqual({
      connected: false,
      model: "qwen2.5:7b",
      reason: "connect ECONNREFUSED",
    });
  });

  it("探测超时（AbortError）返回固定文案", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    fetchMock.mockRejectedValue(abortErr);
    const status = await probeLlm();
    expect(status.reason).toBe("探测超时（3s）");
  });
});

describe("matchModelName", () => {
  it("精确相等命中；未带 tag 时命中 :latest；带 tag 不同族不命中", () => {
    expect(matchModelName("qwen2.5:7b", "qwen2.5:7b")).toBe(true);
    expect(matchModelName("qwen2.5", "qwen2.5:latest")).toBe(true);
    expect(matchModelName("qwen2.5", "qwen2.5:7b")).toBe(false);
    expect(matchModelName("qwen2.5:7b", "qwen2.5:3b")).toBe(false);
  });
});

describe("wakeLlm", () => {
  /** /api/version 即时就绪（跳出等待循环）；/models 已安装、/api/ps 未加载 → 黄灯待机 */
  function stubWakeUrls(): void {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/api/version")) return new Response('{"version":"0.9"}', { status: 200 });
      if (url.endsWith("/models"))
        return new Response(JSON.stringify({ data: [{ id: "qwen2.5:7b" }] }), { status: 200 });
      if (url.endsWith("/api/ps"))
        return new Response(JSON.stringify({ models: [] }), { status: 200 });
      return new Response("{}", { status: 200 });
    });
  }

  it("host.docker.internal（容器栈）：跳过 brew 但真实触发模型加载（回归：曾只回探导致空等超时）", async () => {
    vi.stubEnv("LLM_BASE_URL", "http://host.docker.internal:11434/v1");
    stubWakeUrls();
    const status = await wakeLlm();
    expect(execFileMock).not.toHaveBeenCalled();
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain("http://host.docker.internal:11434/api/generate");
    expect(status.connected).toBe(true);
    expect(status.loaded).toBe(false); // 服务就绪但尚未加载完（黄灯，看门狗继续盯）
  });

  it("宿主机回环端点：brew 拉起服务 + 触发模型加载", async () => {
    stubWakeUrls();
    await wakeLlm();
    expect(execFileMock).toHaveBeenCalled();
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain("http://localhost:11434/api/generate");
  });

  it("真云端端点：仅回探，不发 generate 不碰 brew", async () => {
    vi.stubEnv("LLM_BASE_URL", "https://api.example.com/v1");
    stubEndpoints({ data: [{ id: "qwen2.5:7b" }] }, { models: [] });
    const status = await wakeLlm();
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.endsWith("/api/generate"))).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(status.connected).toBe(true);
  });
});

describe("sleepLlm", () => {
  it("未配置 LLM_BASE_URL：不发任何请求，直接返回未连接", async () => {
    vi.stubEnv("LLM_BASE_URL", "");
    const status = await sleepLlm();
    expect(status.reason).toBe("LLM_BASE_URL 未配置");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("云端端点：不卸载不停服务，仅回探", async () => {
    vi.stubEnv("LLM_BASE_URL", "https://api.example.com/v1");
    stubEndpoints({ data: [{ id: "qwen2.5:7b" }] }, { models: [] });
    const status = await sleepLlm();
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.endsWith("/api/generate"))).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
    expect(status.connected).toBe(true);
  });

  it("本机端点：keep_alive=0 卸载模型 + brew 停服务，返回停后回探状态（红灯）", async () => {
    stubEndpoints({ data: [{ id: "qwen2.5:7b" }] }, { models: [{ name: "qwen2.5:7b" }] });
    // 卸载/探活成功后 brew 停服务，后续探活拒绝连接 → 模拟已停机
    let generateDone = false;
    fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
      if (init?.method === "POST" && url.endsWith("/api/generate")) {
        generateDone = true;
        return new Response("{}", { status: 200 });
      }
      if (generateDone) throw new Error("connect ECONNREFUSED");
      if (url.endsWith("/models"))
        return new Response(JSON.stringify({ data: [{ id: "qwen2.5:7b" }] }), { status: 200 });
      return new Response(JSON.stringify({ models: [{ name: "qwen2.5:7b" }] }), { status: 200 });
    });
    const status = await sleepLlm();
    expect(status).toEqual({
      connected: false,
      model: "qwen2.5:7b",
      reason: "connect ECONNREFUSED",
    });
    expect(execFileMock).toHaveBeenCalled();
  });

  it("host.docker.internal（容器栈）：可 HTTP 卸载模型；brew 失败不阻断，回探黄灯待机", async () => {
    vi.stubEnv("LLM_BASE_URL", "http://host.docker.internal:11434/v1");
    execFileMock.mockImplementation(
      (_c: string, _a: string[], _o: unknown, cb: (err: Error | null) => void) =>
        cb(new Error("brew: command not found")),
    );
    stubEndpoints({ data: [{ id: "qwen2.5:7b" }] }, { models: [] });
    const status = await sleepLlm();
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls).toContain("http://host.docker.internal:11434/api/generate");
    expect(status.connected).toBe(true);
    expect(status.loaded).toBe(false);
  });

  it("卸载请求失败（服务已停）不抛异常，仍以回探状态为准", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: { method?: string }) => {
      if (init?.method === "POST") throw new Error("connect ECONNREFUSED");
      throw new Error("service down");
    });
    const status = await sleepLlm();
    expect(status.connected).toBe(false);
    expect(status.reason).toBe("service down");
  });
});
