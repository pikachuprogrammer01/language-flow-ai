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

/** TTS 配音（ContentArray + template → 音频元数据；scene_word 可传 title 朗读标题，voice 选择音色） */
export async function synthesizeFromContent(
  template: "scene_word" | "word_card" | "quiz",
  content: Record<string, unknown>[],
  title?: string,
  voice?: string,
) {
  const { data, error, response } = await client.POST("/api/tts/from-content", {
    body: { template, content, title, voice },
  });
  if (error || !response.ok) throw new Error(`配音失败（HTTP ${response.status}）`);
  if (!data) throw new Error("配音失败：空响应");
  return data.audio;
}

/** 可用配音列表（PRD §10.1.1 配音可选） */
export async function listVoices() {
  const { data, error, response } = await client.GET("/api/tts/voices");
  if (error || !response.ok) throw new Error(`获取配音列表失败（HTTP ${response.status}）`);
  if (!data) throw new Error("获取配音列表失败：空响应");
  return data;
}

/** 生成响应的 content 类型（供渲染入参复用） */
export type GeneratedContent = Awaited<ReturnType<typeof generateContent>>;

export interface RenderInput extends GeneratedContent {
  /** 收窄为 scene_word：render 判别联合的 scene_word 分支（单页流程固定此模板） */
  template: "scene_word";
  audio: { url: string; duration: number; format: string };
}

/** 渲染入参（宽松版：详情页从任务记录组装，关键字段由 isRenderInput 守卫，后端 zod 兜底） */
export type RenderVideoInput = {
  template: "scene_word";
  audio: { url: string; duration: number; format: string };
} & Record<string, unknown>;

/** 渲染视频（完整 ContentDTO → 视频 URL；详情页重新配音走宽松 Record，后端 zod 兜底） */
export async function renderVideo(dto: RenderInput | RenderVideoInput) {
  const { data, error, response } = await client.POST("/api/video/render", {
    // openapi-fetch body 类型为 schema 推断的完整 DTO；详情页记录为宽松 Record，运行时由后端 zod 校验兜底
    body: dto as never,
  });
  if (error || !response.ok) throw new Error(`渲染失败（HTTP ${response.status}）`);
  if (!data) throw new Error("渲染失败：空响应");
  return data.video;
}

/** 生成记录（任务）列表 */
export async function listTasks(
  params: {
    status?:
      | "draft"
      | "ai_generating"
      | "content_ready"
      | "tts_processing"
      | "audio_ready"
      | "video_rendering"
      | "completed"
      | "failed";
    page?: number;
    pageSize?: number;
  } = {},
) {
  const { data, error, response } = await client.GET("/api/tasks", { params: { query: params } });
  if (error || !response.ok) throw new Error(`查询任务失败（HTTP ${response.status}）`);
  if (!data) throw new Error("查询任务失败：空响应");
  return data;
}

/** 生成记录详情（ContentDTO 全量） */
export async function getTask(id: string) {
  const { data, error, response } = await client.GET("/api/tasks/{id}", {
    params: { path: { id } },
  });
  if (error || !response.ok) throw new Error(`查询任务详情失败（HTTP ${response.status}）`);
  if (!data) throw new Error("查询任务详情失败：空响应");
  return data;
}

/** 更新生成记录（标题/配音/视频/状态回写） */
export async function updateTask(
  id: string,
  body: {
    title?: string;
    audio?: { url: string; duration: number; format: string };
    video?: { url: string; duration: number; format: string };
    status?:
      | "draft"
      | "ai_generating"
      | "content_ready"
      | "tts_processing"
      | "audio_ready"
      | "video_rendering"
      | "completed"
      | "failed";
  },
) {
  const { data, error, response } = await client.PATCH("/api/tasks/{id}", {
    params: { path: { id } },
    body,
  });
  if (error || !response.ok) throw new Error(`更新任务失败（HTTP ${response.status}）`);
  if (!data) throw new Error("更新任务失败：空响应");
  return data;
}

/** 删除生成记录 */
export async function deleteTask(id: string) {
  const { data, error, response } = await client.DELETE("/api/tasks/{id}", {
    params: { path: { id } },
  });
  if (error || !response.ok) throw new Error(`删除任务失败（HTTP ${response.status}）`);
  return data;
}

/** 上传文件列表（audio/video，含是否被记录引用） */
export async function listFiles(params: { type?: "audio" | "video" } = {}) {
  const { data, error, response } = await client.GET("/api/files", { params: { query: params } });
  if (error || !response.ok) throw new Error(`查询文件失败（HTTP ${response.status}）`);
  if (!data) throw new Error("查询文件失败：空响应");
  return data;
}

/** 删除上传文件（被记录引用的文件删除后记录中不可播放） */
export async function deleteFile(filename: string) {
  const { data, error, response } = await client.DELETE("/api/files/{filename}", {
    params: { path: { filename } },
  });
  if (error || !response.ok) throw new Error(`删除文件失败（HTTP ${response.status}）`);
  return data;
}
