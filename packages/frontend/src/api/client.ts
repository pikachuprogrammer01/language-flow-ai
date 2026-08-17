/**
 * API 客户端 — openapi-fetch（类型安全，schema.d.ts 由 openapi.json 自动生成）
 * 用法：pnpm gen-api 重新生成（后端启动时 openapi.json 已刷新）
 */
import createClient from "openapi-fetch";
import type { paths } from "./schema.d.ts";

export const client = createClient<paths>({
  baseUrl: import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080",
});

export interface GenerateInput {
  topic: string;
  level: "CET4" | "CET6";
  wordCount?: number;
  targetDuration?: number;
}

/** 生成内容（ContentDTO） */
export async function generateContent(input: GenerateInput) {
  const { data, error } = await client.POST("/api/content/generate", {
    body: input,
  });
  if (error) throw new Error(typeof error === "string" ? error : "生成失败");
  if (!data) throw new Error("空响应");
  return data.content;
}

/** TTS 配音（ContentArray + template → 音频元数据） */
export async function synthesizeFromContent(
  template: "scene_word" | "word_card" | "quiz",
  content: Record<string, unknown>[],
) {
  const { data, error } = await client.POST("/api/tts/from-content", {
    body: { template, content },
  });
  if (error) throw new Error(typeof error === "string" ? error : "配音失败");
  if (!data) throw new Error("空响应");
  return data.audio;
}

/** 渲染视频（完整 ContentDTO → 视频 URL） */
export async function renderVideo(dto: unknown) {
  const { data, error } = await client.POST("/api/video/render", {
    body: dto as never,
  });
  if (error) throw new Error(typeof error === "string" ? error : "渲染失败");
  if (!data) throw new Error("空响应");
  return data.video;
}
