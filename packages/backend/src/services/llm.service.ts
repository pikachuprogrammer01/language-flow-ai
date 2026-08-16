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

/** 调用 LLM Chat Completions，返回助手文本；超时/网络错误抛 Error */
export async function chatCompletion(messages: ChatMessage[]): Promise<string> {
  const baseUrl = process.env.LLM_BASE_URL?.replace(/\/+$/, "");
  const apiKey = process.env.LLM_API_KEY;
  const model = process.env.LLM_MODEL;
  if (!baseUrl || !apiKey || !model) {
    throw new LlmNotConfiguredError();
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, temperature: 0.7 }),
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

/** 从 LLM 输出中提取 JSON（容忍 ```json 围栏与前后杂质文本） */
export function extractJson<T>(raw: string): T {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? raw).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    logger.warn({ raw: raw.slice(0, 300) }, "LLM 输出未找到 JSON 对象");
    throw new Error("LLM 输出不是合法 JSON");
  }
  return JSON.parse(candidate.slice(start, end + 1)) as T;
}
