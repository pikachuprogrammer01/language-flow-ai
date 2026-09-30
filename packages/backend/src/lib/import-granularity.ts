/**
 * 导入数据字段识别 + 数据粒度判定（STEP 1 核心，纯函数零副作用）
 * 三态判定（已确认设计）：
 *   work_level_strong   —— 存在作品 ID / work_url 列且非空占比 ≥ 90%
 *   work_level_weak     —— 有作品维度（ID/URL/标题/发布时间）但无强唯一标识
 *   account_day_level   —— 只有 date + account + 指标，无任何作品维度（禁止进入作品级匹配）
 * 判定结果必须携带可解释 evidence，UI 原样展示，禁止黑盒结论。
 */

export const IMPORT_DATA_GRANULARITY_ENUM = [
  "work_level_strong",
  "work_level_weak",
  "account_day_level",
] as const;

export type ImportDataGranularity = (typeof IMPORT_DATA_GRANULARITY_ENUM)[number];

/** 可识别的列角色（10 个需求角色 + date/duration 辅助角色 + 合集导出扩展角色 2026-09-28 用户裁决） */
export const IMPORT_FIELD_ROLES = [
  "platform_work_id",
  "work_url",
  "account",
  "publish_time",
  "date",
  "title",
  "views",
  "likes",
  "comments",
  "shares",
  "completion_rate",
  "duration",
  // ── 合集导出扩展（抖音作品列表导出列） ──
  "watch_rate_5s", // 5s完播率（必须排在 completion_rate 前匹配）
  "bounce_rate_2s", // 2s跳出率
  "avg_watch_time", // 平均播放时长
  "collect_count", // 收藏量
  "profile_visit_count", // 主页访问量
  "fans_increment", // 粉丝增量
  "cover_click_rate", // 封面点击率（无作品级 canonical，提交时诚实跳过）
  "genre", // 体裁（平台元信息，保留展示不落指标）
  "review_status", // 审核状态（同上）
] as const;

export type ImportFieldRole = (typeof IMPORT_FIELD_ROLES)[number];

export interface FieldDetectionEntry {
  /** 列下标（0-based） */
  col: number;
  header: string;
  /** 识别出的角色；null = 未识别（默认不导入） */
  role: ImportFieldRole | null;
  /** 首行示例值（UI 展示） */
  sample: string;
}

/** 角色识别模式（按序匹配，先强后弱、先特指后泛指；全部大小写不敏感） */
const ROLE_PATTERNS: ReadonlyArray<readonly [ImportFieldRole, RegExp]> = [
  ["platform_work_id", /作品\s*id|视频\s*id|item_?id|^vid$|作品编号|记录\s*id/i],
  ["work_url", /作品链接|视频链接|分享链接|url|链接/i],
  ["publish_time", /发布时间|上线时间|publish_?time/i],
  ["watch_rate_5s", /5\s*[sS秒]?\s*完播/i],
  ["bounce_rate_2s", /2\s*[sS秒]?\s*跳出/i],
  ["avg_watch_time", /平均播放时长|人均播放时长/i],
  ["cover_click_rate", /封面点击率/i],
  ["completion_rate", /完播率|完成率/i],
  ["date", /统计日期|数据日期|发布日期|^日期$|统计时间|日期/i],
  ["account", /账号|账户|发布者|作者|昵称|account/i],
  ["title", /标题|作品名称|视频名称|作品内容|title/i],
  ["duration", /^时长$|时长|duration/i],
  ["collect_count", /收藏/i],
  ["profile_visit_count", /主页访问/i],
  ["fans_increment", /粉丝增量|新增粉丝|粉丝关注/i],
  ["genre", /体裁|内容类型/i],
  ["review_status", /审核状态|状态/i],
  ["likes", /点赞/i],
  ["comments", /评论/i],
  ["shares", /分享|转发/i],
  ["views", /播放量|播放数|播放次数|浏览量|views?|play/i],
];

/**
 * 对每个表头列建议角色：模式表按序首个命中生效；一个角色只分配给第一个命中列
 * （同角色多列时其余列置 null，由 UI 手动改），都不中 null。
 */
export function detectFieldRoles(
  headers: readonly string[],
  firstRow: readonly string[] = [],
): FieldDetectionEntry[] {
  const usedRoles = new Set<ImportFieldRole>();
  return headers.map((header, col) => {
    const trimmed = header.trim();
    let role: ImportFieldRole | null = null;
    for (const [candidate, pattern] of ROLE_PATTERNS) {
      if (usedRoles.has(candidate)) continue;
      if (pattern.test(trimmed)) {
        role = candidate;
        break;
      }
    }
    if (role !== null) usedRoles.add(role);
    return { col, header: trimmed, role, sample: (firstRow[col] ?? "").trim() };
  });
}

