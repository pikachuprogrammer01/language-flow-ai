/**
 * 确定性匹配引擎（STEP 2/3 核心，纯函数零副作用、零 LLM）
 * 优先级 1→5（强证据压制弱证据，高优先级命中即不再被低优先级覆盖）：
 *   1 platform_work_id_exact        —— 作品 ID 完全一致（同平台）           【强】
 *   2 work_url_id                   —— work_url 解析出平台作品 ID 后一致    【强】
 *   3 account_publish_time          —— 账号映射 + 发布时间容差内            【弱】
 *   4 account_date_title            —— 账号映射 + 同日 + 标准化标题相似≥阈值 【弱】
 *   5 account_date_title_duration   —— 方法4 基础上时长辅助收窄             【弱】
 * 状态判定（已确认设计）：
 *   恰好 1 个强证据候选 → unique_match（可一键批量确认）
 *   多候选 / 仅弱证据单候选 → conflict（系统绝不擅自选择）
 *   0 候选 → unmatched
 * 每个候选必须产出结构化 evidence，禁止只给裸分数。
 */

import type { ImportDataGranularity } from "./import-granularity";

export const IMPORT_MATCH_METHOD_ENUM = [
  "platform_work_id_exact",
  "work_url_id",
  "title_exact_plus_time",
  "account_publish_time",
  "account_date_title",
  "account_date_title_duration",
] as const;

export type ImportMatchMethod = (typeof IMPORT_MATCH_METHOD_ENUM)[number];

/** 方法优先级（数字越小越强；3 为 2026-09-28 用户裁决的双证据档：标题完全一致+时间容差内吻合+唯一命中） */
export const MATCH_METHOD_PRIORITY: Record<ImportMatchMethod, number> = {
  platform_work_id_exact: 1,
  work_url_id: 2,
  title_exact_plus_time: 3,
  account_publish_time: 4,
  account_date_title: 5,
  account_date_title_duration: 6,
};

export interface TitleNormalizationOptions {
  stripEmoji: boolean;
  stripHashtag: boolean;
  collapseWhitespace: boolean;
  toLowercase: boolean;
  fullToHalfWidth: boolean;
}

export interface ImportMatchRules {
  /** 平台账号名 → 系统账号标识（publish_records 无账号维度，账号证据=行账号经映射识别） */
  accountMapping: Record<string, string>;
  /** 导出平台名 → publish_records.platform */
  platformMapping: Record<string, string>;
  /** 导出时间所在时区偏移（分钟，默认 UTC+8 = 480） */
  timezoneOffsetMinutes: number;
  /** 发布时间容差（分钟，默认 5） */
  publishTimeToleranceMinutes: number;
  titleNormalization: TitleNormalizationOptions;
  /** 标题相似度阈值（0-1，默认 0.9） */
  titleSimilarityThreshold: number;
}

export const DEFAULT_MATCH_RULES: ImportMatchRules = {
  accountMapping: {},
  platformMapping: {},
  timezoneOffsetMinutes: 480,
  publishTimeToleranceMinutes: 5,
  titleNormalization: {
    stripEmoji: true,
    stripHashtag: true,
    collapseWhitespace: true,
    toLowercase: true,
    fullToHalfWidth: true,
  },
  titleSimilarityThreshold: 0.9,
};

/** 引擎输入行（normalized_data 的引擎视图；platform 已由 service 经批次平台回退填充） */
export interface EngineImportRow {
  rowNumber: number;
  platformWorkId: string | null;
  workUrl: string | null;
  account: string | null;
  /** 原始发布时间字符串（按 rules.timezoneOffsetMinutes 解析） */
  publishTime: string | null;
  /** 原始统计/发布日期字符串 */
  date: string | null;
  title: string | null;
  /** 视频时长（秒，可缺） */
  durationSec: number | null;
  /** 行平台（已经批次回退；引擎内再经 platformMapping 翻译） */
  platform: string | null;
}

