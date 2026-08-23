/**
 * AI 内容生成服务（docs/15）
 * 生成策略（2026-08-23 重构 V4.1，解决英文词重复与词数不足）：
 *   1. 混合词表：LLM 主题相关词（词库把关）+ 词库随机抽样补足至 120 个（删除 V3 的 NARRATIVE_WORDS 固定死列表）
 *   2. 模型只写纯中文故事（qwen2.5:7b 实测无法可靠完成"写故事+标注英文词"的元任务，V4 短暂尝试后回退）
 *   3. 代码全池注入：扫描全部候选词的中文义项替换为英文词（确定性逻辑；渲染器 \b 高亮依赖英文在文本内）；
 *      模型自写的英文词经词库校验后补进标签
 *   4. 验收：topic 回显匹配 + 注入后全篇唯一英文词 ≥ 8；不通过携带原因反馈重试（最多 3 次，每次全新对话）
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

// ── LLM 输出结构（模型只回 text，词汇由代码全池注入） ──
const llmOutputSchema = z.object({
  topic: z.string().min(1),
  title: z.string().min(1).max(60),
  segments: z
    .array(
      z.object({
        text: z.string().min(1),
      }),
    )
    .min(1),
});

const topicWordsSchema = z.object({
  words: z.array(z.string().min(1)).min(1).max(40),
});

const pickedWordsSchema = z.object({
  words: z.array(z.string().min(1)).min(1),
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

// ── 阶段一：混合词表（主题词 + 随机补足） ──

/** 让 LLM 列出与主题相关的英文词（语义理解比词库释义匹配更准） */
async function fetchTopicWords(topic: string, level: string): Promise<string[]> {
  const prompt = [
    `主题：${topic}（词汇等级：${level}）`,
    "列出 30 个与上述主题语义高度相关的常见英语词汇（名词/动词为主，避免过于生僻或抽象），只输出一个 JSON 对象，不要其他文字：",
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

/** 用户要求的词汇数硬边界（2026-08-23 D2 决策）：每篇 8~20 词 */
export const SCENE_MIN_WORDS_PER_CONTENT = 8;
export const MAX_WORDS_PER_CONTENT = 20;

/** word_card / quiz 共用的下限（历史契约保持不变，勿与 scene_word 下限混淆） */
export const MIN_WORDS_PER_CONTENT = 5;

/** 混合词表规模（D1 决策：主题词优先，词库随机抽样补足） */
export const WORD_LIST_SIZE = 120;

/** 候选词来源标注（审计档案用） */
export interface CandidateSource {
  source: "topic" | "random";
  word: string;
}

/** 生成审计档案（PRD 10.1.4）：输入/词表来源/重试历史/修改日志 */
export interface GenerationAudit {
  input: {
    topic: string;
    level: "CET4" | "CET6";
    wordCount?: number;
    targetDuration?: number;
    template: string;
  };
  process: {
    candidates: CandidateSource[];
    attempts: {
      prompt: string;
      result: "accepted" | "rejected";
      reason?: string;
      injectedWords: string[];
    }[];
  };
  createdAt: string;
  /** 修改日志（PATCH 时追加，PRD 10.1.4 操作日志 MVP：仅记录修改动作） */
  modifications?: { at: string; fields: string[] }[];
}
/** 混合词表组装：主题相关词（LLM 产出 + 词库把关）→ 词库随机抽样补足 */
async function buildWordList(input: GenerateSceneWordInput): Promise<{
  words: { word: string; meaning: string; level: "CET4" | "CET6" }[];
  sources: CandidateSource[];
}> {
  const topicWords = await fetchTopicWords(input.topic, input.level);
  const { matchedWords: topic } =
    topicWords.length > 0 ? await validateWords(topicWords, input.level, db) : { matchedWords: [] };

  // 随机补足：当前种子数据 frequency 全为 0 → 全表随机洗牌；
  // 注意若将来灌入词频数据，randomWords 会退化为词频 top-200 抽样，需复查篇目间多样性
  const { words: randoms } = await randomWords(
    input.level,
    Math.max(0, WORD_LIST_SIZE - topic.length),
    db,
  );

  // 合并去重，主题词排最前（prompt 中优先展示）
  const seen = new Set(topic.map((t) => t.word.toLowerCase()));
  const dedupedRandoms = randoms.filter((r) => {
    const key = r.word.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    words: [...topic, ...dedupedRandoms],
    sources: [
      ...topic.map((w) => ({ source: "topic" as const, word: w.word })),
      ...dedupedRandoms.map((w) => ({ source: "random" as const, word: w.word })),
    ],
  };
}

/**
 * 选词阶段：让 LLM 从候选池挑选适合主题的词（简单选择任务，7B 可靠完成；
 * 实测"指令内联小清单"的遵从度远高于"长列表自由发挥"）
 * 返回选中的词（必在池中）；失败返回空数组，由调用方回退到通用指令
 */
async function pickWordsFromPool(
  topic: string,
  pool: { word: string; meaning: string }[],
  count: number,
): Promise<{ word: string; meaning: string }[]> {
  const list = pool
    .map((c) => `${c.word}（${splitMeanings(c.meaning).slice(0, 2).join("；") || c.meaning}）`)
    .join("\n");
  const prompt = [
    `主题：${topic}`,
    `从下方候选词汇中挑选 ${count} 个最适合自然写进该主题中文情景故事的英语单词，只输出一个 JSON 对象，不要其他文字：`,
    '{"words":["word1","word2",...]}',
    `候选词汇：\n${list}`,
  ].join("\n");
  try {
    const raw = await chatCompletion([{ role: "user", content: prompt }]);
    const out = pickedWordsSchema.safeParse(extractJson<unknown>(repairSegmentsArray(raw)));
    if (!out.success) return [];
    const byWord = new Map(pool.map((c) => [c.word.toLowerCase(), c]));
    return [...new Set(out.data.words.map((w) => w.trim().toLowerCase()))]
      .map((w) => byWord.get(w))
      .filter((c): c is { word: string; meaning: string } => Boolean(c))
      .slice(0, count);
  } catch (err) {
    logger.warn({ err, topic }, "pool word pick failed");
    return [];
  }
}
// ── 阶段二：故事生成 prompt（模型只写中文故事 + 英文词标注） ──

/** 目标词数：显式指定则 clamp 到 [8,20]，否则每次随机 [8,16]（用户要求"8~20 之间随机"） */
function resolveTargetWordCount(wordCount: number | undefined): number {
  if (wordCount != null) {
    return Math.min(Math.max(wordCount, SCENE_MIN_WORDS_PER_CONTENT), MAX_WORDS_PER_CONTENT);
  }
  return SCENE_MIN_WORDS_PER_CONTENT + Math.floor(Math.random() * 9);
}

function buildPrompt(
  input: GenerateSceneWordInput,
  wordList: { word: string; meaning: string }[],
  mustUseSenses: string[],
  targetCount: number,
  feedback?: string,
): string {
  const segments = suggestSegmentCount(input.targetDuration);
  // 义项只取前 2 个控制 prompt 体积（120 词全量释义过长）；注入阶段仍用全量义项
  const candidateList = wordList
    .map((c) => `${c.word}（${splitMeanings(c.meaning).slice(0, 2).join("；") || c.meaning}）`)
    .join("\n");
  const feedbackBlock = feedback ? `\n上次生成的错误（本次必须修正）：${feedback}\n` : "";
  // 选词阶段成功 → 内联"必须全部出现"清单（实测遵从度接近 100%）；失败回退通用指令
  const mustUseLine =
    mustUseSenses.length > 0
      ? `3. 下面这些单词的中文含义必须全部出现在故事里（使用原词，共 ${mustUseSenses.length} 个）：${mustUseSenses.join("、")}`
      : `3. 写作时自然运用下方候选词汇的中文含义：至少 ${targetCount} 个词的中文含义要出现在故事里，且使用词表义项的原词（如候选词有「contract 合同」，就写「合同」这类字面一致的词）。务必自然，不要罗列`;
  return [
    "你是一名英语短视频内容创作者。根据用户主题写一个中文情景故事，故事会被自动配上英语词汇学习标签。",
    "要求：",
    `1. 故事必须紧紧围绕主题「${input.topic}」展开，情节连贯、生活化；标题也必须呼应主题`,
    "2. 全部用中文写作，不要写任何英文单词",
    mustUseLine,
    `4. 正文分 ${segments} 段（每段 60-120 字）；topic 字段回显你理解的主题`,
    "5. 只输出一个 JSON 对象，不要任何其他文字、不要 markdown 围栏。segments 必须是同一个数组，所有段落对象放在一对 [] 内用逗号分隔；每段只需 text 字段",
    `候选词汇（写作时自然涉及其中文含义即可）：\n${candidateList}`,
    '严格按以下格式输出（示例内容不可复用）：{"topic":"科技创业","title":"一次科技创业","segments":[{"text":"Leo签下一份合同，计划扩张业务。"}]}',
    feedbackBlock,
  ].join("\n");
}

// ── 标注校验 + 定向注入 ──

/**
 * 词库释义拆分为短义项（如"市场；股市；行情，销路" → ["市场","股市","行情","销路"]）。
 * 关键：先剥离词性标记（n./vt./adj. 等）再切分——否则义项带 "n." 前缀，
 * 注入时在正文中永远匹配不到（历史"英文词太少"的隐藏根因之一）
 */
function splitMeanings(meaning: string): string[] {
  return meaning
    .replace(
      /(?:^|[\s（(])+(?:n|v|vt|vi|adj|adv|num|art|prep|conj|pron|aux|int|interj)\.\s*/gi,
      "；",
    )
    .split(/[；;，,、]/)
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

/** 从文本中提取英文单词（≥2 字母，去重保序） */
function extractEnglishWords(text: string): string[] {
  return [...new Set(text.match(/[a-zA-Z]{2,}/g) ?? [])];
}

/**
 * 修复 qwen 偶发的分段数组粘连：'segments':[{".."}],[{".."}] → 合并为同一数组。
 * 本 schema 无嵌套数组，合法 JSON 中 "}], [{" 不存在；整段替换 "}],[{" 为 "},{"
 */
function repairSegmentsArray(raw: string): string {
  return raw.replace(/\}\s*\]\s*,\s*\[\s*\{/g, "},{");
}

/**
 * 全池注入 + 补齐：扫描全部候选词的中文义项替换为英文词（注入是确定性代码，不依赖模型元任务）；
 * 再提取文本中模型自写的英文词，词库命中后补进词汇标签
 */
async function injectSegments(
  segments: { text?: unknown }[],
  candidates: { word: string; meaning: string; level: "CET4" | "CET6" }[],
  level: "CET4" | "CET6",
): Promise<DictFilteredSegment[]> {
  const result: DictFilteredSegment[] = [];
  for (const seg of segments) {
    const text = typeof seg.text === "string" ? seg.text : "";
    if (!text.trim()) continue;
    const { text: injectedText, injected } = injectFromDict(text, candidates);

    // 补齐：文本中所有英文词（模型自写的可能不在注入列表）
    const have = new Set(injected.map((i) => i.word.toLowerCase()));
    const extra = extractEnglishWords(injectedText).filter((w) => !have.has(w.toLowerCase()));
    if (extra.length > 0) {
      const { matchedWords } = await validateWords(extra, level, db);
      const extraWords = matchedWords
        .filter((m) => !have.has(m.word.toLowerCase()))
        .slice(0, Math.max(0, MAX_WORDS_PER_CONTENT - injected.length));
      for (const m of extraWords) have.add(m.word.toLowerCase());
      injected.push(...extraWords);
    }

    result.push({ text: injectedText, words: injected });
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
  // 硬约束：注入后全篇唯一英文词 ≥ 8（同词多段重复只算一个）
  const total = new Set(filtered.flatMap((s) => s.words.map((w) => w.word.toLowerCase()))).size;
  if (total < SCENE_MIN_WORDS_PER_CONTENT) {
    return {
      ok: false,
      reason: `有效词不足：仅 ${total} 个（要求至少 ${SCENE_MIN_WORDS_PER_CONTENT} 个）。请让故事更贴近候选词汇的中文含义，写出词表义项的原词（如写「市场」「合同」「发展」这类字面一致的词），让至少 ${SCENE_MIN_WORDS_PER_CONTENT} 个候选词能自然出现。`,
    };
  }
  return { ok: true };
}

// ── 主流程 ──

/** 生成 scene_word 内容（ContentDTO + 审计档案）；验收不通过时携带失败原因反馈重试，最多 3 次（每次全新对话） */
export async function generateSceneWordContent(
  input: GenerateSceneWordInput,
): Promise<ContentDTO & { audit: GenerationAudit }> {
  let lastFeedback = "（未生成）";
  const attempts: GenerationAudit["process"]["attempts"] = [];
  const { words: wordList, sources } = await buildWordList(input);
  const targetCount = resolveTargetWordCount(input.wordCount);
  // 选词阶段：模型从池中挑出适合主题的词，故事阶段按内联清单强制使用（两段式，各自都是简单任务）。
  // 多选 3 个备用：个别义项可能写不进故事，留出余量保证 ≥8 的验收下限可达
  const picked = await pickWordsFromPool(
    input.topic,
    wordList,
    Math.min(targetCount + 3, MAX_WORDS_PER_CONTENT),
  );
  const mustUseSenses = picked
    .map((w) => splitMeanings(w.meaning)[0])
    .filter((s): s is string => Boolean(s));
  for (let attempt = 0; attempt < 3; attempt++) {
    const prompt = buildPrompt(
      input,
      wordList,
      mustUseSenses,
      targetCount,
      attempt > 0 ? lastFeedback : undefined,
    );
    try {
      const raw = await chatCompletion([{ role: "user", content: prompt }]);
      const llmOutput = llmOutputSchema.safeParse(extractJson<unknown>(repairSegmentsArray(raw)));
      if (!llmOutput.success) {
        lastFeedback =
          "输出不是合法的 JSON（必须只输出一个 JSON 对象，不要任何其他文字或 markdown 围栏）";
        attempts.push({ prompt, result: "rejected", reason: lastFeedback, injectedWords: [] });
        logger.warn({ raw: raw.slice(0, 2000) }, "LLM 输出结构不符");
        continue;
      }

      // 全池定向注入（中文义项 → 英文词，保证渲染器可高亮）+ 模型自写英文词补标签
      const segments = await injectSegments(llmOutput.data.segments, wordList, input.level);
      const accept = acceptOutput(input, llmOutput.data, segments);
      attempts.push({
        prompt,
        result: accept.ok ? "accepted" : "rejected",
        reason: accept.ok ? undefined : (accept.reason ?? "输出不达标"),
        injectedWords: [
          ...new Set(segments.flatMap((s) => s.words.map((w) => w.word.toLowerCase()))),
        ],
      });
      if (!accept.ok) {
        lastFeedback = accept.reason ?? "输出不达标";
        logger.warn({ reason: lastFeedback, attempt: attempt + 1 }, "content generate rejected");
        continue;
      }

      // 上限 20：按段序保留前 20 个（即全文首现顺序），配额用尽的段不再带标签
      const limited: DictFilteredSegment[] = [];
      let quota = MAX_WORDS_PER_CONTENT;
      for (const seg of segments) {
        const kept = seg.words.slice(0, Math.max(0, quota));
        quota -= kept.length;
        limited.push({ text: seg.text, words: kept });
      }

      const now = new Date().toISOString();
      const allWords = [
        ...new Map(limited.flatMap((s) => s.words).map((w) => [w.word.toLowerCase(), w])).values(),
      ];
      return {
        id: makeContentId(),
        template: "scene_word",
        title: llmOutput.data.title,
        level: input.level,
        targetDuration: input.targetDuration ?? 60,
        content: limited,
        words: allWords,
        style: { background: "white" },
        voice: { id: "female_01" },
        status: "content_ready",
        createdAt: now,
        updatedAt: now,
        audit: {
          input: {
            topic: input.topic,
            level: input.level,
            wordCount: input.wordCount,
            targetDuration: input.targetDuration,
            template: "scene_word",
          },
          process: { candidates: sources, attempts },
          createdAt: now,
        },
      };
    } catch (err) {
      lastFeedback = err instanceof Error ? err.message : "生成失败";
      attempts.push({ prompt, result: "rejected", reason: lastFeedback, injectedWords: [] });
      logger.warn({ attempt: attempt + 1 }, "content generate retry");
    }
  }
  // 3 次仍失败：抛出可读原因（500 响应体展示给用户/人工审核）
  throw new Error(`内容生成未通过验收：${lastFeedback}`);
}
