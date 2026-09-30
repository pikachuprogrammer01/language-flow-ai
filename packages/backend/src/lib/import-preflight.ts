/**
 * STEP 4 Preflight 十项校验（纯函数，零 DB——service 组装快照后调用）
 * 阻断级（blocking）：③重复导入 ④未处理 CONFLICT ⑩批次重复提交
 * 其余按 warning 分级；任何 blocking 未清零 → 不允许提交。
 */

export type PreflightLevel = "pass" | "warning" | "blocking";

export interface PreflightCheckResult {
  id: number;
  name: string;
  level: PreflightLevel;
  message: string;
  rowIds: number[];
}

export interface PreflightRowInput {
  rowId: number;
  rowNumber: number;
  matchStatus:
    | "unique_match"
    | "conflict"
    | "unmatched"
    | "account_day_level"
    | "confirmed"
    | "ignored";
  granularity: "work_level_strong" | "work_level_weak" | "account_day_level";
  account: string | null;
  /** 行平台（未经映射的原始值） */
  platform: string | null;
  /** 指标列原始值（列名→值），用于必填/非法数值检查 */
  metricRaws: Record<string, unknown>;
  /** 导入侧发布时间 epoch（解析失败为 null） */
  importTimeEpoch: number | null;
  /** confirmed 行的归属类型（作品级/账号级）；非 confirmed 行缺省 */
  attributionKind?: "video" | "account_day";
  /** confirmed 作品行的目标视频信息 */
  confirmed?: {
    videoId: string;
    videoPlatform: string;
    videoPublishEpoch: number | null;
  };
}

export interface PreflightInput {
  batchId: string;
  fileHash: string;
  /** ③ 同 fileHash 是否已有其他 committed 批次 */
  committedSameHash: boolean;
  /** ⑩ 本批次是否已 committed */
  alreadyCommitted: boolean;
  /** 行账号 → 系统账号映射（⑤用） */
  accountMapping: Record<string, string>;
  nowEpoch: number;
  rows: PreflightRowInput[];
}

export interface PreflightCounts {
  workLevel: number;
  accountDayLevel: number;
  ignored: number;
  external: number;
  pendingUnique: number;
  pendingConflict: number;
  pendingUnmatched: number;
}

export interface PreflightReport {
  pass: boolean;
  checks: PreflightCheckResult[];
  counts: PreflightCounts;
}

function check(
  id: number,
  name: string,
  level: PreflightLevel,
  message: string,
  rowIds: number[] = [],
): PreflightCheckResult {
  return { id, name, level, message, rowIds };
}

/** ① confirmed 行归属完整性：作品级行必须有唯一 video；② 多行撞同一 video 提示异常 */
function checkAttribution(rows: readonly PreflightRowInput[]): PreflightCheckResult[] {
  const confirmedRows = rows.filter((r) => r.matchStatus === "confirmed");
  const videoRows = confirmedRows.filter((r) => r.attributionKind === "video");
  const noVideo = videoRows.filter((r) => r.confirmed === undefined).map((r) => r.rowId);
  const byVideo = new Map<string, number[]>();
  for (const r of videoRows) {
    if (!r.confirmed) continue;
    const list = byVideo.get(r.confirmed.videoId) ?? [];
    list.push(r.rowId);
    byVideo.set(r.confirmed.videoId, list);
  }
  const dup = [...byVideo.entries()].filter(([, ids]) => ids.length > 1);
  const dupIds = dup.flatMap(([, ids]) => ids);
  return [
    check(
      1,
      "单行多视频",
      noVideo.length > 0 ? "blocking" : "pass",
      noVideo.length > 0 ? `${noVideo.length} 行确认归属缺少目标视频` : "每行归属唯一",
      noVideo,
    ),
    check(
      2,
      "多行关联同一视频",
      dupIds.length > 0 ? "warning" : "pass",
      dupIds.length > 0
        ? `${dup.length} 个视频被 ${dupIds.length} 行重复关联，请确认是否重复导入`
        : "无重复关联",
      dupIds,
    ),
  ];
}

/** ④⑩ + 未处理状态盘点 */
function checkPending(input: PreflightInput, counts: PreflightCounts): PreflightCheckResult[] {
  const conflictIds = input.rows.filter((r) => r.matchStatus === "conflict").map((r) => r.rowId);
  const out = [
    check(
      3,
      "重复导入",
      input.committedSameHash ? "blocking" : "pass",
      input.committedSameHash
        ? "相同文件（hash 一致）已有提交成功的批次，禁止重复入库；如确属新数据请重新导出"
        : "未发现同文件已提交批次",
    ),
    check(
      4,
      "未处理 CONFLICT",
      counts.pendingConflict > 0 ? "blocking" : "pass",
      counts.pendingConflict > 0
        ? `仍有 ${counts.pendingConflict} 行冲突未裁决（选择视频/外部/账号级/忽略四选一）`
        : "冲突已全部裁决",
      conflictIds,
    ),
    check(
      10,
      "批次重复提交",
      input.alreadyCommitted ? "blocking" : "pass",
      input.alreadyCommitted ? "本批次已提交落库，禁止重复提交" : "本批次尚未提交",
    ),
  ];
  return out;
}

