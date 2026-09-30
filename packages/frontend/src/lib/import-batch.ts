/**
 * 四步精准匹配导入 — 前端纯函数（视图层只排版，判定逻辑在此收口并单测）
 * 与后端 lib/import-matcher.ts evidenceSummaryOf 同口径的中文翻译（前端独立实现，
 * 详情面板按结构化 evidence 逐条渲染 ✓/✗，绝不只显示裸置信度）。
 */

import type { ImportGranularity, ImportMatchEvidence, ImportRowStatus } from "../api/client";

// ── 步骤状态机 ──

export type WizardStep = 1 | 2 | 3 | 4;

/** 后端批次状态 → 当前所处步骤（1导入数据 2匹配规则 3匹配校验 4提交落库） */
export function stepOfBatchStatus(status: string): WizardStep {
  switch (status) {
    case "draft":
      return 1;
    case "granularity_confirmed":
    case "rules_set":
      return 2;
    case "prematched":
      return 3;
    case "preflight_ok":
    case "committed":
    case "rolled_back":
      return 4;
    default:
      return 1;
  }
}

export type StepperState = "done" | "current" | "todo" | "locked";

/**
 * 步进器三态：已到达可点回（done/current），未到达锁定。
 * maxStep = 批次状态推进到的最远步骤；active = 用户当前查看的步骤。
 */
export function stepperStates(
  maxStep: WizardStep,
  active: WizardStep,
): Record<WizardStep, StepperState> {
  const build = (s: WizardStep): StepperState => {
    if (s === active) return "current";
    return s <= maxStep ? "done" : "locked";
  };
  return { 1: build(1), 2: build(2), 3: build(3), 4: build(4) };
}

/** 能否点击跳到某步骤（仅已到达过的步骤可进） */
export function canGotoStep(target: WizardStep, maxStep: WizardStep): boolean {
  return target <= maxStep;
}

// ── 数据粒度文案 ──

export interface GranularityMeta {
  label: string;
  tone: "success" | "warning" | "danger";
  headline: string;
  note: string;
}

export function granularityMeta(g: ImportGranularity): GranularityMeta {
  switch (g) {
    case "work_level_strong":
      return {
        label: "作品级 · 强唯一标识",
        tone: "success",
        headline: "可进入作品级精准匹配",
        note: "存在平台作品 ID / 可解析链接，确定性匹配后仅异常需人工处理",
      };
    case "work_level_weak":
      return {
        label: "作品级 · 缺少强标识",
        tone: "warning",
        headline: "只能弱证据匹配",
        note: "无作品 ID/链接，标题与时间等弱证据匹配的结果全部需要人工确认，系统绝不擅自归属",
      };
    case "account_day_level":
      return {
        label: "账号日汇总",
        tone: "danger",
        headline: "无法精确归属到单条作品",
        note: "本批数据只有日期+账号+指标，只能作为账号日级数据保存；禁止拆分给单个视频、禁止平均、禁止推测",
      };
  }
}

// ── 行状态 pill ──

export interface StatusPillMeta {
  label: string;
  tone: "success" | "warning" | "danger" | "info" | "neutral";
}

export function statusPillMeta(s: ImportRowStatus): StatusPillMeta {
  switch (s) {
    case "unique_match":
      return { label: "唯一匹配", tone: "success" };
    case "conflict":
      return { label: "待确认", tone: "warning" };
    case "unmatched":
      return { label: "未匹配", tone: "danger" };
    case "account_day_level":
      return { label: "账号日级", tone: "info" };
    case "confirmed":
      return { label: "已确认", tone: "success" };
    case "ignored":
      return { label: "已忽略", tone: "neutral" };
  }
}

// ── 匹配证据 checklist（结构化 evidence → ✓/✗ 人话逐条，禁止裸置信度） ──

export interface EvidenceItem {
  ok: boolean;
  text: string;
}

export function evidenceChecklist(e: ImportMatchEvidence): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  if (e.platformWorkIdExact !== undefined)
    items.push({ ok: e.platformWorkIdExact, text: "平台作品 ID 一致" });
  if (e.workUrlIdExact !== undefined)
    items.push({ ok: e.workUrlIdExact, text: "链接解析作品 ID 一致" });
  if (e.titleExact === true)
    items.push({ ok: true, text: "标题与系统记录完全一致（双证据交叉验证）" });
  // null/undefined（行无账号列）= 账号证据不适用，不渲染；仅 true/false 上屏
  if (e.accountMapped === true || e.accountMapped === false)
    items.push({
      ok: e.accountMapped,
      text: e.accountMapped ? `账号已经映射（${e.mappedAccount ?? "?"}）` : "账号未在映射表中登记",
    });
  if (e.publishTimeDiffSeconds !== undefined && e.publishTimeDiffSeconds !== null)
    items.push({ ok: true, text: `发布时间相差 ${e.publishTimeDiffSeconds} 秒` });
  if (e.dateMatched !== undefined) items.push({ ok: e.dateMatched, text: "发布日期一致" });
  if (e.titleSimilarity !== undefined && e.titleSimilarity !== null)
    items.push({
      ok: true,
      text: `标题相似度 ${(e.titleSimilarity * 100).toFixed(1)}%（编辑距离口径）`,
    });
  if (e.durationDiffSeconds !== undefined && e.durationDiffSeconds !== null)
    items.push({ ok: true, text: `时长相差 ${e.durationDiffSeconds} 秒` });
  if (e.workIdMissing === true) items.push({ ok: false, text: "作品 ID 缺失" });
  return items;
}

// ── STEP 3 统计卡与筛选 ──

export interface ReviewFilterKey {
  key: "all" | "unique_match" | "conflict" | "unmatched" | "account_day_level";
  label: string;
}

export const REVIEW_FILTERS: ReviewFilterKey[] = [
  { key: "all", label: "全部" },
  { key: "unique_match", label: "唯一匹配" },
  { key: "conflict", label: "待确认" },
  { key: "unmatched", label: "未匹配" },
  { key: "account_day_level", label: "账号日级" },
];

/** 账号日级批次：批量确认唯一匹配按钮隐藏（无作品级匹配语义） */
export function showBatchConfirmAll(g: ImportGranularity): boolean {
  return g !== "account_day_level";
}

/** 行可执行的人工动作集合（详情面板按钮渲染依据；红线：账号日级行没有 assign） */
export interface RowActions {
  confirm: boolean;
  assign: boolean;
  external: boolean;
  accountDay: boolean;
  ignore: boolean;
  reset: boolean;
}

export function rowActions(status: ImportRowStatus, decided: boolean): RowActions {
  return {
    confirm: status === "unique_match",
    assign: status === "conflict" || status === "unmatched",
    external: status === "conflict" || status === "unmatched",
    accountDay: status === "conflict" || status === "unmatched" || status === "account_day_level",
    ignore:
      status === "conflict" ||
      status === "unmatched" ||
      status === "account_day_level" ||
      status === "unique_match",
    reset: decided,
  };
}

/** 提交门控：preflight pass 且无阻断项 */
export function canCommit(report: { pass: boolean } | null): boolean {
  return report?.pass === true;
}

/** 文件大小人话 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 时长秒 → mm:ss（详情面板展示） */
export function formatDuration(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec)) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