/** 引擎输入视频（publish_records + contents 产物时长的投影） */
export interface EngineVideo {
  videoId: string;
  platform: string;
  /** 未绑定作品 ID 的记录不参与自动强匹配（防污染，仅可人工搜索绑定） */
  platformVideoId: string | null;
  publishTime: Date | null;
  title: string | null;
  durationSec: number | null;
}

export interface MatchEvidence {
  platformWorkIdExact?: boolean;
  workUrlIdExact?: boolean;
  /** 双证据交叉验证：标题标准化后完全一致（非相似度阈值，是 strict equal） */
  titleExact?: boolean;
  /** 行账号经 STEP2 账号映射识别（系统侧发布记录无账号字段，账号一致性以此口径判定）；
   * null = 行无账号列，账号证据不适用（展示层不得误标 ✗） */
  accountMapped?: boolean | null;
  mappedAccount?: string | null;
  platformMatched?: boolean;
  publishTimeDiffSeconds?: number | null;
  dateMatched?: boolean;
  titleSimilarity?: number | null;
  normalizedImportTitle?: string;
  normalizedSystemTitle?: string;
  durationDiffSeconds?: number | null;
  /** 作品 ID 缺失说明（弱证据候选的诚实提醒） */
  workIdMissing?: boolean;
}

export interface EngineCandidate {
  videoId: string;
  matchMethod: ImportMatchMethod;
  matchScore: number;
  evidence: MatchEvidence;
  rank: number;
}

export type RowEngineStatus = "unique_match" | "conflict" | "unmatched";

export interface RowMatchResult {
  rowNumber: number;
  status: RowEngineStatus;
  candidates: EngineCandidate[];
}

// ── 工具函数 ──

/** 全角 → 半角（ASCII 区段 + 空格） */
export function toHalfWidth(text: string): string {
  return text
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, " ");
}

/** 标题标准化（按规则开关逐项处理，确定性） */
export function normalizeTitle(raw: string, options: TitleNormalizationOptions): string {
  let s = raw;
  if (options.fullToHalfWidth) s = toHalfWidth(s);
  if (options.stripHashtag) s = s.replace(/#[^#\s]+#?/g, " ");
  if (options.stripEmoji)
    s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]|\u{FE0F}/gu, " ");
  // 统一去除常见分隔标点（中英文都覆盖，含全角转半角后的 : ; ! ?），避免标点拉低相似度
  s = s.replace(/[·，。！？；：、,.:!?~～\-—_()（）\[\]【】"'“”‘’]/g, " ");
  if (options.collapseWhitespace) s = s.replace(/\s+/g, " ");
  s = s.trim();
  if (options.toLowercase) s = s.toLowerCase();
  return s;
}

/** Levenshtein 编辑距离（标题长度有限，O(n·m) 双行滚动数组） */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr.push(Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost));
    }
    prev = curr;
  }
  return prev[b.length] ?? 0;
}

/**
 * 标题相似度 = 1 - 编辑距离 / max(len)，在标准化后再去除全部空白后计算
 * （标点归一会引入等价空白，不应拉低相似度；确定性公式，前端可原样解释）。
 * 标准化后任一侧为空 → 0（不猜）。
 */
export function titleSimilarity(
  importTitle: string,
  systemTitle: string,
  options: TitleNormalizationOptions,
): number {
  const a = normalizeTitle(importTitle, options).replace(/\s+/g, "");
  const b = normalizeTitle(systemTitle, options).replace(/\s+/g, "");
  if (a === "" || b === "") return 0;
  const maxLen = Math.max(a.length, b.length);
  return Math.round((1 - editDistance(a, b) / maxLen) * 10000) / 10000;
}

