/**
 * quiz（选择题）模板渲染器
 * 依据：docs/10 §4.4
 * 每道题 2 帧：题目帧 + 解析帧（正确项高亮 + 解析文字）
 */
import type { ContentDTO, QuizItem } from "@ai-english/shared";
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
    const readWeights: number[] = [];
    for (const q of items) {
      htmlList.push(renderQuizHtml(template, q, false));
      // 题目帧权重 = 该题朗读文本量（题干 + 选项，配音按此比例朗读）
      readWeights.push(q.stem.length + q.options.join("").length);
      htmlList.push(renderQuizHtml(template, q, true));
    }

    const paths = await screenshotHtmls(htmlList, workDir);
    // 题目帧 = 该题朗读比例 × 配音总时长 + 1s 缓冲（读完所有选项再等 1 秒才显示答案，用户确认 2026-08-18）
    // 答案帧固定 2.5s（解析阅读）；答案帧起点插入提示音
    const totalRead = readWeights.reduce((n, w) => n + w, 0) || 1;
    const ANSWER_DURATION = 2.5;
    const QUESTION_PAUSE = 1.0;
    const durations: number[] = [];
    const beepTimes: number[] = [];
    let cursor = 0;
    for (let i = 0; i < items.length; i++) {
      const questionDuration = (readWeights[i] / totalRead) * audio.duration + QUESTION_PAUSE;
      durations.push(questionDuration);
      cursor += questionDuration;
      beepTimes.push(cursor); // 答案帧起点：提示音
      durations.push(ANSWER_DURATION);
      cursor += ANSWER_DURATION;
    }

    return {
      frames: paths.map((filePath, i) => ({ filePath, duration: durations[i] })),
      totalDuration: cursor,
      beepTimes,
    };
  }
}
