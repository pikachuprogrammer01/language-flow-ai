/** 状态映射工具 — 后端 status 枚举 → 胶囊变体/中文标签（列表与工作台共用） */

export type StatusVariant = "ok" | "run" | "warn" | "bad" | "neutral";

/** 状态字符串 → 胶囊变体 */
export function statusVariant(status: string): StatusVariant {
  if (status === "completed") return "ok";
  if (status === "failed") return "bad";
  if (
    status === "ai_generating" ||
    status === "tts_processing" ||
    status === "video_rendering" ||
    status === "rendering"
  )
    return "run";
  if (status === "content_ready" || status === "audio_ready" || status === "draft") return "warn";
  return "neutral";
}

/** 状态字符串 → 中文标签 */
export const STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  ai_generating: "生成中",
  content_ready: "内容就绪",
  tts_processing: "配音中",
  audio_ready: "配音完成",
  video_rendering: "渲染中",
  completed: "已完成",
  failed: "失败",
};

/** 模板字符串 → 中文标签 */
export const TEMPLATE_LABEL: Record<string, string> = {
  scene_word: "情景背词",
  word_card: "单词卡片",
  quiz: "选择题",
};

/** ISO 时间 → 相对时间（2 分钟前 / 3 小时前 / 昨天 / 具体日期） */
export function relativeTime(iso: string): string {
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return iso;
  const diff = Date.now() - time;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 2 * day) return "昨天";
  return new Date(time).toLocaleDateString("zh-CN");
}
