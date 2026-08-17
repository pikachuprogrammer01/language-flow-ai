/**
 * AI 内容生成服务（docs/15）
 * 用户输入 topic/level → LLM 生成中文故事（英文词嵌入）→ 词库校验过滤 → ContentDTO
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

// LLM 输出结构（宽松校验，词汇是否合法由词库决定）
const llmOutputSchema = z.object({
  title: z.string().min(1).max(60),
  segments: z
    .array(
      z.object({
        text: z.string().min(1),
        words: z.array(z.object({ word: z.string().min(1), meaning: z.string().optional() })),
      }),
    )
    .min(1),
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

function buildPrompt(
  input: GenerateSceneWordInput,
  candidates: { word: string; meaning: string }[],
): string {
  const count = input.wordCount ?? 8;
  const segments = suggestSegmentCount(input.targetDuration);
  const candidateList = candidates.map((c) => `${c.word}（${c.meaning}）`).join("\n");
  return [
    "你是一名英语短视频内容创作者。根据用户主题生成一个中文情景故事，自然嵌入指定数量的四六级英文词汇。",
    "要求：",
    `1. 中文为主要叙述语言，英文词汇自然嵌入句中（如"Leo接到一份contract"），不要用括号标注解释`,
    `2. 必须从下方候选词汇中选出恰好 ${count} 个（一个都不能少），嵌入故事（每个候选词至多用一次）；禁止使用候选词汇之外的英文单词`,
    `3. 故事情节连贯、生活化，主题：${input.topic}；故事要足够长以容纳全部词汇`,
    `4. 正文严格分 ${segments} 段（每段 50-100 字），每段至少嵌入 3 个词汇，${count} 个词汇均匀分配到各段`,
    "5. 标题为主题式：点明故事主题+学习内容，自然不夸张，不超过 20 字",
    "6. 只输出一个 JSON 对象，不要任何其他文字、不要 markdown 围栏。words 数组里的 word 必须逐字出现在对应段落的 text 中（渲染高亮依赖）；meaning 用下方候选词汇里的中文释义",
    `候选词汇：\n${candidateList}`,
    "严格按以下示例的格式（示例内容不可复用，主题与词汇必须按上面给定）：",
    '{"title":"一次科技创业","segments":[{"text":"Leo收到一份contract，他决定accept这个offer。","words":[{"word":"contract","meaning":"合同"},{"word":"accept","meaning":"接受"}]}]}',
  ].join("\n");
}

/** 词库校验后的段结构（与 SceneWordSegment 兼容） */
interface DictFilteredSegment {
  text: string;
  words: { word: string; meaning: string; level: "CET4" | "CET6" }[];
}

/** 从文本中提取英文单词（≥2 字母，用于补充 LLM words 数组的遗漏） */
function extractEnglishWords(text: string): string[] {
  return [...new Set(text.match(/[a-zA-Z]{2,}/g) ?? [])];
}

/** 词库校验过滤：LLM 给出的词 + 文本中提取的词，必须命中词库，词义以词库为准（docs/15 §三） */
async function filterWordsByDict(
  segments: z.infer<typeof llmOutputSchema>["segments"],
  level: "CET4" | "CET6",
): Promise<DictFilteredSegment[]> {
  const result: DictFilteredSegment[] = [];
  for (const seg of segments) {
    const text = seg.text ?? "";
    // 合并 LLM 给出的词与文本中实际出现的英文词（小写去重）
    const candidates = [
      ...new Set([...seg.words.map((w) => w.word), ...extractEnglishWords(text)]),
    ];
    const { matchedWords } = await validateWords(candidates, level, db);
    const matched = new Map(matchedWords.map((m) => [m.word.toLowerCase(), m]));
    // 按文本中出现的顺序排列（保证高亮词顺序稳定）
    const kept = [
      ...new Set(
        candidates
          .map((w) => matched.get(w.toLowerCase()))
          .filter((m): m is NonNullable<typeof m> => m !== undefined),
      ),
    ];
    if (text && kept.length > 0) {
      result.push({
        text,
        words: kept.map((m) => ({ word: m.word, meaning: m.meaning, level: m.level })),
      });
    }
  }
  return result;
}

/** 生成 scene_word 内容（ContentDTO）；LLM 输出不达标（JSON 语法错/结构不符/词库无命中）时自动重试，最多 3 次 */
export async function generateSceneWordContent(input: GenerateSceneWordInput): Promise<ContentDTO> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // 从词库高频池随机抽候选词（4 倍，给 LLM 选择空间），保证生成词必命中词库
      const want = input.wordCount ?? 8;
      const candidates = await randomWords(input.level, Math.min(want * 4, 200), db);
      const raw = await chatCompletion([
        { role: "user", content: buildPrompt(input, candidates.words) },
      ]);
      const parsed = extractJson<unknown>(raw);
      const llmOutput = llmOutputSchema.safeParse(parsed);
      if (!llmOutput.success) {
        logger.warn({ raw: raw.slice(0, 400) }, "LLM 输出结构不符");
        throw new Error("LLM 输出结构不符合契约");
      }

      const segments = await filterWordsByDict(llmOutput.data.segments, input.level);
      if (segments.length === 0) {
        logger.warn({ level: input.level }, "词库校验后无可用词汇段");
        throw new Error("词库校验后无可用词汇（请检查词库数据或 LLM 输出）");
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
      lastError = err;
      logger.warn({ attempt: attempt + 1 }, "content generate retry");
    }
  }
  throw lastError;
}
