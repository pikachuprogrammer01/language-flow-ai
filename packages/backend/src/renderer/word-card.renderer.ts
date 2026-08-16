/**
 * word_card（单词卡片）模板渲染器
 * 依据：docs/10 §4.3 + 《四级词汇情景记忆卡片设计方案》（仅文字排版规格，背景纯白）
 * 每张卡一帧；帧时长按「单词+释义+例句」字符权重分配
 */
import type { ContentDTO, WordCardItem } from "@ai-english/shared";
import { allocateDurations } from "./allocate-durations";
import { isWordCard } from "./guards";
import { escapeHtml, fillTemplate, loadTemplate } from "./html";
import { screenshotHtmls } from "./playwright";
import type { RenderResult, TemplateRenderer } from "./renderer.interface";

export class WordCardRenderer implements TemplateRenderer {
  async render(dto: ContentDTO, workDir: string): Promise<RenderResult> {
    if (!isWordCard(dto)) {
      throw new Error("WordCardRenderer 收到非 word_card 模板内容");
    }
    const { audio } = dto;
    if (!audio) {
      throw new Error("ContentDTO 缺少 audio 字段，无法渲染");
    }
    const items: WordCardItem[] = dto.content;

    const template = await loadTemplate("word-card.html");
    const htmlList = items.map((item) => {
      const exampleBlock = item.example
        ? `<div class="example">${escapeHtml(item.example)}</div>${
            item.exampleMeaning
              ? `<div class="example-meaning">${escapeHtml(item.exampleMeaning)}</div>`
              : ""
          }`
        : "";
      return fillTemplate(template, {
        WORD: escapeHtml(item.word),
        POS: escapeHtml(item.pos),
        MEANING: escapeHtml(item.meaning),
        EXAMPLE_BLOCK: exampleBlock,
      });
    });

    const paths = await screenshotHtmls(htmlList, workDir);
    const durations = allocateDurations(
      items.map((i) => i.word.length + i.meaning.length + i.example.length),
      audio.duration,
    );

    return {
      frames: paths.map((filePath, i) => ({ filePath, duration: durations[i] })),
      totalDuration: audio.duration,
    };
  }
}
