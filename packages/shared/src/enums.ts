/**
 * 枚举与字面量类型定义
 * 依据：SPEC.md §三 + docs/04_Content_DTO设计文档.txt §三
 * 枚举值统一 snake_case 字符串，可直接入库与日志阅读
 */

// ── 模板类型 ──

export type TemplateType = "scene_word" | "word_card" | "quiz";

export const TemplateTypeEnum = {
  SCENE_WORD: "scene_word",
  WORD_CARD: "word_card",
  QUIZ: "quiz",
} as const satisfies Record<string, TemplateType>;

// ── 内容状态 ──
// 状态流转（MVP）：
// draft → ai_generating → content_ready → tts_processing → audio_ready → video_rendering → completed
//   ↓          ↓               ↓               ↓               ↓              ↓
// failed     failed          failed          failed          failed         failed
// failed 为终态，不允许恢复

export type ContentStatus =
  | "draft"
  | "ai_generating"
  | "content_ready"
  | "tts_processing"
  | "audio_ready"
  | "video_rendering"
  | "completed"
  | "failed";

// ── 四六级等级 ──

export type CefrLevel = "CET4" | "CET6";
