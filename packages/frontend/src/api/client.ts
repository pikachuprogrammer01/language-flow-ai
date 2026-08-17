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
  const { data, error, response } = await client.POST("/api/content/generate", {
    body: input,
  });
  if (error || !response.ok) throw new Error(`生成失败（HTTP ${response.status}）`);
  if (!data) throw new Error("生成失败：空响应");
  return data.content;
}

/** TTS 配音（ContentArray + template → 音频元数据；scene_word 可传 title 朗读标题） */
export async function synthesizeFromContent(
  template: "scene_word" | "word_card" | "quiz",
  content: Record<string, unknown>[],
  title?: string,
) {
  const { data, error, response } = await client.POST("/api/tts/from-content", {
    body: { template, content, title },
  });
  if (error || !response.ok) throw new Error(`配音失败（HTTP ${response.status}）`);
  if (!data) throw new Error("配音失败：空响应");
  return data.audio;
}

/** 生成响应的 content 类型（供渲染入参复用） */
export type GeneratedContent = Awaited<ReturnType<typeof generateContent>>;

export interface RenderInput extends GeneratedContent {
  /** 收窄为 scene_word：render 判别联合的 scene_word 分支（单页流程固定此模板） */
  template: "scene_word";
  audio: { url: string; duration: number; format: string };
}

/** 渲染视频（完整 ContentDTO → 视频 URL） */
export async function renderVideo(dto: RenderInput) {
  const { data, error, response } = await client.POST("/api/video/render", {
    body: dto,
  });
  if (error || !response.ok) throw new Error(`渲染失败（HTTP ${response.status}）`);
  if (!data) throw new Error("渲染失败：空响应");
  return data.video;
}
