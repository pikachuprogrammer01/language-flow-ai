/**
 * Response DTO（输出层）
 * 依据：docs/04_Content_DTO设计文档.txt §八
 */
import type {
  AudioInfo,
  ContentArray,
  StyleConfig,
  VideoInfo,
  VoiceConfig,
  WordInfo,
} from "./content.dto";
import type { CefrLevel, ContentStatus, TemplateType } from "./enums";

// ── 列表项（列表接口返回，不含大段 content） ──

export interface ContentListItem {
  id: string;
  template: TemplateType;
  title: string;
  level: CefrLevel;
  targetDuration: number;
  /** 词汇总数 */
  wordCount: number;
  status: ContentStatus;
  /** 缩略图地址 */
  thumbnailUrl?: string;
  createdAt: string;
}

// ── 详情（详情接口返回，包含完整 content） ──

export interface ContentDetail extends ContentListItem {
  content: ContentArray;
  words: WordInfo[];
  style: StyleConfig;
  voice: VoiceConfig;
  audio?: AudioInfo;
  video?: VideoInfo;
  updatedAt: string;
}

// ── 分页响应 ──

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
