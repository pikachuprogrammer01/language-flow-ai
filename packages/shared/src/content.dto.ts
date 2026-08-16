/**
 * 核心 ContentDTO 类型定义
 * 依据：SPEC.md §四 + docs/04_Content_DTO设计文档.txt §四~六
 * content 字段使用 discriminated union，以 template 为判别键
 */
import type { CefrLevel, ContentStatus, TemplateType } from "./enums";

// ── 词汇信息 ──

export interface WordInfo {
  /** 英文单词，如 "contract" */
  word: string;
  /** 中文释义，如 "合同" */
  meaning: string;
  /** 四六级等级 */
  level: CefrLevel;
  /** 在 text 中按分词后的词序号（0-based），用于前端高亮定位。scene_word 模板专用 */
  wordIndex?: number;
  /** 词频（来自四六级词库） */
  frequency?: number;
}

// ── 音色配置 ──

export interface VoiceConfig {
  /** 音色 ID，如 "female_01", "male_01" */
  id: string;
  /** 语速倍率，默认 1.0，范围 0.5 ~ 2.0 */
  speed?: number;
}

// ── 视觉样式 ──

export interface StyleConfig {
  /**
   * 背景。当前阶段统一使用纯白背景，固定值 "white"；
   * 后续如需多套视觉，再扩展为预设背景图枚举。
   */
  background: string;
  /** 字体 */
  font?: string;
  /** 配色方案 */
  colorScheme?: string;
  /** 背景音乐曲目 ID，如 "bgm_calm_01"；MVP 不设默认值（静音合成，见 docs/03 模块 9） */
  bgm?: string;
}

// ── 媒体产物 ──

export interface AudioInfo {
  /** 音频文件地址 */
  url: string;
  /** 音频时长（秒） */
  duration: number;
  /** 格式，如 "mp3", "wav" */
  format: string;
}

export interface VideoInfo {
  /** 视频文件地址 */
  url: string;
  /** 视频时长（秒） */
  duration: number;
  /** 分辨率，如 "1080x1920" */
  resolution: string;
  /** 格式，如 "mp4" */
  format: string;
  /** 文件大小（bytes） */
  size?: number;
}

// ── 模板一：情景背词 (scene_word) ──

export interface SceneWordSegment {
  /** 混合中英文的文本片段 */
  text: string;
  /** 这段文本中用到的四六级词汇 */
  words: WordInfo[];
}

// ── 模板二：单词卡片 (word_card) ──

export interface WordCardItem {
  /** 英文单词 */
  word: string;
  /** 词性，如 "n.", "v.", "adj.", "adv." */
  pos: string;
  /** 中文释义 */
  meaning: string;
  /** 例句 */
  example: string;
  /** 例句翻译（可选） */
  exampleMeaning?: string;
  /** 配图地址（可选） */
  imageUrl?: string;
}

// ── 模板三：选择题 (quiz) ──

export interface QuizItem {
  /** 题干，如 "contract 的意思是？" */
  stem: string;
  /** 选项列表 */
  options: string[];
  /** 正确答案索引（0-based） */
  correctIndex: number;
  /** 解析 */
  explanation: string;
  /** 对应的词汇信息 */
  word: WordInfo;
}

// ── 联合类型 ──

export type ContentArray = SceneWordSegment[] | WordCardItem[] | QuizItem[];

// ── 核心 ContentDTO ──

export interface ContentDTO {
  /** 唯一标识，格式 cnt_YYYYMMDD_XXXXXX（6位十六进制） */
  id: string;
  /** 模板类型（discriminator） */
  template: TemplateType;
  /** 视频标题 */
  title: string;
  /** 四六级等级 */
  level: CefrLevel;
  /** 目标时长（秒），即用户期望的视频长度 */
  targetDuration: number;
  /** 核心内容 — 根据 template 采用不同结构 */
  content: ContentArray;
  /** 全视频涉及的四六级词汇汇总（去重后的扁平列表） */
  words: WordInfo[];
  /** 视觉样式 */
  style: StyleConfig;
  /** 音色配置 */
  voice: VoiceConfig;
  /** 音频产物（阶段性填充，TTS 完成后写入） */
  audio?: AudioInfo;
  /** 视频产物（阶段性填充，视频渲染完成后写入） */
  video?: VideoInfo;
  /** 内容状态 */
  status: ContentStatus;
  /** 创建时间（ISO 8601 UTC） */
  createdAt: string;
  /** 最后更新时间（ISO 8601 UTC） */
  updatedAt: string;
}

// ── 类型守卫 ──
// 将 content 按 template 判别键窄化为对应类型

export function isSceneWord(dto: ContentDTO): dto is ContentDTO & { content: SceneWordSegment[] } {
  return dto.template === "scene_word";
}

export function isWordCard(dto: ContentDTO): dto is ContentDTO & { content: WordCardItem[] } {
  return dto.template === "word_card";
}

export function isQuiz(dto: ContentDTO): dto is ContentDTO & { content: QuizItem[] } {
  return dto.template === "quiz";
}
