/**
 * 内容实验服务 — Phase 6 A/B 实验（需求 §八.9 / §二十 Phase 6）
 *
 * 实验模型：一个变量（hook/template/duration/structure/prompt_version/cta/voice）×
 * 两个变体（各挂 contentIds）+ 控制变量说明；evaluate 以发布指标做分组描述统计。
 * 纪律：任一组样本 < MIN_EXPERIMENT_SAMPLES(8) → lowSample=true，verdict 只给
 * 「样本不足，不构成结论」（§十四）；结论恒附「相关非因果」声明；不自动判赢家。
 */
import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { db } from "../db";
import { experiments } from "../db/schema";
import { medianOf } from "./analytics-dashboard.service";
import { type VideoRowData, loadAllVideoRows } from "./analytics-dashboard.service";
import { FACTOR_METRICS, type FactorMetric } from "./analytics-factors.service";

export const MIN_EXPERIMENT_SAMPLES = 8;
export const EXPERIMENT_MODEL_VERSION = "ab-descriptive-v1";

export const EXPERIMENT_VARIABLES = [
  "hook",
  "template",
  "duration",
  "structure",
  "prompt_version",
  "cta",
  "voice",
] as const;
export type ExperimentVariable = (typeof EXPERIMENT_VARIABLES)[number];

export interface ExperimentVariant {
  label: string;
  contentIds: string[];
}

export interface ExperimentEvaluation {
  targetMetric: string;
  medianA: number | null;
  medianB: number | null;
  /** medianB - medianA（比率类由前端换算百分点） */
  diff: number | null;
  sampleA: number;
  sampleB: number;
  lowSample: boolean;
  verdict: string;
  note: string;
  modelVersion: string;
  evaluatedAt: string;
}

/** 纯函数：分组指标值提取（缺指标的内容不计入，不补 0） */
function metricValuesOf(rows: VideoRowData[], contentIds: string[], metric: string): number[] {
  const idSet = new Set(contentIds);
  return rows
    .filter((r) => idSet.has(r.contentId))
    .map((r) => r.cells[metric]?.value)
    .filter((v): v is number => v !== undefined);
}

/** 纯函数：A/B 描述统计评估（小样本只给描述不下结论；恒附相关性声明） */
export function evaluateExperiment(
  rows: VideoRowData[],
  input: { variantA: ExperimentVariant; variantB: ExperimentVariant; targetMetric: string },
): ExperimentEvaluation {
  const valuesA = metricValuesOf(rows, input.variantA.contentIds, input.targetMetric);
  const valuesB = metricValuesOf(rows, input.variantB.contentIds, input.targetMetric);
  const medianA = medianOf(valuesA);
  const medianB = medianOf(valuesB);
  const lowSample =
    valuesA.length < MIN_EXPERIMENT_SAMPLES || valuesB.length < MIN_EXPERIMENT_SAMPLES;
  const diff = medianA !== null && medianB !== null ? medianB - medianA : null;
  const verdict =
    medianA === null || medianB === null || diff === null
      ? "两组均无可用指标样本，无法评估（无数据 ≠ 0）"
      : lowSample
        ? `样本不足（A n=${valuesA.length} / B n=${valuesB.length}，最小 ${MIN_EXPERIMENT_SAMPLES}）：仅描述统计，不构成结论`
        : `B 组中位较 A 组${diff === 0 ? "持平" : diff > 0 ? "高" : "低"} ${Math.abs(diff * 100).toFixed(1)}pp（A n=${valuesA.length} / B n=${valuesB.length}）`;
  return {
    targetMetric: input.targetMetric,
    medianA,
    medianB,
    diff,
    sampleA: valuesA.length,
    sampleB: valuesB.length,
    lowSample,
    verdict,
    note: "A/B 分组对比为相关性观察，不构成因果结论；控制变量外的差异也可能影响结果（需求 §十四）",
    modelVersion: EXPERIMENT_MODEL_VERSION,
    evaluatedAt: new Date().toISOString(),
  };
}

/** 纯函数：创建校验（变量白名单 / 两组内容不相交且非空 / 指标白名单） */
export function validateExperimentInput(input: {
  variable: string;
  variantA: ExperimentVariant;
  variantB: ExperimentVariant;
  targetMetric: string;
}): string[] {
  const errors: string[] = [];
  if (!(EXPERIMENT_VARIABLES as readonly string[]).includes(input.variable)) {
    errors.push(`实验变量不在白名单：${EXPERIMENT_VARIABLES.join("/")}`);
  }
  if (!(FACTOR_METRICS as readonly string[]).includes(input.targetMetric)) {
    errors.push("目标指标不在白名单");
  }
  if (input.variantA.contentIds.length === 0 || input.variantB.contentIds.length === 0) {
    errors.push("两组变体都必须关联至少一条内容");
  }
  const overlap = input.variantA.contentIds.filter((id) => input.variantB.contentIds.includes(id));
  if (overlap.length > 0) {
    errors.push(`同一内容不能同时属于 A/B 两组：${overlap.join(",")}`);
  }
  return errors;
}

