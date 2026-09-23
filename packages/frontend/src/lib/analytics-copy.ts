/**
 * 发布管理「视频文案」提取 — ContentDTO → 可展示文案行（纯函数，无副作用）
 * 三模板各自的文案口径：scene_word 正文分段 / word_card 词条行 / quiz 题目行
 */

type Obj = Record<string, unknown>;

const asObj = (v: unknown): Obj | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : null;
const asText = (v: unknown): string => (typeof v === "string" ? v : "");

/** word_card 单卡 → 「word（pos）meaning — example」 */
function wordCardLine(item: Obj): string {
  const word = asText(item.word);
  const pos = asText(item.pos);
  const meaning = asText(item.meaning);
  const example = asText(item.example);
  const head = `${word}${pos ? `（${pos}）` : ""} ${meaning}`.trim();
  return example ? `${head} — ${example}` : head;
}

/** quiz 单题 → 「题干 → 正确项（+ 解析摘要）」 */
function quizLine(item: Obj): string {
  const stem = asText(item.stem);
  const options = Array.isArray(item.options) ? item.options.map(asText) : [];
  const idx = Number(item.correctIndex ?? -1);
  const answer =
    idx >= 0 && idx < options.length ? `${String.fromCharCode(65 + idx)}. ${options[idx]}` : "";
  const explanation = asText(item.explanation);
  const answerText = answer ? `答案：${answer}` : "";
  return [stem, answerText, explanation].filter(Boolean).join(" ｜ ");
}

/** 模板 + content 数组 → 文案行（未知结构回空，渲染层显示占位） */
export function buildCopyLines(template: string, content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  if (template === "word_card") {
    return content
      .map(asObj)
      .filter((x): x is Obj => x !== null)
      .map(wordCardLine);
  }
  if (template === "quiz") {
    return content
      .map(asObj)
      .filter((x): x is Obj => x !== null)
      .map(quizLine);
  }
  return content.map((seg) => asText(asObj(seg)?.text)).filter((line) => line.length > 0);
}
