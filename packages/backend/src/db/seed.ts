/**
 * 词库 seed 脚本（docs/09 §五）
 * 运行：DATABASE_URL="mysql://dev:dev@localhost:3306/language_flow" pnpm --filter backend db:seed
 * 行为：读 seed-data/cet_words.csv → 校验 → 全量重灌 cet_words（幂等，可重复执行）
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../lib/logger";
import { db } from "./index";
import { cetWords } from "./schema";

type SeedLevel = "CET4" | "CET6";

interface SeedRow {
  word: string;
  meaning: string;
  level: SeedLevel;
  frequency: number;
}

// CSV 行解析（RFC 4180 子集：支持双引号包裹字段与 "" 转义）
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

async function main(): Promise<void> {
  const csvPath = join(import.meta.dirname, "../../seed-data/cet_words.csv");
  // 去除 CRLF 行尾（python csv.writer 默认 \r\n）
  const lines = (await readFile(csvPath, "utf-8"))
    .replace(/\r/g, "")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  lines.shift(); // 表头

  const rows: SeedRow[] = [];
  let skipped = 0;
  for (const line of lines) {
    const [word, meaning, level, frequency] = parseCsvLine(line);
    if (!word || !meaning || (level !== "CET4" && level !== "CET6")) {
      skipped++;
      continue;
    }
    rows.push({
      word,
      meaning,
      level: level as SeedLevel,
      frequency: frequency ? Number.parseFloat(frequency) : 0,
    });
  }

  // 全量重灌（幂等）
  await db.delete(cetWords);
  for (let i = 0; i < rows.length; i += 500) {
    await db.insert(cetWords).values(rows.slice(i, i + 500));
  }

  logger.info({ imported: rows.length, skipped, total: rows.length }, "seed completed");
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "seed failed");
  process.exit(1);
});