function makeExperimentId(): string {
  return `exp_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

export interface ExperimentView {
  id: string;
  variable: string;
  variantA: ExperimentVariant;
  variantB: ExperimentVariant;
  controlVariables: unknown;
  targetMetric: string;
  startAt: string | null;
  endAt: string | null;
  status: string;
  result: ExperimentEvaluation | null;
  createdAt: string;
  updatedAt: string;
}

function parseVariant(value: unknown): ExperimentVariant {
  const record =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return {
    label: typeof record.label === "string" ? record.label : "",
    contentIds: Array.isArray(record.contentIds) ? record.contentIds.map(String).slice(0, 500) : [],
  };
}

function toView(row: typeof experiments.$inferSelect): ExperimentView {
  return {
    id: row.id,
    variable: row.variable,
    variantA: parseVariant(row.variantA),
    variantB: parseVariant(row.variantB),
    controlVariables: row.controlVariables,
    targetMetric: row.targetMetric,
    startAt: row.startAt instanceof Date ? row.startAt.toISOString() : null,
    endAt: row.endAt instanceof Date ? row.endAt.toISOString() : null,
    status: row.status,
    result: (row.result as ExperimentEvaluation | null) ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function createExperiment(input: {
  variable: ExperimentVariable;
  variantA: ExperimentVariant;
  variantB: ExperimentVariant;
  controlVariables?: unknown;
  targetMetric: FactorMetric;
  startAt?: string | null;
}): Promise<ExperimentView> {
  const id = makeExperimentId();
  await db.insert(experiments).values({
    id,
    variable: input.variable,
    variantA: input.variantA,
    variantB: input.variantB,
    controlVariables: input.controlVariables ?? null,
    targetMetric: input.targetMetric,
    startAt: input.startAt ? new Date(input.startAt) : null,
    endAt: null,
    status: input.startAt ? "running" : "draft",
    result: null,
  });
  const rows = await db.select().from(experiments).where(eq(experiments.id, id)).limit(1);
  return toView(rows[0] as typeof experiments.$inferSelect);
}

export async function listExperiments(): Promise<ExperimentView[]> {
  const rows = await db.select().from(experiments).orderBy(desc(experiments.createdAt)).limit(100);
  return rows.map(toView);
}

/**
 * 评估并归档：读取两组内容的发布指标做描述统计 → 写 result 并置 completed + endAt。
 * running/completed 均可重复评估（数据更新后刷新结论）；cancelled 拒绝。
 */
export async function evaluateExperimentById(
  id: string,
): Promise<
  { kind: "ok"; experiment: ExperimentView } | { kind: "not-found" } | { kind: "cancelled" }
> {
  const rows = await db.select().from(experiments).where(eq(experiments.id, id)).limit(1);
  const row = rows[0];
  if (!row) return { kind: "not-found" };
  if (row.status === "cancelled") return { kind: "cancelled" };
  const view = toView(row);
  const allRows = await loadAllVideoRows();
  const evaluation = evaluateExperiment(allRows, {
    variantA: view.variantA,
    variantB: view.variantB,
    targetMetric: view.targetMetric,
  });
  await db
    .update(experiments)
    .set({ result: evaluation, status: "completed", endAt: new Date(), updatedAt: new Date() })
    .where(eq(experiments.id, id));
  const updated = await db.select().from(experiments).where(eq(experiments.id, id)).limit(1);
  return { kind: "ok", experiment: toView(updated[0] as typeof experiments.$inferSelect) };
}

/** 状态流转（draft→running→cancelled 等；completed 仅由 evaluate 写入，防手改结论态） */
export async function updateExperimentStatus(
  id: string,
  status: "draft" | "running" | "cancelled",
): Promise<ExperimentView | null> {
  const rows = await db.select().from(experiments).where(eq(experiments.id, id)).limit(1);
  const row = rows[0];
  if (!row || row.status === "completed") return null;
  await db
    .update(experiments)
    .set({
      status,
      ...(status === "running" && row.startAt === null ? { startAt: new Date() } : {}),
      updatedAt: new Date(),
    })
    .where(eq(experiments.id, id));
  const updated = await db.select().from(experiments).where(eq(experiments.id, id)).limit(1);
  return updated[0] ? toView(updated[0]) : null;
}
