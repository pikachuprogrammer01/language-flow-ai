/**
 * AI 内容生成服务（docs/15）
 * 用户输入 topic/level → LLM 生成中文故事（英文词嵌入）→ 词库校验过滤 → ContentDTO
 */
import { randomBytes } from "node:crypto";
import type { ContentDTO } from "@ai-english/shared";
import { z } from "zod";
import { db } from "../db";
import { logger } from "../lib/logger";
import { validateWords } from "./cet.service";
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

function buildPrompt(input: GenerateSceneWordInput): string {
  const count = input.wordCount ?? 8;
  const segments = suggestSegmentCount(input.targetDuration);
  return [
    "你是一名英语短视频内容创作者。根据用户主题生成一个中文情景故事，自然嵌入指定数量的四六级英文词汇。",
    "要求：",
    `1. 中文为主要叙述语言，英文词汇自然嵌入句中（如"Leo接到一份contract"），不要用括号标注解释`,
    `2. 词汇数量：${count} 个，等级 ${input.level}；不得自造词，选常见的${input.level}词汇`,
    `3. 故事情节连贯、生活化，主题：${input.topic}`,
    `4. 正文分 ${segments} 段（每段 40-80 字），每段含部分词汇`,
    "5. 标题为主题式：点明故事主题+学习内容，自然不夸张，不超过 20 字",
    "6. 只输出 JSON，不要任何其他文字，格式：",
    '{"title":"标题","segments":[{"text":"段落文本","words":[{"word":"英文词","meaning":"中文释义"}]}]}',
    "7. 每个 words 里的 word 必须逐字出现在对应段落的 text 中（渲染高亮依赖）",
  ].join("\n");
}

/** 词库校验后的段结构（与 SceneWordSegment 兼容） */
interface DictFilteredSegment {
  text: string;
  words: { word: string; meaning: string; level: "CET4" | "CET6" }[];
}

/** 词库校验过滤：LLM 给出的词必须命中词库，词义以词库为准（docs/15 §三） */
async function filterWordsByDict(
  segments: z.infer<typeof llmOutputSchema>["segments"],
  level: "CET4" | "CET6",
): Promise<DictFilteredSegment[]> {
  const result: DictFilteredSegment[] = [];
  for (const seg of segments) {
    const words = seg.words.map((w) => w.word);
    const { matchedWords } = await validateWords(words, level, db);
    const matched = new Map(matchedWords.map((m) => [m.word.toLowerCase(), m]));
    const kept = seg.words
      .map((w) => matched.get(w.word.toLowerCase()))
      .filter((m): m is NonNullable<typeof m> => m !== undefined);
    if (seg.text && kept.length > 0) {
      result.push({
        text: seg.text,
        words: kept.map((m) => ({ word: m.word, meaning: m.meaning, level: m.level })),
      });
    }
  }
  return result;
}

/** 生成 scene_word 内容（ContentDTO） */
export async function generateSceneWordContent(input: GenerateSceneWordInput): Promise<ContentDTO> {
  const raw = await chatCompletion([{ role: "user", content: buildPrompt(input) }]);
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
}