/** ⑤⑥⑦ 账号/平台/时间一致性在 runPreflightChecks 内联实现（warning 级，由操作者判断） */

function hasAccount(account: string, mapping: Record<string, string>): boolean {
  return Object.prototype.hasOwnProperty.call(mapping, account);
}

/** ⑧⑨ 指标必填与非法数值（复用 coerce 口径由 service 预处理为 metricRaws；此处按可解析判定） */
function checkMetrics(input: PreflightInput): PreflightCheckResult[] {
  const missingViews: number[] = [];
  const illegal: number[] = [];
  for (const r of input.rows) {
    if (r.matchStatus === "ignored") continue; // 忽略行不检查指标
    const views = findMetric(r, /播放量|播放数|views?|play/i);
    if (views === undefined) missingViews.push(r.rowId);
    for (const raw of Object.values(r.metricRaws)) {
      if (raw === undefined || raw === null || String(raw).trim() === "") continue;
      const n = Number(String(raw).replace(/[,，\s%]/g, ""));
      if (Number.isNaN(n) || n < 0) illegal.push(r.rowId);
    }
  }
  return [
    check(
      8,
      "必填指标缺失（播放量）",
      missingViews.length > 0 ? "warning" : "pass",
      missingViews.length > 0
        ? `${missingViews.length} 行无播放量，将按跳过字段逐行记录`
        : "播放量齐备",
      [...new Set(missingViews)],
    ),
    check(
      9,
      "非法数值",
      illegal.length > 0 ? "blocking" : "pass",
      illegal.length > 0 ? `${illegal.length} 行存在负数/非数值指标，需修正或忽略该行` : "数值合法",
      [...new Set(illegal)],
    ),
  ];
}

function findMetric(row: PreflightRowInput, pattern: RegExp): unknown {
  for (const [header, value] of Object.entries(row.metricRaws)) {
    if (pattern.test(header)) return value;
  }
  return undefined;
}

function summarizeCounts(rows: readonly PreflightRowInput[]): PreflightCounts {
  const counts: PreflightCounts = {
    workLevel: 0,
    accountDayLevel: 0,
    ignored: 0,
    external: 0,
    pendingUnique: 0,
    pendingConflict: 0,
    pendingUnmatched: 0,
  };
  for (const r of rows) {
    if (r.matchStatus === "confirmed") {
      if (r.attributionKind === "account_day") counts.accountDayLevel += 1;
      else counts.workLevel += 1;
    } else if (r.matchStatus === "ignored") {
      counts.ignored += 1;
    } else if (r.matchStatus === "unique_match") {
      counts.pendingUnique += 1;
    } else if (r.matchStatus === "conflict") {
      counts.pendingConflict += 1;
    } else if (r.matchStatus === "unmatched") {
      counts.pendingUnmatched += 1;
    } else {
      counts.accountDayLevel += 1; // account_day_level 未处理也计入待保存
    }
  }
  return counts;
}

/** 执行十项检查（①②④⑤⑥⑧⑨⑩），返回报告与四类计数 */
export function runPreflightChecks(input: PreflightInput): PreflightReport {
  const counts = summarizeCounts(input.rows);
  const accountUnmapped = input.rows
    .filter(
      (r) => r.account !== null && r.account !== "" && !hasAccount(r.account, input.accountMapping),
    )
    .map((r) => r.rowId);
  const platformMismatch = input.rows
    .filter(
      (r) =>
        r.confirmed !== undefined &&
        r.platform !== null &&
        r.platform !== "" &&
        r.confirmed.videoPlatform !== r.platform,
    )
    .map((r) => r.rowId);
  const timeAbnormal = input.rows
    .filter((r) => {
      if (r.importTimeEpoch === null) return false;
      if (r.importTimeEpoch > input.nowEpoch + 24 * 3600_000) return true;
      const vpe = r.confirmed?.videoPublishEpoch;
      return vpe !== undefined && vpe !== null && Math.abs(r.importTimeEpoch - vpe) > 24 * 3600_000;
    })
    .map((r) => r.rowId);

  const checks: PreflightCheckResult[] = [
    ...checkAttribution(input.rows),
    ...checkPending(input, counts),
    check(
      5,
      "账号一致性",
      accountUnmapped.length > 0 ? "warning" : "pass",
      accountUnmapped.length > 0
        ? `${accountUnmapped.length} 行账号未在 STEP2 账号映射中登记，请确认账号归属`
        : "行账号均已映射",
      accountUnmapped,
    ),
    check(
      6,
      "平台一致性",
      platformMismatch.length > 0 ? "warning" : "pass",
      platformMismatch.length > 0
        ? `${platformMismatch.length} 行平台与所归属视频的平台不一致（经映射后），请人工复核`
        : "平台一致",
      platformMismatch,
    ),
    check(
      7,
      "发布时间异常",
      timeAbnormal.length > 0 ? "warning" : "pass",
      timeAbnormal.length > 0
        ? `${timeAbnormal.length} 行发布时间为未来时间或与系统发布时间差超 24h`
        : "发布时间正常",
      timeAbnormal,
    ),
    ...checkMetrics(input),
  ];

  const pass = !checks.some((c) => c.level === "blocking");
  return { pass, checks, counts };
}
