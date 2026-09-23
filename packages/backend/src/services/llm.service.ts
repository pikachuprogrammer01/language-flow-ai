/**
 * LLM 抽象层（docs/15 §四 + docs/14）
 * OpenAI 兼容 Chat Completions，环境变量切换 Agnes / Ollama，代码零改动：
 *   LLM_BASE_URL  兼容端点（如 https://api.agnes-ai.com/v1 或 http://localhost:11434/v1）
 *   LLM_API_KEY   API key（Ollama 可填任意值）
 *   LLM_MODEL     模型名（如 qwen2.5:7b）
 * 未配置时抛 LlmNotConfiguredError → 路由返回 503
 */
import { logger } from "../lib/logger";

export class LlmNotConfiguredError extends Error {
  constructor() {
    super("LLM 未配置：请设置 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL");
    this.name = "LlmNotConfiguredError";
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 3_000;

export interface LlmStatus {
  /** 引擎服务可达 */
  connected: boolean;
  /** 配置的模型名 */
  model: string;
  /** 模型已安装（/models 列表内含 LLM_MODEL；服务不可达时省略） */
  installed?: boolean;
  /** 模型已加载进内存（Ollama /api/ps；非 Ollama 端点不支持时省略） */
  loaded?: boolean;
  /** 未就绪原因（完全就绪时省略） */
  reason?: string;
}

/** Ollama 模型名匹配：精确相等，或未带 tag 时命中对应 :latest */
export function matchModelName(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  return !expected.includes(":") && actual === `${expected}:latest`;
}

/** /v1/models 响应 → 模型 id 列表（结构异常回空） */
function parseModelIds(payload: unknown): string[] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  return data
    .filter((m): m is { id: string } => typeof (m as { id?: unknown })?.id === "string")
    .map((m) => m.id);
}

/** GET 探询（3s 超时；超时统一抛「探测超时」） */
async function fetchWithTimeout(url: string, headers: Record<string, string>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new Error("探测超时（3s）");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 探测 LLM 引擎就绪度（顶栏状态灯/工作台用），三级判定：
 * ① 服务可达（OpenAI 兼容 GET {base}/models）→ ② 模型已安装（列表含 LLM_MODEL）
 * → ③ 模型已加载进内存（Ollama 原生 GET {host}/api/ps；云端端点不支持时省略 loaded）。
 * 失败不抛异常，统一返回结构化状态。
 */
export async function probeLlm(): Promise<LlmStatus> {
  const baseUrl = process.env.LLM_BASE_URL?.replace(/\/+$/, "");
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL ?? "";
  if (!baseUrl || !apiKey) {
    return { connected: false, model, reason: "LLM_BASE_URL/LLM_API_KEY 未配置" };
  }
  const headers = { Authorization: `Bearer ${apiKey}` };
  try {
    const res = await fetchWithTimeout(`${baseUrl}/models`, headers);
    if (!res.ok) {
      return { connected: false, model, reason: `引擎返回 HTTP ${res.status}` };
    }
    const ids = parseModelIds(await res.json());
    if (!ids.some((id) => matchModelName(model, id))) {
      return { connected: true, model, installed: false, reason: `模型 ${model} 未安装` };
    }
    return await probeModelLoaded(baseUrl, headers, model);
  } catch (err) {
    return { connected: false, model, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** 第三级：探 Ollama /api/ps 内存加载态；非 Ollama 端点（404/异常）时省略 loaded */
async function probeModelLoaded(
  baseUrl: string,
  headers: Record<string, string>,
  model: string,
): Promise<LlmStatus> {
  const host = baseUrl.replace(/\/v1$/, "");
  try {
    const res = await fetchWithTimeout(`${host}/api/ps`, headers);
    if (!res.ok) return { connected: true, model, installed: true };
    const running = ((await res.json()) as { models?: { name?: unknown }[] }).models ?? [];
    const loaded = running.some((m) => typeof m.name === "string" && matchModelName(model, m.name));
    return loaded
      ? { connected: true, model, installed: true, loaded: true }
      : {
          connected: true,
          model,
          installed: true,
          loaded: false,
          reason: `模型 ${model} 未加载进内存（首次调用需冷加载）`,
        };
  } catch {
    return { connected: true, model, installed: true };
  }
}

/** 本机 Ollama 端点判定（host.docker.internal = 容器栈访问宿主机 Ollama，可 HTTP 操控但不含 brew） */
const LOCAL_LLM_HOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1|host\.docker\.internal)(:\d+)?$/;

/**
 * 一键唤醒：启动 Ollama 服务并把配置模型加载进内存（顶栏按钮触发）。
 * 仅限本机 Ollama 端点（回环 或 容器经 host.docker.internal 访问宿主）：固定命令无用户输入；真云端端点直接回退探测。
 * 关键：host.docker.internal 也必须走到步骤 3 真正触发 /api/generate 加载，否则状态机只会空等看门狗超时。
 * 模型加载 fire-and-forget（7B 冷加载可达分钟级），前端靠 SSE 推流感知就绪。
 */
export async function wakeLlm(): Promise<LlmStatus> {
  const baseUrl = process.env.LLM_BASE_URL?.replace(/\/+$/, "");
  const model = process.env.LLM_MODEL ?? "";
  if (!baseUrl) {
    return { connected: false, model, reason: "LLM_BASE_URL 未配置" };
  }
  const host = baseUrl.replace(/\/v1$/, "");
  // 真云端/非本机 Ollama 端点无需本地拉起：直接回探；host.docker.internal 属可控本机端点，继续完整流程
  if (!LOCAL_LLM_HOST_RE.test(host)) {
    return await probeLlm();
  }
  // 1) 确保服务进程存在：仅宿主机回环可 brew 拉起；容器经 host.docker.internal 无 brew、也无法代起宿主服务，跳过（失败本就容错）
  const isHostLoopback = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
  if (isHostLoopback) {
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      await promisify(execFile)("brew", ["services", "start", "ollama"], { timeout: 15_000 });
    } catch (err) {
      logger.warn({ err }, "brew services start ollama 失败，继续探测服务可用性");
    }
  }
  // 2) 等服务就绪（最多 10s）
  for (let i = 0; i < 10; i += 1) {
    try {
      const res = await fetch(`${host}/api/version`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) break;
    } catch {
      // 未就绪，重试
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  // 3) 触发模型加载进内存（keep_alive 1h，fire-and-forget）——回环与 host.docker.internal 都要执行
  void fetch(`${host}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, keep_alive: "1h" }),
    signal: AbortSignal.timeout(300_000),
  }).catch(() => {
    // 加载失败由下一轮 probeLlm 状态呈现（红灯/黄灯），不在此静默吞掉体验
  });
  const status = await probeLlm();
  // 容器经 host.docker.internal 访问宿主 Ollama：服务未起时无法代起（容器无 brew），错误原因补可操作的引导
  if (!status.connected && !isHostLoopback) {
    return {
      ...status,
      reason: `${status.reason ?? "服务不可达"}（容器无法代起宿主 Ollama，请在宿主机打开 Ollama 应用后重试）`,
    };
  }
  return status;
}

/**
 * 一键关闭：卸载配置模型并把 Ollama 服务停掉（wakeLlm 的镜像操作，顶栏关闭按钮触发）。
 * 云端端点不执行任何本地动作直接回探；本机端点先 `POST /api/generate {keep_alive:0}` 释放内存，
 * 再 `brew services stop ollama`（幂等；容器内无 brew/非 brew 安装失败不阻断，仅记 warn）。
 * 停完回探一次，返回真实状态（典型为红灯 connected=false 或黄灯 loaded=false）。
 */
export async function sleepLlm(): Promise<LlmStatus> {
  const baseUrl = process.env.LLM_BASE_URL?.replace(/\/+$/, "");
  const model = process.env.LLM_MODEL ?? "";
  if (!baseUrl) {
    return { connected: false, model, reason: "LLM_BASE_URL 未配置" };
  }
  const host = baseUrl.replace(/\/v1$/, "");
  // 云端/非本机端点无本地进程可关：直接回探
  if (!LOCAL_LLM_HOST_RE.test(host)) {
    return await probeLlm();
  }
  // 1) 卸载模型（keep_alive=0 立即释放；服务已停/不可达时失败可容忍）
  try {
    await fetch(`${host}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, keep_alive: 0 }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    logger.warn({ err }, "Ollama 模型卸载请求失败（服务可能已停止），继续尝试停服务");
  }
  // 2) 停 Ollama 服务（brew 管理的安装方式；失败不阻断，状态以回探为准）
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(execFile)("brew", ["services", "stop", "ollama"], { timeout: 15_000 });
  } catch (err) {
    logger.warn(
      { err },
      "brew services stop ollama 失败（容器内或非 brew 安装属预期），继续回探状态",
    );
  }
  return await probeLlm();
}

export interface ChatCompletionOptions {
  temperature?: number;
  timeoutMs?: number;
}

/** 调用 LLM Chat Completions，返回助手文本；超时/网络错误抛 Error */
export async function chatCompletion(
  messages: ChatMessage[],
  options: ChatCompletionOptions = {},
): Promise<string> {
  const baseUrl = process.env.LLM_BASE_URL?.replace(/\/+$/, "");
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL;
  if (!baseUrl || !apiKey || !model) {
    throw new LlmNotConfiguredError();
  }

  const temperature = options.temperature ?? 0.7;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, temperature }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`LLM API 返回 ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("LLM 响应缺少 choices[0].message.content");
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从 LLM 输出中提取 JSON（容忍 ```json 围栏、前后杂质、尾部多余字符）
 * 迭代策略：从第一个 { 开始，依次尝试所有 } 位置，取第一个能解析成功的对象
 */
export function extractJson<T>(raw: string): T {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? raw).trim();
  const start = candidate.indexOf("{");
  if (start === -1) {
    logger.warn({ raw: raw.slice(0, 300) }, "LLM 输出未找到 JSON 对象");
    throw new Error("LLM 输出不是合法 JSON");
  }
  let end = candidate.lastIndexOf("}");
  while (end > start) {
    try {
      return JSON.parse(candidate.slice(start, end + 1)) as T;
    } catch {
      end = candidate.lastIndexOf("}", end - 1);
    }
  }
  logger.warn({ raw: raw.slice(0, 300) }, "LLM 输出未找到合法 JSON");
  throw new Error("LLM 输出不是合法 JSON");
}
