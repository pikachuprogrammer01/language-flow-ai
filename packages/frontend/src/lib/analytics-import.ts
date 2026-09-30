/**
 * Creator Import 前端解析纯函数（粘贴/CSV 文本 → 表格结构）
 * 批次 H2：旧逐行下拉框向导已删除，本文件只保留四步导入工作台复用的解析器
 * （数值清洗与合法性校验一律由后端收口，此处只做文本→矩阵的结构化）
 */

export interface ParsedTable {
  /** 分隔符（诊断展示用） */
  delimiter: "\\t" | "," | " ";
  headers: string[];
  /** 数据行（与 headers 等宽对齐，缺列补空串） */
  rows: string[][];
}

/**
 * 解析粘贴/CSV 的表格文本（创作者后台复制 → 制表符；导出 CSV → 逗号；兜底多空格对齐）
 * 首行为表头；忽略空行；引号包裹的单元格自动去引号。空文本返回 null。
 */
export function parsePastedTable(text: string): ParsedTable | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\uFEFF/, ""))
    .filter((l) => l.trim() !== "");
  if (lines.length < 2) return null;
  const head = lines[0];
  let delimiter: ParsedTable["delimiter"];
  let splitter: (line: string) => string[];
  if (head?.includes("\t")) {
    delimiter = "\\t";
    splitter = (line) => line.split("\t");
  } else if (head?.includes(",")) {
    delimiter = ",";
    splitter = (line) => line.split(",");
  } else {
    delimiter = " ";
    splitter = (line) => line.split(/\s{2,}/);
  }
  const split = (line: string): string[] =>
    splitter(line).map((cell) =>
      cell
        .trim()
        .replace(/^"([^"]*)"$/g, "$1")
        .trim(),
    );
  const headers = split(head ?? "");
  if (headers.length < 2) return null;
  const rows = lines
    .slice(1)
    .map((line) => {
      const cells = split(line);
      const padded = [...cells];
      while (padded.length < headers.length) padded.push("");
      return padded.slice(0, headers.length);
    })
    .filter((r) => r.some((c) => c !== ""));
  if (rows.length === 0) return null;
  return { delimiter, headers, rows };
}
