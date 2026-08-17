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
  /** 模板选择（MVP 需求 #1）：scene_word 情景背词 / word_card 单词卡片 */
  template?: "scene_word" | "word_card" | "quiz";
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
  rate?: number,
) {
  const { data, error, response } = await client.POST("/api/tts/from-content", {
    body: { template, content, title, voice, rate },
  });
  if (error || !response.ok) {
    // error 含 zod 校验详情（如字段缺失），拼进提示便于排查
    const detail =
      typeof error === "object" && error !== null
        ? JSON.stringify(error).slice(0, 300)
        : String(error ?? "");
    throw new Error(`配音失败（HTTP ${response.status}）${detail ? `：${detail}` : ""}`);
  }
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

/** 主题推荐（本地模型生成候选，用户确认后生成；PRD §10.1.2） */
export async function suggestTopics(body: { hint?: string }) {
  const { data, error, response } = await client.POST("/api/topics/suggest", { body });
  if (error || !response.ok) throw new Error(`主题推荐失败（HTTP ${response.status}）`);
  if (!data) throw new Error("主题推荐失败：空响应");
  return data;
}

/** 音色试听：指定音色合成文本并返回音频 URL（PRD §10.1.1） */
export async function previewVoice(voice: string, text: string) {
  const { data, error, response } = await client.POST("/api/tts/generate", {
    body: { text, voice },
  });
  if (error || !response.ok) throw new Error(`试听合成失败（HTTP ${response.status}）`);
  if (!data) throw new Error("试听合成失败：空响应");
  return data;
}

/** 生成响应的 content 类型（供渲染入参复用） */
export type GeneratedContent = Awaited<ReturnType<typeof generateContent>>;

export interface RenderInput extends GeneratedContent {
  /** 模板（单页流程由用户选择：scene_word 情景背词 / word_card 单词卡片） */
  template: "scene_word" | "word_card" | "quiz";
  audio: { url: string; duration: number; format: string };
}

/** 渲染入参（宽松版：详情页从任务记录组装，关键字段由 isRenderInput 守卫，后端 zod 兜底） */
export type RenderVideoInput = {
  template: "scene_word" | "word_card" | "quiz";
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
    keyword?: string;
    /** 视频资产过滤（PRD 10.1.5）：仅返回已有成片的记录 */
    hasVideo?: "true" | "false";
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
    content?: Record<string, unknown>[];
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

/** 批量删除生成记录（审计管理批量操作） */
export async function batchDeleteTasks(ids: string[]) {
  const { data, error, response } = await client.POST("/api/tasks/batch-delete", {
    body: { ids },
  });
  if (error || !response.ok) throw new Error(`批量删除失败（HTTP ${response.status}）`);
  return data;
}

/** 上传文件列表（audio=配音 / video=成片 / bgm=素材，含是否被记录引用） */
export async function listFiles(params: { type?: "audio" | "video" | "bgm" } = {}) {
  const { data, error, response } = await client.GET("/api/files", { params: { query: params } });
  if (error || !response.ok) throw new Error(`查询文件失败（HTTP ${response.status}）`);
  if (!data) throw new Error("查询文件失败：空响应");
  return data;
}

/** 删除上传文件（type 指定分类目录；被记录引用的文件删除后记录中不可播放） */
export async function deleteFile(filename: string, type: "audio" | "video" | "bgm") {
  const { data, error, response } = await client.DELETE("/api/files/{filename}", {
    params: { path: { filename }, query: { type } },
  });
  if (error || !response.ok) throw new Error(`删除文件失败（HTTP ${response.status}）`);
  return data;
}

/** 批量删除文件（文件管理批量处理；不存在的文件幂等跳过） */
export async function batchDeleteFiles(
  items: { filename: string; type: "audio" | "video" | "bgm" }[],
) {
  const { data, error, response } = await client.POST("/api/files/batch-delete", {
    body: { items },
  });
  if (error || !response.ok) throw new Error(`批量删除失败（HTTP ${response.status}）`);
  if (!data) throw new Error("批量删除失败：空响应");
  return data;
}
