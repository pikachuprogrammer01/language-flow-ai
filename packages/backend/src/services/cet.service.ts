import type { CefrLevel } from "@ai-english/shared";
/**
 * 四六级词库服务
 * 依据：SPEC.md §5.1.1 — POST /api/cet/validate-words
 * db 实例作为参数注入，便于测试替换 mock
 */
import { and, eq, inArray } from "drizzle-orm";
import { cetWords } from "../db/schema";

// ── 返回类型（SPEC §5.1.1） ──

export interface MatchedWord {
  word: string;
  level: CefrLevel;
  meaning: string;
  frequency?: number;
}

export interface ValidationResult {
  matchedWords: MatchedWord[];
  unmatchedWords: string[];
}

// 最小查询接口：仅暴露 cet_words 查询所需方法，便于测试注入替身（无需真实 MySQL 连接）
export interface CetWordsDb {
  select(): {
    from(table: typeof cetWords): {
      where(condition: unknown): Promise<CetWordRow[]>;
    };
  };
}

export type CetWordRow = typeof cetWords.$inferSelect;

/**
 * 将候选单词与 cet_words 词库精确匹配
 * - 忽略重复词，matchedWords 保持输入顺序（与 unmatchedWords 同源排序）
 * - frequency 单位为 0~1 比例（SPEC §5.1.1 示例 0.85）
 */
export async function validateWords(
  words: string[],
  level: CefrLevel,
  dbInstance: CetWordsDb,
): Promise<ValidationResult> {
  const uniqueWords = [...new Set(words)];
  if (uniqueWords.length === 0) {
    return { matchedWords: [], unmatchedWords: [] };
  }

  const rows = await dbInstance
    .select()
    .from(cetWords)
    .where(and(eq(cetWords.level, level), inArray(cetWords.word, uniqueWords)));

  // 数据库不保证 inArray 结果顺序，按 uniqueWords 索引显式重排
  const byWord = new Map(rows.map((row) => [row.word, row]));
  const matchedWords: MatchedWord[] = uniqueWords.flatMap((word) => {
    const row = byWord.get(word);
    return row
      ? [
          {
            word: row.word,
            level: row.level,
            meaning: row.meaning,
            frequency: row.frequency ?? undefined,
          },
        ]
      : [];
  });

  const unmatchedWords = uniqueWords.filter((word) => !byWord.has(word));

  return { matchedWords, unmatchedWords };
}