/** 按平台从 work_url 解析作品 ID；解析不出返回 null（不猜） */
export function extractWorkIdFromUrl(url: string, platform: string | null): string | null {
  const p = (platform ?? "").toLowerCase();
  const patterns: RegExp[] = [];
  if (p.includes("抖音") || p.includes("douyin")) {
    patterns.push(/\/video\/(\d+)/, /\/share\/video\/(\d+)/);
  } else if (p.includes("快手") || p.includes("kuaishou")) {
    patterns.push(
      /\/short-video\/([A-Za-z0-9_-]+)/,
      /\/photo\/([A-Za-z0-9_-]+)/,
      /\/fw_video\/(\d+)/,
    );
  } else if (p.includes("视频号") || p.includes("wechat") || p.includes("channels")) {
    patterns.push(/[?&]url=([^&#\s]+)/, /\/sph\/([A-Za-z0-9]+)/);
  }
  // 通用兜底：路径末段 15 位以上纯数字（抖音 item_id 形态）
  patterns.push(/\/(\d{15,})(?:[/?&#]|$)/);
  for (const pattern of patterns) {
    const m = pattern.exec(url);
    if (m?.[1]) return m[1];
  }
  return null;
}

/** "YYYY-MM-DD HH:mm:ss" / ISO 字符串 + 时区偏移 → epoch ms；不中 null */
export function parseTimeToEpoch(raw: string, timezoneOffsetMinutes: number): number | null {
  const t = raw.trim();
  // 带显式时区（Z 或 ±hh:mm）的 ISO：Date 解析即绝对时间
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(t)) {
    const ms = Date.parse(t);
    return Number.isNaN(ms) ? null : ms;
  }
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(t);
  if (m) {
    const utc = Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6] ?? "0"),
    );
    return utc - timezoneOffsetMinutes * 60_000;
  }
  const d = normalizeDateOnly(t, timezoneOffsetMinutes);
  return d;
}

/** 仅日期字符串 → 当日 00:00（时区偏移口径）epoch ms；不中 null */
export function normalizeDateOnly(raw: string, timezoneOffsetMinutes: number): number | null {
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(raw.trim());
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - timezoneOffsetMinutes * 60_000;
}

/** epoch ms → YYYY-MM-DD（时区偏移口径） */
export function epochToDateKey(epochMs: number, timezoneOffsetMinutes: number): string {
  const shifted = new Date(epochMs + timezoneOffsetMinutes * 60_000);
  return shifted.toISOString().slice(0, 10);
}

// ── 引擎主流程 ──

function resolvePlatform(row: EngineImportRow, rules: ImportMatchRules): string | null {
  if (row.platform === null || row.platform === "") return null;
  return rules.platformMapping[row.platform] ?? row.platform;
}

function baseEvidence(row: EngineImportRow, rules: ImportMatchRules): MatchEvidence {
  const hasAccount = row.account !== null && row.account !== "";
  const mapped = hasAccount ? (rules.accountMapping[row.account ?? ""] ?? null) : null;
  return {
    // 无账号列 = 账号证据不适用（null），与「有账号但未登记」（false ✗）严格区分
    accountMapped: hasAccount ? mapped !== null : null,
    mappedAccount: mapped,
    platformMatched: true,
    workIdMissing: row.platformWorkId === null || row.platformWorkId === "",
  };
}

/** 强证据候选（方法1/2）：恰好一个才可能 unique_match */
function strongCandidates(
  row: EngineImportRow,
  videos: readonly EngineVideo[],
  rules: ImportMatchRules,
): EngineCandidate[] {
  const platform = resolvePlatform(row, rules);
  if (platform === null) return [];
  const out: EngineCandidate[] = [];
  const urlId =
    row.workUrl !== null && row.workUrl !== "" ? extractWorkIdFromUrl(row.workUrl, platform) : null;
  for (const v of videos) {
    if (v.platform !== platform || v.platformVideoId === null) continue;
    if (
      row.platformWorkId !== null &&
      row.platformWorkId !== "" &&
      v.platformVideoId === row.platformWorkId
    ) {
      out.push({
        videoId: v.videoId,
        matchMethod: "platform_work_id_exact",
        matchScore: 1,
        evidence: { ...baseEvidence(row, rules), platformWorkIdExact: true },
        rank: 0,
      });
    } else if (urlId !== null && v.platformVideoId === urlId) {
      out.push({
        videoId: v.videoId,
        matchMethod: "work_url_id",
        matchScore: 0.95,
        evidence: { ...baseEvidence(row, rules), workUrlIdExact: true },
        rank: 0,
      });
    }
  }
  return dedupeByBestMethod(out);
}

/** 弱证据候选（方法3/4/5）：无论几个一律 conflict（已确认设计） */
function weakCandidates(
  row: EngineImportRow,
  videos: readonly EngineVideo[],
  rules: ImportMatchRules,
): EngineCandidate[] {
  const platform = resolvePlatform(row, rules);
  if (platform === null) return [];
  const out: EngineCandidate[] = [];
  const rowTimeEpoch =
    row.publishTime !== null
      ? parseTimeToEpoch(row.publishTime, rules.timezoneOffsetMinutes)
      : null;
  const rowDateEpoch =
    row.date !== null ? normalizeDateOnly(row.date, rules.timezoneOffsetMinutes) : null;
  const rowDateKeySource = rowTimeEpoch ?? rowDateEpoch;
  const toleranceMs = rules.publishTimeToleranceMinutes * 60_000;

  for (const v of videos) {
    if (v.platform !== platform) continue;
    // 方法3：发布时间容差内；若标题同时完全一致 → 升级为双证据方法（用户裁决 2026-09-28：可自动入库档）
    if (rowTimeEpoch !== null && v.publishTime !== null) {
      const diffMs = Math.abs(rowTimeEpoch - v.publishTime.getTime());
      if (diffMs <= toleranceMs) {
        const titleExact = titlesStrictEqual(row.title, v.title, rules.titleNormalization);
        out.push({
          videoId: v.videoId,
          matchMethod: titleExact ? "title_exact_plus_time" : "account_publish_time",
          matchScore: titleExact ? 0.9 : 0.85,
          evidence: {
            ...baseEvidence(row, rules),
            ...(titleExact ? { titleExact: true } : {}),
            publishTimeDiffSeconds: Math.round(diffMs / 1000),
          },
          rank: 0,
        });
        continue;
      }
    }
    // 方法4/5：同日 + 标题相似（时长可核对时升级为方法5）
    if (
      rowDateKeySource !== null &&
      v.publishTime !== null &&
      row.title !== null &&
      row.title !== "" &&
      v.title !== null &&
      v.title !== ""
    ) {
      const sameDay =
        epochToDateKey(rowDateKeySource, rules.timezoneOffsetMinutes) ===
        epochToDateKey(v.publishTime.getTime(), rules.timezoneOffsetMinutes);
      if (!sameDay) continue;
      const sim = titleSimilarity(row.title, v.title, rules.titleNormalization);
      if (sim < rules.titleSimilarityThreshold) continue;
      const durationDiff =
        row.durationSec !== null && v.durationSec !== null
          ? Math.round(Math.abs(row.durationSec - v.durationSec))
          : null;
      const upgraded = durationDiff !== null && durationDiff <= DURATION_TOLERANCE_SEC;
      out.push({
        videoId: v.videoId,
        matchMethod: upgraded ? "account_date_title_duration" : "account_date_title",
        matchScore: upgraded
          ? Math.round(sim * 0.75 * 10000) / 10000
          : Math.round(sim * 0.8 * 10000) / 10000,
        evidence: {
          ...baseEvidence(row, rules),
          dateMatched: true,
          titleSimilarity: sim,
          normalizedImportTitle: normalizeTitle(row.title, rules.titleNormalization),
          normalizedSystemTitle: normalizeTitle(v.title, rules.titleNormalization),
          durationDiffSeconds: durationDiff,
        },
        rank: 0,
      });
    }
  }
  return dedupeByBestMethod(out);
}

/** 时长辅助字段核对容差（秒）：差值在此内认为时长一致，方法4 升级方法5 */
export const DURATION_TOLERANCE_SEC = 5;

/** 标题严格相等（标准化后 strict equal，非阈值比较——双证据的「完全一致」口径） */
function titlesStrictEqual(
  a: string | null,
  b: string | null,
  options: TitleNormalizationOptions,
): boolean {
  if (a === null || b === null || a === "" || b === "") return false;
  const na = normalizeTitle(a, options).replace(/\s+/g, "");
  const nb = normalizeTitle(b, options).replace(/\s+/g, "");
  return na !== "" && na === nb;
}

/** 同一 videoId 多方法命中时保留最强方法（高优先级压制低优先级） */
function dedupeByBestMethod(candidates: EngineCandidate[]): EngineCandidate[] {
  const best = new Map<string, EngineCandidate>();
  for (const c of candidates) {
    const existing = best.get(c.videoId);
    if (
      existing === undefined ||
      MATCH_METHOD_PRIORITY[c.matchMethod] < MATCH_METHOD_PRIORITY[existing.matchMethod]
    ) {
      best.set(c.videoId, c);
    }
  }
  return [...best.values()];
}

/** 单行匹配：产出候选（按优先级+分数排序并赋 rank）与系统态状态 */
export function matchSingleRow(
  row: EngineImportRow,
  videos: readonly EngineVideo[],
  rules: ImportMatchRules,
): RowMatchResult {
  const strong = strongCandidates(row, videos, rules);
  // 强证据已命中同一视频时不再叠加弱证据候选（强压制弱）；不同指向则并列展示矛盾
  const strongVideoIds = new Set(strong.map((c) => c.videoId));
  const weak = weakCandidates(row, videos, rules).filter((c) => !strongVideoIds.has(c.videoId));
  const candidates = [...strong, ...weak].sort(
    (a, b) =>
      MATCH_METHOD_PRIORITY[a.matchMethod] - MATCH_METHOD_PRIORITY[b.matchMethod] ||
      b.matchScore - a.matchScore,
  );
  candidates.forEach((c, i) => {
    c.rank = i + 1;
  });

  let status: RowEngineStatus;
  if (candidates.length === 0) {
    status = "unmatched";
  } else if (candidates.length === 1 && isAutoConfirmMethod(candidates[0].matchMethod)) {
    // 自动入库档（可一键批量确认）：强证据 ID 类 或 双证据交叉验证（用户裁决 2026-09-28）
    status = "unique_match";
  } else {
    status = "conflict";
  }
  return { rowNumber: row.rowNumber, status, candidates };
}

export function isStrongMethod(method: ImportMatchMethod): boolean {
  return MATCH_METHOD_PRIORITY[method] <= 2;
}

/** 可自动确认（unique_match 资格）：强证据或双证据；纯标题相似（即使 100%）仍必须人工确认 */
export function isAutoConfirmMethod(method: ImportMatchMethod): boolean {
  return MATCH_METHOD_PRIORITY[method] <= 3;
}

/**
 * 批次匹配入口。account_day_level 批次绝不进入本引擎的作品级匹配路径：
 * 直接返回全部行 account_day_level 终态（service 层不再产候选）。
 */
export interface BatchMatchOutput {
  granularity: ImportDataGranularity;
  results: RowMatchResult[];
}

export function matchImportRows(
  rows: readonly EngineImportRow[],
  videos: readonly EngineVideo[],
  rules: ImportMatchRules,
  granularity: ImportDataGranularity,
): BatchMatchOutput {
  if (granularity === "account_day_level") {
    return { granularity, results: [] };
  }
  return { granularity, results: rows.map((r) => matchSingleRow(r, videos, rules)) };
}

/** 预估统计（STEP2 dry-run 用）：四类计数 */
export interface MatchEstimate {
  total: number;
  expectStrongMatch: number;
  expectManualConfirm: number;
  expectUnmatched: number;
}

export function summarizeEstimate(output: BatchMatchOutput): MatchEstimate {
  const unique = output.results.filter((r) => r.status === "unique_match").length;
  const conflict = output.results.filter((r) => r.status === "conflict").length;
  const unmatched = output.results.filter((r) => r.status === "unmatched").length;
  return {
    total: output.results.length,
    expectStrongMatch: unique,
    expectManualConfirm: conflict,
    expectUnmatched: unmatched,
  };
}
