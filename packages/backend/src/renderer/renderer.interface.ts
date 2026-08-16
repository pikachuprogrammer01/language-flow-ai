/**
 * 模板渲染器接口
 * 依据：docs/10_视频渲染设计文档.md §三
 */
import type { ContentDTO } from "@ai-english/shared";

export interface RenderFrame {
  /** 帧截图文件路径（PNG, 1080×1920） */
  filePath: string;
  /** 该帧在视频中的停留时长（秒），由 allocateDurations 按字符权重分配 */
  duration: number;
}

export interface RenderResult {
  frames: RenderFrame[];
  /** 总时长 = audio.duration（对齐配音，docs/10 §五） */
  totalDuration: number;
}

export interface TemplateRenderer {
  render(dto: ContentDTO, workDir: string): Promise<RenderResult>;
}
