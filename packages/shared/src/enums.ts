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

// ── 片头渲染结果状态（scene_word 专属，随渲染产物写入 contents.video，是输出事实而非输入配置） ──
// rendered: 片头已生成 · failed: 生成失败已跳过 · disabled: 用户关闭 · unknown: 旧记录无此字段
// 注：本包为纯源码共享类型包，运行时不导出值（tsx 无法解析裸包命名值导出）；
// 需运行时元组见 backend/src/lib/intro-status.ts。

export type IntroStatus = "rendered" | "failed" | "disabled" | "unknown";
