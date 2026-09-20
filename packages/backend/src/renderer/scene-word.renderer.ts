/**
 * scene_word（情景背词）模板渲染器
 * 依据：docs/10 §4.2 + 《情景词汇阅读视频模板设计规范 V1.0》
 * 单画面渲染（用户确认 2026-08-17）：所有 segment 合并为一个画面，一帧到底，
 * 底部展示全视频词汇汇总；字号按文本总量自适应，保证内容完整可读
 * 可选片头：Three.js 约 1 秒主题化动效（style.introEffect !== false，默认开）
 */
import type { ContentDTO, IntroStatus, SceneWordSegment } from "@ai-english/shared";
import { allocateDurations } from "./allocate-durations";
import { isSceneWord } from "./guards";
import { escapeHtml, escapeRegExp, fillTemplate, loadTemplate } from "./html";
import { screenshotHtmls } from "./playwright";
import type { RenderResult, TemplateRenderer } from "./renderer.interface";
import { INTRO_DURATION_SEC, captureThreeIntro } from "./three-intro.capture";

/** 将文本中的四六级词汇高亮为 <mark>（词边界正则，全部出现；wordIndex 定位留作升级路径） */
export function highlightWords(text: string, words: SceneWordSegment["words"]): string {
  let html = escapeHtml(text);
  for (const w of words) {
    const pattern = new RegExp(`\\b${escapeRegExp(w.word)}\\b`, "gi");
    html = html.replace(pattern, (match) => `<mark>${match}</mark>`);
  }
  return html;
}

/** 按文本总量自适应正文字号（短文本大字号，长文本缩小保证放得下） */
export function fitFontSize(textLength: number): number {
  if (textLength < 90) return 42;
  if (textLength < 160) return 36;
  if (textLength < 240) return 32;
  return 28;
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

    // 单画面：全部 segment 合并（段间空行），词汇去重汇总
    const paragraphs = segments
      .map((seg) => highlightWords(seg.text, seg.words))
      .filter((p) => p.length > 0);
    const fullText = paragraphs.join("\n\n");
    const allWords = [
      ...new Map(segments.flatMap((s) => s.words).map((w) => [w.word.toLowerCase(), w])).values(),
    ];
    const highlightWord = dto.words[0]?.word ?? allWords[0]?.word ?? "";

    let introFrames: Awaited<ReturnType<typeof captureThreeIntro>> = null;
    let introStatus: IntroStatus;
    if (dto.style.introEffect === false) {
      introStatus = "disabled";
    } else {
      introFrames = await captureThreeIntro({
        topic: dto.style.introTopic?.trim() || dto.title,
        title: dto.title,
        highlightWord,
        workDir,
      });
      // 失败（captureThreeIntro 返回 null）不再静默：标 failed，由上层落库留痕（D5/F1）
      introStatus = introFrames && introFrames.length > 0 ? "rendered" : "failed";
    }

    const template = await loadTemplate("scene-word.html");
    const html = fillTemplate(template, {
      // 标题中的英文词同样高亮（与正文一致）
      TITLE: highlightWords(dto.title, allWords),
      TEXT: fullText,
      FONT_SIZE: String(fitFontSize(fullText.length)),
      SUMMARY_WORDS: allWords
        .map(
          (w) =>
            `<span class="summary-item"><span class="word">${escapeHtml(w.word)}</span><span>${escapeHtml(w.meaning)}</span></span>`,
        )
        .join(""),
    });

    const paths = await screenshotHtmls([html], workDir);
    const durations = allocateDurations([fullText.length], audio.duration);
    const bodyFrames = paths.map((filePath, i) => ({
      filePath,
      duration: durations[i],
    }));

    const introPadSec = introFrames && introFrames.length > 0 ? INTRO_DURATION_SEC : 0;
    const frames = introPadSec > 0 && introFrames ? [...introFrames, ...bodyFrames] : bodyFrames;

    return {
      frames,
      totalDuration: audio.duration + introPadSec,
      introPadSec: introPadSec > 0 ? introPadSec : undefined,
      introStatus,
    };
  }
}
