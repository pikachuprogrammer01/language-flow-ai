/**
 * Creator Import 前端纯函数（粘贴表格解析 + 字段自动预匹配 + 导入载荷组装）
 * 视图层只排版，不在此写业务判断之外的逻辑；数值清洗与合法性校验一律由后端 mapImportRow 收口
 * （需求 §二十四：派生与口径计算后端统一；此处只做「列→指标」映射建议）
 */

import type { MetricCatalogEntry } from "../api/client";

export interface ParsedTable {
  /** 分隔符（诊断展示用；xlsx 文件导入固定标 xlsx） */
  delimiter: "\\t" | "," | " " | "xlsx";
  headers: string[];
  /** 数据行（与 headers 等宽对齐，缺列补空串） */
  rows: string[][];
}

/**
 * 解析粘贴的表格文本（创作者后台复制 → 制表符；导出 CSV → 逗号；兜底多空格对齐）
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
  if (head.includes("\t")) {
    delimiter = "\\t";
    splitter = (line) => line.split("\t");
  } else if (head.includes(",")) {
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
  const headers = split(lines[0]);
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

/** 常见导出列名 → canonical 指标名 的预匹配别名（目录 label 精确命中优先，这里只是补充） */
export const METRIC_ALIASES: Record<string, string> = {
  播放数: "play_count",
  累计播放量: "play_count",
  播放次数: "play_count",
  点赞数: "like_count",
  评论数: "comment_count",
  分享数: "share_count",
  转发量: "share_count",
  收藏数: "collect_count",
  平均播放时长: "avg_watch_time",
  人均播放时长: "avg_watch_time",
  主页访问人数: "profile_visit_count",
  新增粉丝数: "new_fan_count",
  粉丝关注数: "new_fan_count",
};

/**
 * 为每个表头列建议 canonical 指标（只允许 importable 目录项）：
 * 目录 label 精确 → 别名表 → 目录 label 互相包含；都不中就 null（不导入）。
 */
export function autoMatchColumns(
  headers: readonly string[],
  catalog: readonly MetricCatalogEntry[],
): (string | null)[] {
  const importable = catalog.filter((m) => m.importable);
  const byLabel = new Map(importable.map((m) => [m.label, m.name]));
  return headers.map((raw) => {
    const header = raw.trim();
    const exact = byLabel.get(header);
    if (exact) return exact;
    const alias = METRIC_ALIASES[header];
    if (alias && importable.some((m) => m.name === alias)) return alias;
    const fuzzy = importable.find((m) => header.includes(m.label) || m.label.includes(header));
    return fuzzy?.name ?? null;
  });
}

/** 列映射：列下标 → canonical 指标名（null = 不导入该列） */
export type ColumnMapping = (string | null)[];

export interface ImportPayloadRow {
  match: { platformVideoId?: string; recordId?: string };
  values: Record<string, number | string | null>;
}

/**
 * 组装后端 /import 载荷的 rows：
 * - matchColumn 指定「作品 ID 所在列」（platformVideoId 匹配，禁标题模糊匹配）
 * - values 的键用原始表头列名（外部列名不写死，由后端 metricMapping 翻译）
 * - 数字形态的字符串转 number，其余原样透传（占位符/百分号清洗在后端做，保持单一口径）
 */
export function buildImportRows(
  table: ParsedTable,
  matchColumn: number,
  mapping: ColumnMapping,
): ImportPayloadRow[] {
  return table.rows.map((cells) => {
    const rawId = (cells[matchColumn] ?? "").trim();
    const values: Record<string, number | string | null> = {};
    table.headers.forEach((header, i) => {
      if (mapping[i] === null) return;
      const cell = (cells[i] ?? "").trim();
      if (cell === "") return;
      const numeric = Number(cell.replace(/,/g, ""));
      values[header] = Number.isNaN(numeric) ? cell : numeric;
    });
    return { match: { platformVideoId: rawId }, values };
  });
}

/** metricMapping（外部列→canonical）：只带已映射列 */
export function buildMetricMapping(
  headers: readonly string[],
  mapping: ColumnMapping,
): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((header, i) => {
    const metric = mapping[i];
    if (metric !== null) out[header.trim()] = metric;
  });
  return out;
}

/** 组装结果里被映射列数（用于「至少一个映射」的提交前校验提示） */
export function mappedCount(mapping: ColumnMapping): number {
  return mapping.filter((m) => m !== null).length;
}

// ── 账号日汇总：字段预匹配 + 日期归一 + 按日匹配裁决引擎（导入向导第③步） ──

/** 创作者后台「全量指标」导出列名 → 账号日字段（真实导出表头，目录 label 命中优先） */
export const CREATOR_DAILY_ALIASES: Record<string, string> = {
  总播放量: "playIncrement",
  播放量: "playIncrement",
  总点赞量: "likeIncrement",
  点赞量: "likeIncrement",
  总评论量: "commentIncrement",
  评论量: "commentIncrement",
  总分享量: "shareIncrement",
  分享量: "shareIncrement",
  "5秒完播率": "watchRate5s",
  "2秒跳出率": "bounceRate2s",
  封面点击率: "coverClickRate",
  平均播放时长: "avgWatchTime",
  人均播放时长: "avgWatchTime",
  投稿量: "postCount",
  发布量: "postCount",
  主页访问数: "profileUV",
  主页访问人数: "profileUV",
  新增粉丝: "newFans",
  粉丝增量: "newFans",
  粉丝总数: "totalFans",
  总粉丝数: "totalFans",
};

