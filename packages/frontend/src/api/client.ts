/**
 * API 客户端 — openapi-fetch（类型安全，schema.d.ts 由 openapi.json 自动生成）
 * 用法：pnpm gen-api 重新生成（后端启动时 openapi.json 已刷新）
 */
import createClient from "openapi-fetch";
import type { paths } from "./schema.d.ts";

/**
 * 网络层翻译（审查批次 4B）：后端未启动/断网时原生 fetch 抛 `TypeError: Failed to fetch`，
 * 视图层直接上屏就是把底层错误丢给用户；统一转成人话，用户中断（AbortError）原样透传。
 */
async function humanizedFetch(request: Request): Promise<Response> {
  try {
    return await fetch(request);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new Error("无法连接后端服务：请确认 pnpm dev 或 Docker 测试栈正在运行后重试");
  }
}

export const client = createClient<paths>({
  baseUrl: import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080",
  fetch: humanizedFetch,
});

/** 提取 API 错误信息：优先后端返回的 {error} 字段，fallback HTTP 状态码 */
function apiError(error: { error?: unknown } | undefined, response: Response): string {
  if (error && typeof error.error === "string") return error.error;
  return `HTTP ${response.status}`;
}

/** 用户主动中断（AbortController.abort）产生的错误：不是失败，调用方应区别处理 */
export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/** 长耗时请求的可选控制项（停止按钮用 signal 中断在飞请求） */
export interface RequestOpts {
  signal?: AbortSignal;
}

export interface GenerateInput {
  topic: string;
  level: "CET4" | "CET6";
  /** 模板选择（MVP 需求 #1）：scene_word 情景背词 / word_card 单词卡片 */
  template?: "scene_word" | "word_card" | "quiz";
  wordCount?: number;
  targetDuration?: number;
}

