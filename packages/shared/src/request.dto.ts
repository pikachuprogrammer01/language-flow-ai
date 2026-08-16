/**
 * Request DTO（输入层）
 * 依据：docs/04_Content_DTO设计文档.txt §七
 */
import type { ContentArray, StyleConfig, VoiceConfig, WordInfo } from "./content.dto";
import type { CefrLevel, TemplateType } from "./enums";

// ── 创建视频任务 ──

export interface CreateContentRequest {
  /** 主题，如 "森林探险"（scene_word 模板必填，word_card / quiz 可选，作为 LLM 出题方向） */
  topic?: string;
  /** 模板类型 */
  template: TemplateType;
  /** 四六级等级 */
  level: CefrLevel;
  /** 期望词汇数量，默认 10，范围 3 ~ 15 */
  wordCount?: number;
  /** 目标时长（秒），默认 60 */
  targetDuration?: number;
  /** 音色选择，不传用默认值 */
  voice?: VoiceConfig;
  /** 样式选择，不传用默认值 */
  style?: StyleConfig;
}

// ── 编辑内容（人工审核修改） ──

export interface EditContentRequest {
  title?: string;
  content?: ContentArray;
  words?: WordInfo[];
  voice?: VoiceConfig;
  style?: StyleConfig;
}