/** 账号日列预匹配（目录 label 精确 → 别名表；不中 null） */
export function autoMatchCreatorDaily(
  headers: readonly string[],
  fields: readonly { name: string; label: string }[],
): ColumnMapping {
  const byLabel = new Map(fields.map((f) => [f.label, f.name]));
  const known = new Set(fields.map((f) => f.name));
  return headers.map((raw) => {
    const header = raw.trim();
    const exact = byLabel.get(header);
    if (exact) return exact;
    const alias = CREATOR_DAILY_ALIASES[header];
    if (alias && known.has(alias)) return alias;
    return null;
  });
}

/**
 * 日期单元格归一 → YYYY-MM-DD（仅按年月日匹配，不做时分秒精确对齐）
 * 接受：2026-09-17 / 2026/9/17 / 2026.09.17 / Excel 序列日期字符串；不中 null
 */
export function normalizeDateCell(raw: string): string | null {
  const trimmed = raw.trim();
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(trimmed);
  if (!m) return null;
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${m[1]}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** 发布记录归日键（发布时间优先，缺失回退创建时间的日期部分） */
export function recordDateKey(publishTime: string | null, createdAt: string): string {
  const source = publishTime ?? createdAt;
  return source.slice(0, 10);
}

export interface MatchCandidate {
  recordId: string;
  label: string;
}

export type RowMatchStatus = "unique" | "ambiguous" | "none";

export interface RowMatchVerdict {
  status: RowMatchStatus;
  candidates: MatchCandidate[];
  /** 仅 unique 时有值；ambiguous/none 为 null，等待操作者裁决 */
  suggestedRecordId: string | null;
  /** 条数与设置不符等提醒（不阻断，由操作者判断） */
  warning: string | null;
}

/**
 * 按日匹配判定（需求：自动匹配 + 人工确认，系统绝不拆数）：
 * - 当日 1 条且设置=1 → unique（预选该作品）
 * - 当日多条 → ambiguous（候选列出必选其一或改仅账号级；多于一天条数设置时额外提醒）
 * - 当日 0 条 → none（默认仅账号级，可手动指派）；设置>1 而当日仅 1 条 → unique + 条数不符警告
 */
export function matchRowByDate(
  candidates: readonly MatchCandidate[],
  expectedPerDay: number,
): RowMatchVerdict {
  if (candidates.length === 0) {
    return {
      status: "none",
      candidates: [],
      suggestedRecordId: null,
      warning: `当日无发布记录（预期每天 ${expectedPerDay} 条），默认仅记账号级`,
    };
  }
  if (candidates.length === 1) {
    const warning =
      expectedPerDay > 1 ? `当日仅 1 条发布，少于一天的条数设置（${expectedPerDay}）` : null;
    return {
      status: "unique",
      candidates: [...candidates],
      suggestedRecordId: candidates[0].recordId,
      warning,
    };
  }
  const warning =
    candidates.length > expectedPerDay
      ? `当日 ${candidates.length} 条发布，超过一天的条数设置（${expectedPerDay}），请人工裁决归属`
      : "当日多条发布，账号日数据不自动拆数，请人工裁决归属";
  return { status: "ambiguous", candidates: [...candidates], suggestedRecordId: null, warning };
}

/** 表类型探测：有作品 ID 列 → 逐视频；有日期列（表头含日期/首列值能归一）→ 账号日 */
export function detectTableKind(table: ParsedTable): "video" | "creator-daily" | null {
  const hasIdCol = table.headers.some((h) => /作品\s*ID|视频ID|item_id|记录ID/i.test(h.trim()));
  const hasDateCol = table.headers.some((h) => /日期|统计时间|发布时间/i.test(h.trim()));
  if (hasIdCol && !hasDateCol) return "video";
  if (hasDateCol && !hasIdCol) return "creator-daily";
  if (hasIdCol && hasDateCol) return "video";
  // 表头无明示：首列值能归一为日期 → 账号日
  const firstCol = table.rows[0]?.[0];
  if (firstCol !== undefined && normalizeDateCell(firstCol) !== null) return "creator-daily";
  return null;
}

/**
 * xlsx 工作表二维数组 → ParsedTable（SheetJS sheet_to_json header:1 输出）
 * 单元格归一：Date → YYYY-MM-DD；数字/文本 → 去尾空格字符串（后端统一清洗）
 */
export function sheetToParsedTable(
  matrix: unknown[][],
  dateCells: (cell: unknown) => string | null,
): ParsedTable | null {
  const rows = matrix
    .map((line) =>
      line.map((cell) => {
        const asDate = dateCells(cell);
        if (asDate !== null) return asDate;
        if (cell === null || cell === undefined) return "";
        return String(cell).trim();
      }),
    )
    .filter((line) => line.some((c) => c !== ""));
  if (rows.length < 2) return null;
  const headers = rows[0] ?? [];
  if (headers.length < 2) return null;
  const width = headers.length;
  const body = rows
    .slice(1)
    .map((line) => {
      const padded = [...line];
      while (padded.length < width) padded.push("");
      return padded.slice(0, width);
    })
    .filter((line) => line.some((c) => c !== ""));
  if (body.length === 0) return null;
  return { delimiter: "xlsx", headers, rows: body };
}