/** 生成内容（ContentDTO） */
export async function generateContent(input: GenerateInput, opts?: RequestOpts) {
  const { data, error, response } = await client.POST("/api/content/generate", {
    body: input,
    signal: opts?.signal,
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
  opts?: RequestOpts,
) {
  const { data, error, response } = await client.POST("/api/tts/from-content", {
    body: { template, content, title, voice, rate },
    signal: opts?.signal,
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

/** 音色试听：指定音色合成文本并返回音频 URL（PRD §10.1.1）；服务端失败原因原文透出 */
export async function previewVoice(voice: string, text: string) {
  const { data, error, response } = await client.POST("/api/tts/generate", {
    body: { text, voice },
  });
  if (error || !response.ok || !data) {
    const detail = (error as { error?: string } | null)?.error;
    throw new Error(detail ?? `试听合成失败（HTTP ${response.status}）`);
  }
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
export async function renderVideo(dto: RenderInput | RenderVideoInput, opts?: RequestOpts) {
  const { data, error, response } = await client.POST("/api/video/render", {
    // openapi-fetch body 类型为 schema 推断的完整 DTO；详情页记录为宽松 Record，运行时由后端 zod 校验兜底
    body: dto as never,
    signal: opts?.signal,
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

export type VideoAnalytics = {
  contentId: string;
  template: "scene_word" | "word_card" | "quiz";
  targetDuration: number;
  duration: number | null;
  storyTopic: string | null;
  publishAt: string | null;
  coverUrl: string | null;
  voice: string | null;
  bgm: string | null;
  allowSave: boolean;
  customParams: Array<{ key: string; label: string; type: "text" | "image"; value: string }> | null;
};

export async function getVideoAnalytics(contentId: string): Promise<VideoAnalytics> {
  const { data, error, response } = await client.GET("/api/video-analytics/{contentId}", {
    params: { path: { contentId } },
  });
  if (error || !response.ok || !data)
    throw new Error(`查询视频分析失败（HTTP ${response.status}）`);
  return data;
}

export async function getVideoAnalyticsBatch(contentIds: string[]): Promise<VideoAnalytics[]> {
  const { data, error, response } = await client.GET("/api/video-analytics", {
    params: { query: { ids: contentIds.join(",") } },
  });
  if (error || !response.ok || !data)
    throw new Error(`批量查询视频分析失败（HTTP ${response.status}）`);
  return data;
}

export async function updateVideoAnalytics(
  contentId: string,
  body: {
    storyTopic?: string | null;
    publishAt?: string | null;
    coverUrl?: string | null;
    allowSave?: boolean;
    voice?: string;
    bgm?: string | null;
    customParams?: NonNullable<VideoAnalytics["customParams"]> | null;
  },
): Promise<VideoAnalytics> {
  const { data, error, response } = await client.PATCH("/api/video-analytics/{contentId}", {
    params: { path: { contentId } },
    body,
  });
  if (error || !response.ok || !data)
    throw new Error(`保存视频分析失败（HTTP ${response.status}）`);
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

export async function updateRenderSettings(
  id: string,
  body: { introEffect: boolean },
): Promise<{ introEffect: boolean }> {
  const { data, error, response } = await client.PATCH("/api/tasks/{id}/render-settings", {
    params: { path: { id } },
    body,
  });
  if (error || !response.ok || !data)
    throw new Error(`更新渲染设置失败（HTTP ${response.status}）`);
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

/**
 * 批量删除文件（文件管理批量处理；不存在的文件幂等跳过）
 * 默认开启引用安全网：被生成记录引用的文件会被服务端跳过（响应 skipped）；
 * 手动批量删除已逐项确认时传 force: true 强制删除
 */
export async function batchDeleteFiles(
  items: { filename: string; type: "audio" | "video" | "bgm" }[],
  opts?: { force?: boolean },
) {
  const { data, error, response } = await client.POST("/api/files/batch-delete", {
    body: { items, force: opts?.force },
  });
  if (error || !response.ok) throw new Error(`批量删除失败（HTTP ${response.status}）`);
  if (!data) throw new Error("批量删除失败：空响应");
  return data;
}

/**
 * 在 Finder 中显示视频（宿主机桥）
 * 后端把宿主机路径写入 .open-requests/ 标记文件，宿主机 launchd 脚本收到后 open -R 定位；
 * 后端同步等待消费确认，watcher 未运行时返回 503（错误原文透出，不假成功）。
 */
export async function revealVideoInFinder(url: string) {
  const { data, error, response } = await client.POST("/api/files/reveal", { body: { url } });
  if (!response.ok) {
    const detail = (error as { error?: string } | null)?.error;
    throw new Error(detail ?? `打开目录失败（HTTP ${response.status}）`);
  }
  if (!data) throw new Error("打开目录失败：空响应");
  return data;
}

/** 上传标记（表示视频已上传到外部平台；taskId 关联任务，重渲染后标记仍按任务归属） */
export interface UploadMark {
  id: string;
  taskId: string | null;
  videoFilename: string;
  platform: string;
  url: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 一览页标记（含后端关联的视频摘要） */
export interface UploadMarkOverview extends UploadMark {
  video: {
    title: string;
    template: "scene_word" | "word_card" | "quiz";
    level: "CET4" | "CET6";
    wordsCount: number;
    duration: number | null;
  } | null;
}

/** 上传标记列表（可选按视频文件名过滤） */
export async function listUploadMarks(videoFilename?: string) {
  const { data, error, response } = await client.GET("/api/upload-marks", {
    params: { query: videoFilename ? { videoFilename } : {} },
  });
  if (error || !response.ok) throw new Error(`查询上传标记失败：${apiError(error, response)}`);
  if (!data) throw new Error("查询上传标记失败：空响应");
  return data.marks as UploadMark[];
}

/** 上传标记一览（关联视频信息；支持 platform / keyword） */
export async function listUploadMarksOverview(
  params: { platform?: string; keyword?: string } = {},
) {
  const { data, error, response } = await client.GET("/api/upload-marks/overview", {
    params: { query: params },
  });
  if (error || !response.ok) throw new Error(`查询上传标记一览失败：${apiError(error, response)}`);
  if (!data) throw new Error("查询上传标记一览失败：空响应");
  return data as { marks: UploadMarkOverview[]; platforms: string[] };
}

/** 新增上传标记（videoFilename + platform 必填，url/note/taskId 可选） */
export async function addUploadMark(input: {
  videoFilename: string;
  platform: string;
  url?: string;
  note?: string;
  taskId?: string;
}) {
  const { data, error, response } = await client.POST("/api/upload-marks", { body: input });
  if (error || !response.ok) throw new Error(`新增上传标记失败：${apiError(error, response)}`);
  if (!data) throw new Error("新增上传标记失败：空响应");
  return data as UploadMark;
}

/** 更新上传标记（url/note 传 null 表示清空） */
export async function updateUploadMark(
  id: string,
  input: { platform?: string; url?: string | null; note?: string | null },
) {
  const { data, error, response } = await client.PATCH("/api/upload-marks/{id}", {
    params: { path: { id } },
    body: input,
  });
  if (error || !response.ok) throw new Error(`更新上传标记失败：${apiError(error, response)}`);
  if (!data) throw new Error("更新上传标记失败：空响应");
  return data;
}

/** 删除上传标记 */
export async function deleteUploadMark(id: string) {
  const { data, error, response } = await client.DELETE("/api/upload-marks/{id}", {
    params: { path: { id } },
  });
  if (error || !response.ok) throw new Error(`删除上传标记失败：${apiError(error, response)}`);
  if (!data) throw new Error("删除上传标记失败：空响应");
  return data;
}

// ── 视频数据分析（docs/17，Phase 1 数据链路 + Phase 2 看板） ──

/** 带来源的指标单元格（需求 §六：无数据 ≠ 0，缺键即无数据，不伪造 0 值） */
export interface MetricCellView {
  value: number;
  sourceType: string;
  isEstimated: boolean;
  dataDate: string | null;
}

/** 逐级转化可比性（与后端 StepRateState 同源）：仅 computed 时 stepRate 非空 */
export type FunnelStepRateState =
  | "first"
  | "computed"
  | "coverage-mismatch"
  | "inverted"
  | "missing"
  | "standalone";

export interface FunnelStageView {
  key: string;
  label: string;
  kind: "count" | "rate" | "creator";
  value: number | null;
  previousValue: number | null;
  stepRate: number | null;
  stepRateState: FunnelStepRateState;
  shareOfPlays: number | null;
  /** video 阶段=参与折算记录数；creator 阶段=窗口内参与折算的账号日行数 */
  coverageCount: number;
  /** 窗口内发布记录总数（覆盖率分母） */
  windowRecordCount: number;
  /** 本阶段覆盖记录的播放量合计（占比/折算分母）；creator 阶段 null */
  basisPlays: number | null;
  changePct: number | null;
  sourceTypes: string[];
  emptyReason: string | null;
  note?: string;
}

export interface AnalyticsOverview {
  days: number;
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
  publishedVideos: number;
  previousPublishedVideos: number;
  stages: FunnelStageView[];
  emptyReason: string | null;
}

export async function getAnalyticsOverview(days = 7): Promise<AnalyticsOverview> {
  const { data, error, response } = await client.GET("/api/analytics/overview", {
    params: { query: { days } },
  });
  if (error || !data) throw new Error(`查询分析概览失败：${apiError(error, response)}`);
  return data as AnalyticsOverview;
}

export type InsightSort = "play" | "completion" | "engagement" | "fans" | "publish_time";

export interface AnalyticsVideoRow {
  recordId: string;
  contentId: string;
  platform: string;
  platformVideoId: string | null;
  title: string;
  template: "scene_word" | "word_card" | "quiz";
  level: "CET4" | "CET6";
  durationSec: number | null;
  publishTime: string | null;
  metrics: Record<string, MetricCellView>;
}

export async function listAnalyticsVideos(
  params: { sort?: InsightSort; order?: "asc" | "desc"; page?: number; pageSize?: number } = {},
): Promise<{ items: AnalyticsVideoRow[]; total: number; page: number; pageSize: number }> {
  const { data, error, response } = await client.GET("/api/analytics/videos", {
    params: { query: params },
  });
  if (error || !data) throw new Error(`查询视频表现列表失败：${apiError(error, response)}`);
  return data as { items: AnalyticsVideoRow[]; total: number; page: number; pageSize: number };
}

export interface AnalyticsBenchmark {
  subject: {
    contentId: string;
    group: {
      template: string;
      scene: string | null;
      contentFormat: string | null;
      durationBand: string | null;
    };
  };
  sampleCount: number;
  lowSample: boolean;
  metrics: Record<
    string,
    {
      self: MetricCellView | null;
      groupMedian: number | null;
      groupMean: number | null;
      diff: number | null;
      sampleCount: number;
    }
  >;
  emptyReason: string | null;
}

export async function getAnalyticsBenchmark(contentId: string): Promise<AnalyticsBenchmark> {
  const { data, error, response } = await client.GET(
    "/api/analytics/videos/{contentId}/benchmark",
    {
      params: { path: { contentId } },
    },
  );
  if (error || !data) throw new Error(`查询同类基准失败：${apiError(error, response)}`);
  return data as AnalyticsBenchmark;
}

export interface AnalyticsTrendRecord {
  recordId: string;
  platform: string;
  series: { metricName: string; points: { date: string; value: number; sourceType: string }[] }[];
}

export async function getAnalyticsTrend(
  contentId: string,
  params: { dateFrom?: string; dateTo?: string } = {},
): Promise<AnalyticsTrendRecord[]> {
  const { data, error, response } = await client.GET("/api/analytics/videos/{contentId}/trend", {
    params: { path: { contentId }, query: params },
  });
  if (error || !data) throw new Error(`查询趋势失败：${apiError(error, response)}`);
  return (data as { records: AnalyticsTrendRecord[] }).records;
}

export interface AnalyticsFeature {
  contentId: string;
  template: "scene_word" | "word_card" | "quiz";
  level: "CET4" | "CET6";
  duration: number | null;
  knowledgePointCount: number | null;
  characterCount: number | null;
  dialogueCount: number | null;
  segmentCount: number | null;
  speechRate: number | null;
  voiceId: string | null;
  bgm: string | null;
  subtitleType: string | null;
  shotCount: number | null;
  introEffect: number | null;
  introTopic: string | null;
  promptVersion: string | null;
  rendererVersion: string | null;
  scene: string | null;
  hook: string | null;
  contentFormat: string | null;
  emotion: string | null;
  ctaType: string | null;
  ctaStartTime: number | null;
  fieldSources: Record<string, string> | null;
}

/** 内容特征（只读；未落库返回 null，可先 POST /api/analytics/features/:id/sync 重算） */
export async function getAnalyticsFeature(contentId: string): Promise<AnalyticsFeature | null> {
  const { data, error, response } = await client.GET("/api/analytics/features/{contentId}", {
    params: { path: { contentId } },
  });
  if (response.status === 404) return null;
  if (error || !response.ok) throw new Error(`查询内容特征失败：${apiError(error, response)}`);
  return (data ?? null) as AnalyticsFeature | null;
}

/** 人工标签覆盖（scene/hook 等，后端 taxonomy 校验失败抛 400 原文） */
export async function patchAnalyticsFeature(
  contentId: string,
  patch: {
    scene?: string | null;
    hook?: string | null;
    contentFormat?: string | null;
    emotion?: string | null;
    ctaType?: string | null;
    ctaStartTime?: number | null;
  },
): Promise<AnalyticsFeature> {
  const { data, error, response } = await client.PATCH("/api/analytics/features/{contentId}", {
    params: { path: { contentId } },
    body: patch,
  });
  if (error || !data) {
    const detail =
      typeof error === "object" && error !== null && "error" in error
        ? (error as { error?: { message?: string } }).error?.message
        : undefined;
    throw new Error(detail ?? `保存标签失败（HTTP ${response.status}）`);
  }
  return data as AnalyticsFeature;
}

/** 因子分析（Phase 3 页面 D）：分组统计非因果，每组必携样本数 */
export type FactorMetricName =
  | "play_count"
  | "effective_play_rate_2s"
  | "watch_rate_5s"
  | "completion_rate"
  | "avg_watch_ratio"
  | "like_rate"
  | "comment_rate"
  | "share_rate"
  | "engagement_rate"
  | "profile_visit_rate";

export interface FactorGroup {
  value: string;
  sampleCount: number;
  median: number | null;
  mean: number | null;
  diff: number | null;
  lowSample: boolean;
}
export interface FactorAnalysis {
  metric: string;
  accountMedian: number | null;
  accountSampleCount: number;
  dimensions: { dimension: string; groups: FactorGroup[] }[];
  note: string;
  computedAt: string;
}

export async function getAnalyticsFactors(params: {
  metric?: FactorMetricName;
  dimensions?: string[];
}): Promise<FactorAnalysis> {
  const { data, error, response } = await client.GET("/api/analytics/factors", {
    params: {
      query: {
        metric: params.metric,
        dimensions: params.dimensions?.length ? params.dimensions.join(",") : undefined,
      },
    },
  });
  if (error || !data) throw new Error(`因子分析失败：${apiError(error, response)}`);
  return data as FactorAnalysis;
}

/** 因子维度白名单（与后端 FACTOR_DIMENSIONS 同源；schema 内联联合的具名别） */
export type FactorDimensionName =
  | "hook"
  | "scene"
  | "contentFormat"
  | "emotion"
  | "ctaType"
  | "template"
  | "level"
  | "durationBand"
  | "speechRateBand"
  | "segmentCountBand"
  | "voice"
  | "bgm"
  | "subtitleType"
  | "promptVersion"
  | "publishHourBand";

/** 显式重算并留档（批次 5B：GET 纯读，只有这里写 analysis_result 快照） */
export async function recomputeAnalyticsFactors(input: {
  metric?: FactorMetricName;
  dimensions?: FactorDimensionName[];
}): Promise<FactorAnalysis> {
  const { data, error, response } = await client.POST("/api/analytics/factors", {
    body: { metric: input.metric, dimensions: input.dimensions },
  });
  if (error || !data) throw new Error(`因子重算失败：${apiError(error, response)}`);
  return data as FactorAnalysis;
}

/** 内容段落时间轴（生产口径派生） */
export interface TimelineSegment {
  idx: number;
  startTime: number;
  endTime: number;
  segmentType: string;
  dialogue: string | null;
  knowledgePoint: string | null;
  scene: string | null;
  emotion: string | null;
  shotType: string | null;
  sourceType: string;
}

export async function getAnalyticsTimeline(
  contentId: string,
): Promise<{ segments: TimelineSegment[]; emptyReason: string | null }> {
  const { data, error, response } = await client.GET("/api/analytics/videos/{contentId}/timeline", {
    params: { path: { contentId } },
  });
  if (error || !data) throw new Error(`查询时间轴失败：${apiError(error, response)}`);
  return data as { segments: TimelineSegment[]; emptyReason: string | null };
}

/** 重算生产特征（一并重建段落时间轴） */
export async function syncAnalyticsFeature(contentId: string): Promise<AnalyticsFeature> {
  const { data, error, response } = await client.POST("/api/analytics/features/{contentId}/sync", {
    params: { path: { contentId } },
  });
  if (error || !data) throw new Error(`特征重算失败：${apiError(error, response)}`);
  return data as AnalyticsFeature;
}

// ── 生产建议与结构复用（Phase 4 优化闭环） ──

export interface RecommendationView {
  id: string;
  recommendationType: string;
  recommendation: { value: string; label: string; kindLabel: string };
  reason: string;
  sourceSampleCount: number;
  sourceMetric: string;
  confidence: number | null;
  accepted: boolean | null;
  appliedToContentId: string | null;
  createdAt: string;
}

export async function listAnalyticsRecommendations(): Promise<{
  items: RecommendationView[];
  summary: { total: number; pending: number; accepted: number; rejected: number; applied: number };
}> {
  const { data, error, response } = await client.GET("/api/analytics/recommendations");
  if (error || !data) throw new Error(`查询生产建议失败：${apiError(error, response)}`);
  return data as never;
}

export async function generateAnalyticsRecommendations(): Promise<{ created: number }> {
  const { data, error, response } = await client.POST("/api/analytics/recommendations/generate");
  if (error || !data) throw new Error(`生成生产建议失败：${apiError(error, response)}`);
  return data as { created: number };
}

export async function decideAnalyticsRecommendation(
  id: string,
  decision: { accepted: boolean; appliedToContentId?: string | null },
): Promise<RecommendationView> {
  const { data, error, response } = await client.PATCH(
    "/api/analytics/recommendations/{recommendationId}",
    { params: { path: { recommendationId: id } }, body: decision },
  );
  if (error || !data) throw new Error(`建议决策失败：${apiError(error, response)}`);
  return data as RecommendationView;
}

export interface VideoStructure {
  skeleton: {
    idx: number;
    segmentType: string;
    label: string;
    startTime: number;
    endTime: number;
    durationShare: number;
    knowledgePoint: string | null;
  }[];
  totalDuration: number | null;
  emptyReason: string | null;
}

export async function getAnalyticsVideoStructure(contentId: string): Promise<VideoStructure> {
  const { data, error, response } = await client.GET(
    "/api/analytics/videos/{contentId}/structure",
    {
      params: { path: { contentId } },
    },
  );
  if (error || !data) throw new Error(`查询可复用结构失败：${apiError(error, response)}`);
  return data as VideoStructure;
}

// ── 内容实验（Phase 6 A/B 描述统计） ──

export interface ExperimentEvaluationView {
  targetMetric: string;
  medianA: number | null;
  medianB: number | null;
  diff: number | null;
  sampleA: number;
  sampleB: number;
  lowSample: boolean;
  verdict: string;
  note: string;
  modelVersion: string;
  evaluatedAt: string;
}

export interface ExperimentView {
  id: string;
  variable: string;
  variantA: { label: string; contentIds: string[] };
  variantB: { label: string; contentIds: string[] };
  controlVariables: unknown;
  targetMetric: string;
  startAt: string | null;
  endAt: string | null;
  status: string;
  result: ExperimentEvaluationView | null;
  createdAt: string;
  updatedAt: string;
}

export async function listAnalyticsExperiments(): Promise<ExperimentView[]> {
  const { data, error, response } = await client.GET("/api/analytics/experiments");
  if (error || !data) throw new Error(`查询内容实验失败：${apiError(error, response)}`);
  return (data as { items: unknown[] }).items as ExperimentView[];
}

export async function createAnalyticsExperiment(input: {
  variable: string;
  variantA: { label: string; contentIds: string[] };
  variantB: { label: string; contentIds: string[] };
  controlVariables?: Record<string, string>;
  targetMetric?: string;
}): Promise<ExperimentView> {
  const { data, error, response } = await client.POST("/api/analytics/experiments", {
    body: input,
  });
  if (error || !data) {
    const detail =
      typeof error === "object" && error !== null && "error" in error
        ? (error as { error?: { message?: string } }).error?.message
        : undefined;
    throw new Error(detail ?? `创建实验失败（HTTP ${response.status}）`);
  }
  return data as ExperimentView;
}

export async function evaluateAnalyticsExperiment(id: string): Promise<ExperimentView> {
  const { data, error, response } = await client.POST(
    "/api/analytics/experiments/{experimentId}/evaluate",
    { params: { path: { experimentId: id } } },
  );
  if (error || !data) throw new Error(`实验评估失败：${apiError(error, response)}`);
  return data as ExperimentView;
}

export async function updateAnalyticsExperimentStatus(
  id: string,
  status: "draft" | "running" | "cancelled",
): Promise<ExperimentView> {
  const { data, error, response } = await client.PATCH(
    "/api/analytics/experiments/{experimentId}/status",
    { params: { path: { experimentId: id } }, body: { status } },
  );
  if (error || !data) throw new Error(`实验状态更新失败：${apiError(error, response)}`);
  return data as ExperimentView;
}

/** 单视频指标视图（Phase 1 端点形状：完整 provenance + 目录元信息） */
export interface VideoMetricView {
  metricName: string;
  label: string;
  unit: string;
  availability: string;
  metricValue: number;
  sourceType: string;
  sourceField: string | null;
  dataDate: string | null;
  isEstimated: boolean;
  confidence: number | null;
  fetchedAt: string;
}

/** 单视频指标（最新值 + 每日快照，emptyReason 表达无数据原因） */
export interface AnalyticsVideoMetrics {
  records: {
    recordId: string;
    platform: string;
    platformVideoId: string | null;
    publishTime: string | null;
    latest: VideoMetricView[];
    daily: VideoMetricView[];
  }[];
  emptyReason: string | null;
}

export async function getAnalyticsVideoMetrics(contentId: string): Promise<AnalyticsVideoMetrics> {
  const { data, error, response } = await client.GET("/api/analytics/videos/{contentId}/metrics", {
    params: { path: { contentId } },
  });
  if (error || !data) throw new Error(`查询视频指标失败：${apiError(error, response)}`);
  return data as AnalyticsVideoMetrics;
}

// ── 数据接入：发布记录 + Creator Import + 指标目录（抖音官方 API 通道已砍除，导入即唯一入口） ──

/** 发布记录视图（统一 ID 链路：platform + platform_video_id 全局唯一） */
export interface PublishRecordView {
  id: string;
  contentId: string;
  contentTitle: string;
  template: "scene_word" | "word_card" | "quiz";
  videoAssetId: string | null;
  platform: string;
  platformVideoId: string | null;
  publishTitle: string | null;
  publishTime: string | null;
  coverUrl: string | null;
  publishStatus: "scheduled" | "published" | "deleted";
  createdAt: string;
  updatedAt: string;
}

export async function listAnalyticsPublishRecords(
  params: { platform?: string; contentId?: string; page?: number; pageSize?: number } = {},
): Promise<{ items: PublishRecordView[]; total: number }> {
  const { data, error, response } = await client.GET("/api/analytics/publish-records", {
    params: { query: { pageSize: 100, ...params } },
  });
  if (error || !data) throw new Error(`查询发布记录失败：${apiError(error, response)}`);
  return { items: data.items as PublishRecordView[], total: data.total };
}

export interface PublishRecordInput {
  contentId: string;
  platform: string;
  platformVideoId?: string | null;
  publishTitle?: string | null;
  /** ISO datetime 字符串（后端 z.string().datetime() 契约） */
  publishTime?: string | null;
  coverUrl?: string | null;
  publishStatus?: "scheduled" | "published" | "deleted";
}

export async function createAnalyticsPublishRecord(
  input: PublishRecordInput,
): Promise<{ id: string }> {
  const { data, error, response } = await client.POST("/api/analytics/publish-records", {
    // 平台固定为抖音（当前唯一发布渠道），字段保留扩展性
    body: { ...input, publishStatus: input.publishStatus ?? "published" },
  });
  if (response.status === 409) throw new Error("该平台作品 ID 已有发布记录（禁止重复绑定）");
  if (error || !data) throw new Error(`创建发布记录失败：${apiError(error, response)}`);
  return data;
}

export async function updateAnalyticsPublishRecord(
  recordId: string,
  input: Partial<Omit<PublishRecordInput, "contentId">>,
): Promise<void> {
  const { error, response } = await client.PATCH("/api/analytics/publish-records/{recordId}", {
    params: { path: { recordId } },
    body: input,
  });
  if (response.status === 409) throw new Error("该平台作品 ID 已有发布记录（禁止重复绑定）");
  if (error || !response.ok) throw new Error(`更新发布记录失败：${apiError(error, response)}`);
}

export async function deleteAnalyticsPublishRecord(recordId: string): Promise<void> {
  const { error, response } = await client.DELETE("/api/analytics/publish-records/{recordId}", {
    params: { path: { recordId } },
  });
  if (error || !response.ok) throw new Error(`删除发布记录失败：${apiError(error, response)}`);
}

/** canonical 指标目录（前端动态渲染映射选项，不写死字段名） */
export interface MetricCatalogEntry {
  name: string;
  label: string;
  unit: string;
  availability: string;
  formula?: string;
  importable: boolean;
  note?: string;
}

/** 账号日聚合字段目录项（creator_metric_daily 列白名单，账号级口径） */
export interface CreatorDailyFieldEntry {
  name: string;
  label: string;
  unit: string;
  note?: string;
}

export async function getAnalyticsMetricCatalog(): Promise<{
  metrics: MetricCatalogEntry[];
  creatorDailyFields: CreatorDailyFieldEntry[];
  sourceTypes: string[];
}> {
  const { data, error, response } = await client.GET("/api/analytics/metric-catalog");
  if (error || !data) throw new Error(`查询指标目录失败：${apiError(error, response)}`);
  return data as {
    metrics: MetricCatalogEntry[];
    creatorDailyFields: CreatorDailyFieldEntry[];
    sourceTypes: string[];
  };
}

/** 导入行匹配键（优先级：recordId > platformVideoId > platform+contentId；禁标题模糊匹配） */
export interface ImportRowMatch {
  recordId?: string;
  platformVideoId?: string;
  platform?: string;
  contentId?: string;
}

export interface ImportRowInput {
  match: ImportRowMatch;
  values: Record<string, number | string | null>;
  dataDate?: string;
}

export interface ImportRowResult {
  row: number;
  ok: boolean;
  recordId: string | null;
  written: string[];
  skipped: { field: string; reason: string }[];
  derived: string[];
  error?: string;
}

export async function importAnalyticsMetrics(input: {
  sourceType?: "CREATOR_IMPORT" | "USER_INPUT";
  metricMapping: Record<string, string>;
  dataDate?: string;
  rows: ImportRowInput[];
}): Promise<{
  results: ImportRowResult[];
  summary: { total: number; succeeded: number; failed: number; batchId: string };
}> {
  const { data, error, response } = await client.POST("/api/analytics/import", {
    body: input,
  });
  if (error || !data) throw new Error(`导入失败：${apiError(error, response)}`);
  return data as {
    results: ImportRowResult[];
    summary: { total: number; succeeded: number; failed: number; batchId: string };
  };
}

// ── 账号日汇总批量导入（导入向导：逐行归属裁决） ──

export interface CreatorDailyImportRowInput {
  statDate: string;
  values: Record<string, number | string | null>;
  attribution: { mode: "account" } | { mode: "video"; recordId: string };
}

export interface CreatorDailyImportRowResult {
  row: number;
  ok: boolean;
  statDate: string;
  dailyWritten: string[];
  videoRecordId: string | null;
  videoWritten: string[];
  videoDerived: string[];
  skipped: { field: string; reason: string }[];
  error?: string;
}

export async function importAnalyticsCreatorDaily(input: {
  platform: string;
  sourceType?: "CREATOR_IMPORT" | "USER_INPUT";
  fieldMapping: Record<string, string>;
  rows: CreatorDailyImportRowInput[];
}): Promise<{
  results: CreatorDailyImportRowResult[];
  summary: { total: number; succeeded: number; failed: number; batchId: string };
}> {
  const { data, error, response } = await client.POST("/api/analytics/creator-daily/import", {
    body: input,
  });
  if (error || !data) throw new Error(`账号日导入失败：${apiError(error, response)}`);
  return data as {
    results: CreatorDailyImportRowResult[];
    summary: { total: number; succeeded: number; failed: number; batchId: string };
  };
}
