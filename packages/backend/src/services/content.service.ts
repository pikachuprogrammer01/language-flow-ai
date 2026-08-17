/**
 * AI 内容生成服务（docs/15）
 * 生成策略（2026-08-17 重构 V3，解决主题/文案偏离与 7B 能力限制）：
 *   1. 两阶段：LLM 产出主题相关词 → 词库把关 → 随机补足 → 再生成故事
 *   2. 模型只写纯中文故事（最擅长），词汇由代码注入（彻底移除模型元任务）
 *   3. 代码注入：扫描候选词的中文释义在文本中的出现 → 替换为英文词（词必在词库、逐字在文本）
 *   4. 模型回显 topic，代码验收主题相关度；词数不足时反馈重试（最多 3 次，每次全新对话）
 */
import { randomBytes } from "node:crypto";
import type { ContentDTO } from "@ai-english/shared";
import { z } from "zod";
import { db } from "../db";
import { logger } from "../lib/logger";
import { randomWords, validateWords } from "./cet.service";
import { chatCompletion, extractJson } from "./llm.service";

export interface GenerateSceneWordInput {
  topic: string;
  level: "CET4" | "CET6";
  wordCount?: number;
  targetDuration?: number;
}

// ── LLM 输出结构（模型只回 text，词汇由代码注入） ──
const llmOutputSchema = z.object({
  topic: z.string().min(1),
  title: z.string().min(1).max(60),
  segments: z
    .array(
      z.object({
        text: z.string().min(1),
        words: z
          .array(z.object({ word: z.string().min(1), meaning: z.string().optional() }))
          .optional(),
      }),
    )
    .min(1),
});

const topicWordsSchema = z.object({
  words: z.array(z.string().min(1)).min(1).max(20),
});

/** 生成任务 id：cnt_YYYYMMDD_XXXXXX（6 位十六进制，docs/04 契约） */
function makeContentId(): string {
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  const hex = randomBytes(3).toString("hex");
  return `cnt_${ymd}_${hex}`;
}

/** 按目标时长建议段数（docs/15 §三） */
function suggestSegmentCount(targetDuration?: number): number {
  if (!targetDuration) return 2;
  if (targetDuration <= 30) return 1;
  if (targetDuration <= 90) return 2;
  return 3;
}

// ── 阶段一：主题相关候选词 ──

/** 让 LLM 列出与主题相关的英文词（语义理解比词库释义匹配更准） */
async function fetchTopicWords(topic: string, level: string): Promise<string[]> {
  const prompt = [
    `主题：${topic}（词汇等级：${level}）`,
    "列出 15 个与上述主题语义高度相关的常见英语词汇（名词/动词为主，避免过于生僻或抽象），只输出一个 JSON 对象，不要其他文字：",
    '{"words":["word1","word2",...]}',
  ].join("\n");
  try {
    const raw = await chatCompletion([{ role: "user", content: prompt }]);
    const out = topicWordsSchema.safeParse(extractJson<unknown>(raw));
    return out.success
      ? out.data.words.map((w) => w.trim().toLowerCase()).filter((w) => w.length >= 2)
      : [];
  } catch (err) {
    logger.warn({ err, topic }, "topic words fetch failed");
    return [];
  }
}

/**
 * 通用叙事词表（2026-08-17 实测词库存在）：任意主题故事都容易自然出现的中文词义，
 * 用于候选词补足，保证注入词数下限可达成（用户要求：每篇 5-20 词）
 */
const NARRATIVE_WORDS = [
  "product",
  "improve",
  "provide",
  "opportunity",
  "risk",
  "market",
  "establish",
  "support",
  "contract",
  "create",
  "require",
  "resolve",
  "perform",
  "propose",
  "consequence",
  "emphasis",
  "finally",
  "staff",
  "expectation",
  "alternative",
  "object",
  "resume",
  "elect",
  "calculate",
  "convention",
  "reverse",
] as const;

/** 用户要求的词汇数硬边界：每篇 ≥5 且 ≤20（注入上限） */
export const MIN_WORDS_PER_CONTENT = 5;
export const MAX_WORDS_PER_CONTENT = 20;

/** 候选词组装：主题相关词（LLM 产出 + 词库把关）→ 通用叙事词 → 高频池随机补足 */
async function buildCandidates(
  input: GenerateSceneWordInput,
): Promise<{ word: string; meaning: string; level: "CET4" | "CET6" }[]> {
  const want = input.wordCount ?? 8;
  const target = Math.min(want * 2, MAX_WORDS_PER_CONTENT);
  const have = new Set<string>();
  const result: { word: string; meaning: string; level: "CET4" | "CET6" }[] = [];
  const pushIfNew = (m: { word: string; meaning: string; level: "CET4" | "CET6" }): void => {
    if (result.length >= target || have.has(m.word.toLowerCase())) return;
    have.add(m.word.toLowerCase());
    result.push(m);
  };

  // 1) 主题相关词：LLM 产出 → 词库把关（词义以词库为准）
  const topicWords = await fetchTopicWords(input.topic, input.level);
  if (topicWords.length > 0) {
    const { matchedWords } = await validateWords(topicWords, input.level, db);
    for (const m of matchedWords) pushIfNew(m);
  }

  // 2) 通用叙事词（任意主题故事自然出现概率高）
  const { matchedWords: narrative } = await validateWords([...NARRATIVE_WORDS], input.level, db);
  for (const m of narrative) pushIfNew(m);

  // 3) 高频池随机补足（保底）
  if (result.length < target) {
    const { words: randoms } = await randomWords(input.level, target, db);
    for (const r of randoms) pushIfNew(r);
  }
  return result;
}

