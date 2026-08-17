/**
 * word_card（单词卡片）内容生成服务
 * MVP 需求 #1（2）单词卡片：英文单词/词性/中文释义/例句
 * 策略：词库随机抽词（词汇准确性由数据库决定，MVP #4）→ LLM 造卡（词性/例句/例句翻译）→
 *       释义以词库为准（LLM 不生成释义）；word 不在词表的卡片丢弃，不足 5 张反馈重试 ×3
 */
import { randomBytes } from "node:crypto";
import type { ContentDTO, WordCardItem } from "@ai-english/shared";
import { z } from "zod";
import { db } from "../db";
import { logger } from "../lib/logger";
import { randomWords } from "./cet.service";
import type { GenerationAudit } from "./content.service";
import { MAX_WORDS_PER_CONTENT, MIN_WORDS_PER_CONTENT } from "./content.service";
import { chatCompletion, extractJson } from "./llm.service";

export interface GenerateWordCardInput {
  /** 例句主题（弱相关：卡片例句围绕主题展开） */
  topic: string;
  level: "CET4" | "CET6";
  wordCount?: number;
  targetDuration?: number;
}

/** LLM 输出结构：卡片数组（word 必须来自词表；词义由词库兜底） */
const cardOutputSchema = z.object({
  title: z.string().min(1).max(60),
  cards: z
    .array(
      z.object({
        word: z.string().min(1),
        pos: z.string().min(1),
        example: z.string().min(5),
        exampleMeaning: z.string().min(1),
      }),
    )
    .min(1)
    .max(20),
});

function makeCardId(): string {
  return `cnt_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}_${randomBytes(3).toString("hex")}`;
}

/** 生成 word_card 内容（ContentDTO + 审计档案） */
export async function generateWordCardContent(
  input: GenerateWordCardInput,
): Promise<ContentDTO & { audit: GenerationAudit }> {
  const want = Math.min(input.wordCount ?? 8, MAX_WORDS_PER_CONTENT);
  const { words: picked } = await randomWords(input.level, want, db);
  if (picked.length < MIN_WORDS_PER_CONTENT) {
    throw new Error(
      `词库「${input.level}」有效词不足 ${MIN_WORDS_PER_CONTENT} 个（当前 ${picked.length}），无法生成卡片`,
    );
  }
  const wordMap = new Map(picked.map((w) => [w.word.toLowerCase(), w.meaning]));

  const attempts: GenerationAudit["process"]["attempts"] = [];
  let lastFeedback = "（未生成）";
  for (let attempt = 0; attempt < 3; attempt++) {
    const prompt = [
      "你是英语学习内容创作者。为以下四六级单词制作单词卡片（围绕用户主题编写例句）。",
      `主题：${input.topic}`,
      `单词及释义：\n${picked.map((w) => `${w.word}（${w.meaning}）`).join("\n")}`,
      "要求：",
      "1. 每张卡：word（必须是上面列表中的词）、pos（词性，如 n./v./adj./adv.）、example（英文例句，8-18 词，自然融入主题）、exampleMeaning（例句中文翻译）",
      "2. 全部卡片 word 合起来覆盖上面列表中的全部单词",
      "3. 标题为主题式：点明主题+学习内容，不超过 20 字",
      "4. 只输出一个 JSON 对象，不要任何其他文字、不要 markdown 围栏",
      `5. 严格按格式：{"title":"生活英语：常用动词卡片","cards":[{"word":"resolve","pos":"v.","example":"...","exampleMeaning":"..."}]}`,
      lastFeedback === "（未生成）" ? "" : `\n上次生成的错误（本次必须修正）：${lastFeedback}`,
    ].join("\n");

    try {
      const raw = await chatCompletion([{ role: "user", content: prompt }]);
      const parsed = cardOutputSchema.safeParse(extractJson<unknown>(raw));
      if (!parsed.success) {
        lastFeedback = "输出不是合法的 JSON（必须只输出一个 JSON 对象）";
        attempts.push({ prompt, result: "rejected", reason: lastFeedback, injectedWords: [] });
        continue;
      }
      // 校验：word 必须来自词表；去除不在词表的卡
      const validCards = parsed.data.cards.filter((c) => wordMap.has(c.word.toLowerCase()));
      const dropped = parsed.data.cards.length - validCards.length;
      if (validCards.length < MIN_WORDS_PER_CONTENT || dropped > 0) {
        lastFeedback = `卡片问题：${validCards.length} 张有效（要求至少 ${MIN_WORDS_PER_CONTENT} 张）；${dropped} 张的 word 不在给定单词列表中。请只使用列表中的单词。`;
        attempts.push({ prompt, result: "rejected", reason: lastFeedback, injectedWords: [] });
        logger.warn({ reason: lastFeedback, attempt: attempt + 1 }, "word_card rejected");
        continue;
      }
      attempts.push({
        prompt,
        result: "accepted",
        injectedWords: validCards.map((c) => c.word.toLowerCase()),
      });

      const now = new Date().toISOString();
      const content: WordCardItem[] = validCards.map((c) => ({
        word: c.word,
        pos: c.pos,
        meaning: wordMap.get(c.word.toLowerCase()) ?? "",
        example: c.example,
        exampleMeaning: c.exampleMeaning,
      }));
      const words = validCards.map((c) => ({
        word: c.word,
        meaning: wordMap.get(c.word.toLowerCase()) ?? "",
        level: input.level,
      }));
      return {
        id: makeCardId(),
        template: "word_card",
        title: parsed.data.title,
        level: input.level,
        targetDuration: input.targetDuration ?? 60,
        content,
        words,
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
            template: "word_card",
          },
          process: {
            candidates: picked.map((w) => ({ source: "random" as const, word: w.word })),
            attempts,
          },
          createdAt: now,
        },
      };
    } catch (err) {
      lastFeedback = err instanceof Error ? err.message : "生成失败";
      attempts.push({ prompt, result: "rejected", reason: lastFeedback, injectedWords: [] });
      logger.warn({ attempt: attempt + 1 }, "word_card generate retry");
    }
  }
  throw new Error(`单词卡片生成未通过验收：${lastFeedback}`);
}
