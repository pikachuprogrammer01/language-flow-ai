/**
 * 模板渲染器接口
 * 依据：docs/10_视频渲染设计文档.md §三
 */
import type { ContentDTO, IntroStatus } from "@ai-english/shared";

export interface RenderFrame {
  /** 帧截图文件路径（PNG, 1080×1920） */
  filePath: string;
  /** 该帧在视频中的停留时长（秒），由 allocateDurations 按字符权重分配 */
  duration: number;
}

export interface RenderResult {
  frames: RenderFrame[];
  /** 总画面时长（含可选片头）；对齐合成后音视频 */
  totalDuration: number;
  /** 提示音时间点（秒）：在这些时刻插入短促音频提示（如 quiz 答案帧起点） */
  beepTimes?: number[];
  /** 片头时长（秒）：>0 时合成前对 TTS 垫等长静音 */
  introPadSec?: number;
  /** 片头渲染结果（scene_word 输出事实，供落库留痕 D5） */
  introStatus?: IntroStatus;
}

export interface TemplateRenderer {
  /** extra：渲染器扩展参数（quiz 音画对齐时传每题朗读时长） */
  render(
    dto: ContentDTO,
    workDir: string,
    extra?: { itemDurations?: number[] },
  ): Promise<RenderResult>;
}