/** 强唯一标识非空占比阈值（已确认设计：≥ 90% 判 strong） */
export const STRONG_ID_RATIO_THRESHOLD = 0.9;

export interface GranularityEvidence {
  /** 判定结论的一句话依据（UI 直接展示） */
  note: string;
  idColumn: string | null;
  urlColumn: string | null;
  /** 作品 ID 列非空行占比（无该列 = 0） */
  idNonEmptyRatio: number;
  /** work_url 列非空行占比（无该列 = 0） */
  urlNonEmptyRatio: number;
  hasTitle: boolean;
  hasPublishTime: boolean;
  /** 是否含任何作品维度（ID/URL/标题/发布时间） */
  hasWorkDimension: boolean;
  /** 判定用的阈值（透明展示，不藏配置） */
  threshold: number;
}

export interface GranularityResult {
  granularity: ImportDataGranularity;
  evidence: GranularityEvidence;
}

function nonEmptyRatio(rows: readonly string[][], col: number): number {
  if (rows.length === 0 || col < 0) return 0;
  const filled = rows.filter((r) => (r[col] ?? "").trim() !== "").length;
  return filled / rows.length;
}

function roleColumn(detection: readonly FieldDetectionEntry[], role: ImportFieldRole): number {
  return detection.find((d) => d.role === role)?.col ?? -1;
}

/**
 * 数据粒度判定（STEP 1 最重要功能）。
 * 规则（保守、可解释）：
 * 1. 有作品 ID 或 work_url 列且非空占比 ≥ 0.9 → work_level_strong
 * 2. 有任一作品维度（ID/URL/标题/发布时间列存在且有值）→ work_level_weak
 * 3. 完全无作品维度（只有 date/account/指标）→ account_day_level
 * 禁止把账号日级数据推测成作品级；手动调整只允许降级（由 service 层门控）。
 */
export function determineGranularity(
  detection: readonly FieldDetectionEntry[],
  rows: readonly string[][],
): GranularityResult {
  const idCol = roleColumn(detection, "platform_work_id");
  const urlCol = roleColumn(detection, "work_url");
  const titleCol = roleColumn(detection, "title");
  const timeCol = roleColumn(detection, "publish_time");
  const idRatio = nonEmptyRatio(rows, idCol);
  const urlRatio = nonEmptyRatio(rows, urlCol);
  const hasTitle = titleCol >= 0 && nonEmptyRatio(rows, titleCol) > 0;
  const hasPublishTime = timeCol >= 0 && nonEmptyRatio(rows, timeCol) > 0;
  const hasWorkDimension = idRatio > 0 || urlRatio > 0 || hasTitle || hasPublishTime;
  const bestIdRatio = Math.max(idRatio, urlRatio);

  let granularity: ImportDataGranularity;
  let note: string;
  if (bestIdRatio >= STRONG_ID_RATIO_THRESHOLD) {
    granularity = "work_level_strong";
    note = `检测到强唯一标识列（${idRatio >= STRONG_ID_RATIO_THRESHOLD ? detection[idCol]?.header : detection[urlCol]?.header}），非空占比 ${(bestIdRatio * 100).toFixed(1)}% ≥ ${(STRONG_ID_RATIO_THRESHOLD * 100).toFixed(0)}%，可进入作品级精准匹配`;
  } else if (hasWorkDimension) {
    granularity = "work_level_weak";
    note = `存在作品维度（${[
      idRatio > 0 ? "作品 ID" : null,
      urlRatio > 0 ? "作品链接" : null,
      hasTitle ? "标题" : null,
      hasPublishTime ? "发布时间" : null,
    ]
      .filter(Boolean)
      .join(
        "、",
      )}）但缺少强唯一标识（ID/URL 非空占比 ${(bestIdRatio * 100).toFixed(1)}% < ${(STRONG_ID_RATIO_THRESHOLD * 100).toFixed(0)}%），只能弱证据匹配，结果全部需人工确认`;
  } else {
    granularity = "account_day_level";
    note =
      "仅有日期/账号/指标列，无任何作品维度（作品 ID、链接、标题、发布时间均缺失），判定为账号日汇总，无法精确归属到单条作品";
  }

  return {
    granularity,
    evidence: {
      note,
      idColumn: idCol >= 0 ? (detection[idCol]?.header ?? null) : null,
      urlColumn: urlCol >= 0 ? (detection[urlCol]?.header ?? null) : null,
      idNonEmptyRatio: round4(idRatio),
      urlNonEmptyRatio: round4(urlRatio),
      hasTitle,
      hasPublishTime,
      hasWorkDimension,
      threshold: STRONG_ID_RATIO_THRESHOLD,
    },
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
