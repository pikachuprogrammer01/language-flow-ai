/**
 * quiz（选择题）模板渲染器
 * 依据：docs/10 §4.4
 * 每道题 2 帧：题目帧 + 解析帧（正确项高亮 + 解析文字）
 */
import type { ContentDTO, QuizItem } from "@ai-english/shared";
import { allocateDurations } from "./allocate-durations";
import { isQuiz } from "./guards";
import { escapeHtml, fillTemplate, loadTemplate } from "./html";
import { screenshotHtmls } from "./playwright";
import type { RenderResult, TemplateRenderer } from "./renderer.interface";

/** 渲染一道题的 HTML；showAnswer=true 时正确项高亮并带解析 */
function renderQuizHtml(template: string, q: QuizItem, showAnswer: boolean): string {
  const options = q.options
    .slice(0, 4) // 选项上限 4 个（QuizItem 契约），超出截断避免字母越界（A-D）
    .map((opt, i) => {
      const letter = String.fromCharCode(65 + i);
      const cls = showAnswer && i === q.correctIndex ? "option correct" : "option";
      return `<div class="${cls}">${letter}. ${escapeHtml(opt)}</div>`;
    })
    .join("");
  return fillTemplate(template, {
    STEM: escapeHtml(q.stem),
    OPTIONS: options,
    EXPLANATION: showAnswer ? escapeHtml(q.explanation) : "",
  });
}

export class QuizRenderer implements TemplateRenderer {
  async render(dto: ContentDTO, workDir: string): Promise<RenderResult> {
    if (!isQuiz(dto)) {
      throw new Error("QuizRenderer 收到非 quiz 模板内容");
    }
    const { audio } = dto;
    if (!audio) {
      throw new Error("ContentDTO 缺少 audio 字段，无法渲染");
    }
    const items: QuizItem[] = dto.content;

    const template = await loadTemplate("quiz.html");
    const htmlList: string[] = [];
    const weights: number[] = [];
    for (const q of items) {
      htmlList.push(renderQuizHtml(template, q, false));
      weights.push(q.stem.length + q.options.join("").length);
      htmlList.push(renderQuizHtml(template, q, true));
      weights.push(q.explanation.length + 8);
    }

    const paths = await screenshotHtmls(htmlList, workDir);
    const durations = allocateDurations(weights, audio.duration);

    return {
      frames: paths.map((filePath, i) => ({ filePath, duration: durations[i] })),
      totalDuration: audio.duration,
    };
  }
}
