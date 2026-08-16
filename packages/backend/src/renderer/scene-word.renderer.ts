/**
 * scene_word（情景背词）模板渲染器
 * 依据：docs/10 §4.2 + 《情景词汇阅读视频模板设计规范 V1.0》
 * 每 segment 一帧；帧时长按文本字符权重分配
 */
import type { ContentDTO, SceneWordSegment } from "@ai-english/shared";
import { allocateDurations } from "./allocate-durations";
import { isSceneWord } from "./guards";
import { escapeHtml, escapeRegExp, fillTemplate, loadTemplate } from "./html";
import { screenshotHtmls } from "./playwright";
import type { RenderResult, TemplateRenderer } from "./renderer.interface";

/** 将文本中的四六级词汇高亮为 <mark>（词边界正则，全部出现；wordIndex 定位留作升级路径） */
export function highlightWords(text: string, words: SceneWordSegment["words"]): string {
  let html = escapeHtml(text);
  for (const w of words) {
    const pattern = new RegExp(`\\b${escapeRegExp(w.word)}\\b`, "gi");
    html = html.replace(pattern, (match) => `<mark>${match}</mark>`);
  }
  return html;
}

export class SceneWordRenderer implements TemplateRenderer {
  async render(dto: ContentDTO, workDir: string): Promise<RenderResult> {
    if (!isSceneWord(dto)) {
      throw new Error("SceneWordRenderer 收到非 scene_word 模板内容");
    }
    const { audio } = dto;
    if (!audio) {
      throw new Error("ContentDTO 缺少 audio 字段，无法渲染");
    }
    const segments: SceneWordSegment[] = dto.content;

    const template = await loadTemplate("scene-word.html");
    const htmlList = segments.map((seg) => {
      const wordsBar = seg.words
        .map(
          (w) =>
            `<span class="word">${escapeHtml(w.word)}</span><span>${escapeHtml(w.meaning)}</span>`,
        )
        .join("");
      return fillTemplate(template, {
        TITLE: escapeHtml(dto.title),
        TEXT: highlightWords(seg.text, seg.words),
        WORDS_BAR: wordsBar,
      });
    });

    const paths = await screenshotHtmls(htmlList, workDir);
    const durations = allocateDurations(
      segments.map((s) => s.text.length),
      audio.duration,
    );

    return {
      frames: paths.map((filePath, i) => ({ filePath, duration: durations[i] })),
      totalDuration: audio.duration,
    };
  }
}