// ── 阶段二：故事生成 prompt（模型只写中文故事） ──

function buildPrompt(
  input: GenerateSceneWordInput,
  candidates: { word: string; meaning: string }[],
  feedback?: string,
): string {
  const segments = suggestSegmentCount(input.targetDuration);
  const candidateList = candidates.map((c) => `${c.word}（${c.meaning}）`).join("\n");
  const feedbackBlock = feedback ? `\n上次生成的错误（本次必须修正）：${feedback}\n` : "";
  return [
    "你是一名英语短视频内容创作者。根据用户主题写一个中文情景故事，故事会被自动配上英语词汇学习标签。",
    "要求：",
    `1. 故事必须紧紧围绕主题「${input.topic}」展开，情节连贯、生活化；标题也必须呼应主题`,
    "2. 全部用中文写作，不要写任何英文",
    "3. 写作时自然使用下方候选词汇的中文含义相关的内容：候选词里至少 5 个词的中文含义要出现在故事里（如候选词有「市场」，就写「市场」「行情」这类词；候选词有「产品」，就写「产品」）。务必自然，不要罗列",
    `4. 正文分 ${segments} 段（每段 60-120 字）`,
    "5. 标题为主题式：点明故事主题+学习内容，自然不夸张，不超过 20 字",
    "6. 只输出一个 JSON 对象，不要任何其他文字、不要 markdown 围栏。topic 字段回显你理解的主题；segments 每段只需 text 字段",
    `候选词汇（写作时自然涉及其中中文含义即可）：\n${candidateList}`,
    '严格按以下格式（示例内容不可复用）：{"topic":"科技创业","title":"一次科技创业","segments":[{"text":"Leo签下一份合同，决定接受这份工作。"}]}',
    feedbackBlock,
  ].join("\n");
}

// ── 代码注入：扫描候选词的中文释义在文本中的出现，替换为英文词 ──

/** 词库释义拆分为短义项（如"市场；股市；行情，销路" → ["市场","股市","行情","销路"]） */
function splitMeanings(meaning: string): string[] {
  return meaning
    .split(/[；;，,、/]/)
    .map((m) => m.trim())
    .filter((m) => m.length >= 2 && m.length <= 6);
}

/**
 * 在文本中查找候选词的释义片段并替换为英文词（按义项长度降序，避免子串冲突）
 * 返回注入后的文本与命中的词列表（词必在词库、逐字在文本）
 */
function injectFromDict(
  text: string,
  candidates: { word: string; meaning: string; level: "CET4" | "CET6" }[],
): { text: string; injected: { word: string; meaning: string; level: "CET4" | "CET6" }[] } {
  let t = text;
  const injected: { word: string; meaning: string; level: "CET4" | "CET6" }[] = [];
  // 全部义项按长度降序（先替换长词，防"美味"抢在"美味的"之前）
  const items = candidates
    .flatMap((c) =>
      splitMeanings(c.meaning).map((m) => ({ word: c.word, meaning: m, level: c.level })),
    )
    .sort((a, b) => a.meaning.length - b.meaning.length)
    .reverse();
  for (const item of items) {
    if (injected.length >= MAX_WORDS_PER_CONTENT) break; // 上限 20：超出即停
    const idx = t.indexOf(item.meaning);
    if (idx === -1 || injected.some((i) => i.word === item.word)) continue;
    // 相邻字符是字母/数字则补空格（防 technologymarket 粘连，且保证 \b 词边界可用于逆替换/高亮）
    const before = idx > 0 ? t[idx - 1] : "";
    const afterIdx = idx + item.meaning.length;
    const after = afterIdx < t.length ? t[afterIdx] : "";
    const padBefore = /[a-zA-Z0-9]/.test(before) ? " " : "";
    const padAfter = /[a-zA-Z0-9]/.test(after) ? " " : "";
    t = `${t.slice(0, idx)}${padBefore}${item.word}${padAfter}${t.slice(afterIdx)}`;
    injected.push(item);
  }
  return { text: t, injected };
}

/** 词库校验后的段结构（与 SceneWordSegment 兼容） */
interface DictFilteredSegment {
  text: string;
  words: { word: string; meaning: string; level: "CET4" | "CET6" }[];
}

/** 注入流程：模型中文故事 + 候选词 → 扫描替换 → 分段组装 */
function injectSegments(
  segments: z.infer<typeof llmOutputSchema>["segments"],
  candidates: { word: string; meaning: string; level: "CET4" | "CET6" }[],
): DictFilteredSegment[] {
  const result: DictFilteredSegment[] = [];
  // 无命中段的文本也保留（文案完整性优先，词汇标签可为空）
  for (const seg of segments) {
    const text = seg.text ?? "";
    const { text: injectedText, injected } = injectFromDict(text, candidates);
    if (injectedText) {
      result.push({ text: injectedText, words: injected });
    }
  }
  return result;
}

