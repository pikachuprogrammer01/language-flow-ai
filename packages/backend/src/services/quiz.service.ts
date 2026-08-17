/**
 * quiz（选择题）内容生成服务
 * MVP 需求 #1（3）选择题：单词问题/选项/答案/解析
 * 策略（答案由代码构造，消除 LLM 错位风险）：
 *   词库抽词 → LLM 只出题干与解析 → 代码构造选项（正确项=词库释义原文，干扰项=同批其他词释义，洗牌）
 *   → 答案绝对正确（词汇准确性由数据库决定，MVP #4）
 */
import { randomBytes } from "node:crypto";
import type { ContentDTO, QuizItem, WordInfo } from "@ai-english/shared";
import { z } from "zod";
import { db } from "../db";
import { logger } from "../lib/logger";
import { randomWords } from "./cet.service";
import type { GenerationAudit } from "./content.service";
import { MAX_WORDS_PER_CONTENT, MIN_WORDS_PER_CONTENT } from "./content.service";
import { chatCompletion, extractJson } from "./llm.service";

export interface GenerateQuizInput {
  /** 主题（弱相关：题干场景围绕主题） */
  topic: string;
  level: "CET4" | "CET6";
  wordCount?: number;
  targetDuration?: number;
}

/** LLM 输出结构：只出题干与解析（选项/答案由代码构造） */
const quizOutputSchema = z.object({
  title: z.string().min(1).max(60),
  questions: z
    .array(
      z.object({
        word: z.string().min(1),
        explanation: z.string().min(4),
      }),
    )
    .min(1)
    .max(20),
});

function makeQuizId(): string {
  return `cnt_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}_${randomBytes(3).toString("hex")}`;
}

/** 洗牌（Fisher-Yates），返回新数组 */
function shuffle<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** 代码构造选项：正确项=词库释义原文；干扰项=同批其他词的释义（去重，不足补占位） */
function buildOptions(
  meaning: string,
  distractors: string[],
): { options: string[]; correctIndex: number } {
  const pool = [...new Set(distractors.filter((d) => d !== meaning))];
  const options = shuffle([meaning, ...pool.slice(0, 3)]);
  while (options.length < 4) options.push("以上都不对");
  return { options, correctIndex: options.indexOf(meaning) };
}

/** 生成 quiz 内容（ContentDTO + 审计档案） */
export async function generateQuizContent(
  input: GenerateQuizInput,
): Promise<ContentDTO & { audit: GenerationAudit }> {
  const want = Math.min(input.wordCount ?? 8, MAX_WORDS_PER_CONTENT);
  const { words: picked } = await randomWords(input.level, want, db);
  if (picked.length < MIN_WORDS_PER_CONTENT) {
    throw new Error(
      `词库「${input.level}」有效词不足 ${MIN_WORDS_PER_CONTENT} 个（当前 ${picked.length}），无法出题`,
    );
  }
  const wordMap = new Map(picked.map((w) => [w.word.toLowerCase(), w.meaning]));

  const attempts: GenerationAudit["process"]["attempts"] = [];
  let lastFeedback = "（未生成）";
  for (let attempt = 0; attempt < 3; attempt++) {
    const prompt = [
      "你是英语学习内容创作者。为以下四六级单词设计选择题的题干与解析（围绕用户主题编写题干场景）。",
      `主题：${input.topic}`,
      `单词及释义：\n${picked.map((w) => `${w.word}（${w.meaning}）`).join("\n")}`,
      "要求：",
      "1. 每个单词一项：word（必须来自列表）、explanation（中文解析，说明该词含义，30 字以内；题干由系统自动生成「X 的意思是？」）",
      "2. 题目 word 覆盖列表全部单词",
      "3. 标题为主题式：点明主题+学习内容，不超过 20 字",
      "4. 只输出一个 JSON 对象，不要任何其他文字、不要 markdown 围栏",
      '5. 严格按格式：{"title":"校园英语：词汇选择题","questions":[{"word":"resolve","explanation":"resolve 意为“决定、决意”。"}]}',
      lastFeedback === "（未生成）" ? "" : `\n上次生成的错误（本次必须修正）：${lastFeedback}`,
    ].join("\n");

    try {
      const raw = await chatCompletion([{ role: "user", content: prompt }]);
      const parsed = quizOutputSchema.safeParse(extractJson<unknown>(raw));
      if (!parsed.success) {
        lastFeedback = "输出不是合法的 JSON（必须只输出一个 JSON 对象，且题目结构完整）";
        attempts.push({ prompt, result: "rejected", reason: lastFeedback, injectedWords: [] });
        continue;
      }
      // 校验：word ∈ 词表 + 题干/解析非空
      const valid = parsed.data.questions.filter((q) => wordMap.has(q.word.toLowerCase()));
      const dropped = parsed.data.questions.length - valid.length;
      if (valid.length < MIN_WORDS_PER_CONTENT || dropped > 0) {
        lastFeedback = `题目问题：${valid.length} 道有效（要求至少 ${MIN_WORDS_PER_CONTENT} 道）；${dropped} 道的 word 不在给定单词列表中。请只使用列表中的单词。`;
        attempts.push({ prompt, result: "rejected", reason: lastFeedback, injectedWords: [] });
        logger.warn({ reason: lastFeedback, attempt: attempt + 1 }, "quiz rejected");
        continue;
      }
      attempts.push({
        prompt,
        result: "accepted",
        injectedWords: valid.map((q) => q.word.toLowerCase()),
      });

      const now = new Date().toISOString();
      // 干扰项池：同批其他词的词库释义
      const distractors = picked.map((w) => w.meaning);
      const content: QuizItem[] = valid.map((q) => {
        const meaning = wordMap.get(q.word.toLowerCase()) ?? "";
        const { options, correctIndex } = buildOptions(
          meaning,
          distractors.filter((d) => d !== meaning),
        );
        return {
          // 题干由代码构造（保证含目标单词，LLM 自由发挥会丢词）
          stem: `${q.word} 的意思是？`,
          options,
          correctIndex,
          explanation: q.explanation,
          word: { word: q.word, meaning, level: input.level },
        };
      });
      const words: WordInfo[] = valid.map((q) => ({
        word: q.word,
        meaning: wordMap.get(q.word.toLowerCase()) ?? "",
        level: input.level,
      }));
      return {
        id: makeQuizId(),
        template: "quiz",
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
            template: "quiz",
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
      logger.warn({ attempt: attempt + 1 }, "quiz generate retry");
    }
  }
  throw new Error(`选择题生成未通过验收：${lastFeedback}`);
}
