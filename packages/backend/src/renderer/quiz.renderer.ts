/**
 * quiz（选择题）模板渲染器
 * 依据：docs/10 §4.4
 * 每道题 2 帧：题目帧 + 解析帧（正确项高亮 + 解析文字）
 */
import type { ContentDTO, QuizItem } from "@ai-english/shared";
import { estimateSpeechSeconds } from "../services/tts.service";
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
  async render(
    dto: ContentDTO,
    workDir: string,
    extra?: { questionDurations?: number[] },
  ): Promise<RenderResult> {
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
    // 题目帧 = 该题朗读实际时长 + 1s 缓冲（音画精确对齐，用户确认 2026-08-18）
    // 无精确时长（旧链路）时按字符比例估算兜底；答案帧固定 2.5s（解析阅读）；题间 0.8s 间隔
    const ANSWER_DURATION = 2.5;
    const QUESTION_PAUSE = 1.0;
    const QUESTION_GAP = 0.8;
    const exact = extra?.questionDurations ?? null;
    // 回退链路（无逐题精确时长）：按朗读估算分配（保守宁慢勿快，画面不抢跑音频）
    const ests = items.map((q) => estimateSpeechSeconds(q.stem + q.options.join("")));
    const totalEst = ests.reduce((n, w) => n + w, 0) || 1;
    const durations: number[] = [];
    const beepTimes: number[] = [];
    let cursor = 0;
    for (let i = 0; i < items.length; i++) {
      const questionDuration =
        (exact?.[i] ?? (ests[i] / totalEst) * audio.duration) + QUESTION_PAUSE;
      durations.push(questionDuration);
      cursor += questionDuration;
      beepTimes.push(cursor); // 答案帧起点：提示音
      durations.push(ANSWER_DURATION + QUESTION_GAP);
      cursor += ANSWER_DURATION + QUESTION_GAP;
    }

    return {
      frames: paths.map((filePath, i) => ({ filePath, duration: durations[i] })),
      totalDuration: cursor,
      beepTimes,
    };
  }
}