// ── 代码验收 ──

/** 主题相关度：防"完全对不上"。中文主题按字符覆盖率 ≥50%；英文 token 任一包含；混合主题两者任一通过 */
function topicMatch(expected: string, actual: string): boolean {
  const expectedNorm = expected.trim().toLowerCase();
  const actualNorm = actual.trim().toLowerCase();
  if (!actualNorm) return false;
  const hasChinese = /[\u4e00-\u9fff]/.test(expectedNorm);

  // 无中文字符（纯英文/数字主题）：LLM 通常原样回显 → 包含匹配
  if (!hasChinese) {
    return expectedNorm.length >= 3
      ? actualNorm.includes(expectedNorm) || expectedNorm.includes(actualNorm)
      : actualNorm.includes(expectedNorm);
  }

  // 含中文主题：中文字符覆盖率 ≥50% 通过
  const chars = [...new Set(expected.replace(/\s/g, "").replace(/[a-z0-9]/gi, ""))];
  if (chars.length > 0) {
    const hit = chars.filter((ch) => actual.includes(ch)).length;
    if (hit / chars.length >= 0.5) return true;
  }

  // 混合主题兜底：英文 token（≥2 字符）任一出现在回显中（如「AI 创业」回显「人工智能创业」）
  const enTokens = expectedNorm.match(/[a-z0-9]{2,}/g) ?? [];
  return enTokens.some((t) => actualNorm.includes(t));
}

/** 验收结果：ok 时返回通过；否则返回可读的失败原因（供反馈重试与用户查看） */
interface Acceptance {
  ok: boolean;
  reason?: string;
}

function acceptOutput(
  input: GenerateSceneWordInput,
  llmOutput: z.infer<typeof llmOutputSchema>,
  filtered: DictFilteredSegment[],
): Acceptance {
  if (!topicMatch(input.topic, llmOutput.topic)) {
    return {
      ok: false,
      reason: `主题偏离：要求围绕「${input.topic}」，你输出的主题是「${llmOutput.topic}」。请重新围绕「${input.topic}」编写故事。`,
    };
  }
  // 硬约束：每篇 ≥5 词（用户要求，不足即失败重试）
  const minWords = MIN_WORDS_PER_CONTENT;
  const total = filtered.reduce((n, s) => n + s.words.length, 0);
  if (total < minWords) {
    return {
      ok: false,
      reason: `词汇不足：当前只注入 ${total} 个英文词（要求至少 ${minWords} 个）。请让故事更贴近候选词汇的中文含义（如写"市场""产品""发展""合同"这类词），让至少 ${minWords} 个候选词能自然出现。`,
    };
  }
  return { ok: true };
}

// ── 主流程 ──

/** 生成 scene_word 内容（ContentDTO）；验收不通过时携带失败原因反馈重试，最多 3 次（每次全新对话） */
export async function generateSceneWordContent(input: GenerateSceneWordInput): Promise<ContentDTO> {
  let lastFeedback = "（未生成）";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const candidates = await buildCandidates(input);
      const raw = await chatCompletion([
        {
          role: "user",
          content: buildPrompt(input, candidates, attempt > 0 ? lastFeedback : undefined),
        },
      ]);
      const llmOutput = llmOutputSchema.safeParse(extractJson<unknown>(raw));
      if (!llmOutput.success) {
        lastFeedback =
          "输出不是合法的 JSON（必须只输出一个 JSON 对象，不要任何其他文字或 markdown 围栏）";
        logger.warn({ raw: raw.slice(0, 300) }, "LLM 输出结构不符");
        continue;
      }

      const segments = injectSegments(llmOutput.data.segments, candidates);
      const accept = acceptOutput(input, llmOutput.data, segments);
      if (!accept.ok) {
        lastFeedback = accept.reason ?? "输出不达标";
        logger.warn({ reason: lastFeedback, attempt: attempt + 1 }, "content generate rejected");
        continue;
      }

      const now = new Date().toISOString();
      const allWords = [
        ...new Map(segments.flatMap((s) => s.words).map((w) => [w.word.toLowerCase(), w])).values(),
      ];
      return {
        id: makeContentId(),
        template: "scene_word",
        title: llmOutput.data.title,
        level: input.level,
        targetDuration: input.targetDuration ?? 60,
        content: segments,
        words: allWords,
        style: { background: "white" },
        voice: { id: "female_01" },
        status: "content_ready",
        createdAt: now,
        updatedAt: now,
      };
    } catch (err) {
      lastFeedback = err instanceof Error ? err.message : "生成失败";
      logger.warn({ attempt: attempt + 1 }, "content generate retry");
    }
  }
  // 3 次仍失败：抛出可读原因（500 响应体展示给用户/人工审核）
  throw new Error(`内容生成未通过验收：${lastFeedback}`);
}
