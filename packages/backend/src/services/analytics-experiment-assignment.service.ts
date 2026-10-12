/**
 * 实验分配服务（docs/22 §4.3 / §5.3，批次三）
 *
 * 为什么要有这张表：Phase 6 的 `experiments.variantA/B.contentIds` 是「事后把内容分到两组」的
 * 记账方式，它无法回答「这条内容在生成之前是不是就被定为 B 组、按什么参数生成的」。
 * 没有这层事实，A/B 对比就只是给已有结果分组，不是实验。
 *
 * 纪律：变体在生成前显式选定（第一版只有 operator_selected——没有随机分流基础设施就假装随机
 * A/B 是撒谎）；分配与绑定分两步，生成失败时记录保持未绑定（「分配了但没产出」是看得见的事实）；
 * 已绑定的不再改写；内容不存在或已失败时拒绝绑定，不伪造归属。
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { contents, experimentAssignments, experiments } from "../db/schema";

function makeAssignmentId(): string {
  return `expa_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

export interface AssignmentView {
  id: string;
  experimentId: string;
  contentId: string | null;
  variant: "A" | "B";
  assignmentMethod: string;
  /** 分配时页面给出的参数（形状异常时为 null，不猜成空对象冒充「没有参数」） */
  assignedParams: Record<string, unknown> | null;
  /** 生成提交时的最终参数；未绑定为 null */
  finalParams: Record<string, unknown> | null;
  assignedAt: string;
  boundAt: string | null;
}

/** JSON 列只保证是 JSON；不是对象形状就如实给 null，不兜成 {} 冒充「参数为空」 */
function paramsOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toView(row: typeof experimentAssignments.$inferSelect): AssignmentView {
  return {
    id: row.id,
    experimentId: row.experimentId,
    contentId: row.contentId,
    variant: row.variant,
    assignmentMethod: row.assignmentMethod,
    assignedParams: paramsOf(row.assignedParams),
    finalParams: paramsOf(row.finalParams),
    assignedAt: row.assignedAt.toISOString(),
    boundAt: row.boundAt instanceof Date ? row.boundAt.toISOString() : null,
  };
}

export type AssignmentCreateResult =
  | { kind: "created"; assignment: AssignmentView }
  | { kind: "experiment-not-found" }
  /** 只有 draft/running 允许分配；completed/cancelled 拒绝（事后追加会污染已归档的对比） */
  | { kind: "not-assignable"; status: string };

/** 生成前登记一次变体分配 */
export async function createExperimentAssignment(input: {
  experimentId: string;
  variant: "A" | "B";
  assignedParams: Record<string, unknown>;
}): Promise<AssignmentCreateResult> {
  const [exp] = await db
    .select({ id: experiments.id, status: experiments.status })
    .from(experiments)
    .where(eq(experiments.id, input.experimentId))
    .limit(1);
  if (!exp) return { kind: "experiment-not-found" };
  if (exp.status !== "draft" && exp.status !== "running") {
    return { kind: "not-assignable", status: exp.status };
  }
  const id = makeAssignmentId();
  await db.insert(experimentAssignments).values({
    id,
    experimentId: exp.id,
    contentId: null,
    variant: input.variant,
    assignmentMethod: "operator_selected",
    assignedParams: input.assignedParams,
    finalParams: null,
    assignedAt: new Date(),
    boundAt: null,
  });
  // MySQL 的 drizzle insert 没有 RETURNING：按主键回读，返回库里真实那一行
  const [created] = await db
    .select()
    .from(experimentAssignments)
    .where(eq(experimentAssignments.id, id))
    .limit(1);
  if (!created) throw new Error(`分配记录写入后回读失败：${id}`);
  return { kind: "created", assignment: toView(created) };
}

export type AssignmentBindResult =
  | "bound"
  | "not-found"
  | "already-bound"
  | "content-not-found"
  /** 生成失败的内容不绑定：失败产物不是实验样本 */
  | "content-failed"
  /** 同一条内容不能占两个变体位（旧登记路径就有这条校验，新路径不能更松） */
  | "content-already-assigned";

/** 生成成功后把内容与最终参数绑到这次分配上 */
export async function bindExperimentAssignment(
  experimentId: string,
  assignmentId: string,
  bind: { contentId: string; finalParams: Record<string, unknown> },
): Promise<AssignmentBindResult> {
  const [existing] = await db
    .select({ id: experimentAssignments.id, boundAt: experimentAssignments.boundAt })
    .from(experimentAssignments)
    .where(
      and(
        eq(experimentAssignments.id, assignmentId),
        eq(experimentAssignments.experimentId, experimentId),
      ),
    )
    .limit(1);
  if (!existing) return "not-found";
  if (existing.boundAt !== null) return "already-bound";
  const [content] = await db
    .select({ status: contents.status })
    .from(contents)
    .where(eq(contents.id, bind.contentId))
    .limit(1);
  if (!content) return "content-not-found";
  if (content.status === "failed") return "content-failed";
  // 一条内容只能占这条实验的一个变体位：否则同一个视频同时进 A 与 B，等于自己跟自己比
  const [taken] = await db
    .select({ id: experimentAssignments.id })
    .from(experimentAssignments)
    .where(
      and(
        eq(experimentAssignments.experimentId, experimentId),
        eq(experimentAssignments.contentId, bind.contentId),
      ),
    )
    .limit(1);
  if (taken) return "content-already-assigned";
  /**
   * 条件更新而非「先查后写」：客户端超时重发同一笔 bind 时，两次都会通过前置检查，
   * 后一次会静默覆盖前一次的 contentId/finalParams。把 bound_at IS NULL 放进 WHERE，
   * 抢不到的人回读时看到别人的值 → already-bound，不覆盖首次事实。
   */
  await db
    .update(experimentAssignments)
    .set({
      contentId: bind.contentId,
      finalParams: bind.finalParams,
      boundAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(experimentAssignments.id, assignmentId),
        isNull(experimentAssignments.boundAt),
        isNull(experimentAssignments.contentId),
      ),
    );
  const [after] = await db
    .select({ contentId: experimentAssignments.contentId })
    .from(experimentAssignments)
    .where(eq(experimentAssignments.id, assignmentId))
    .limit(1);
  return after?.contentId === bind.contentId ? "bound" : "already-bound";
}

/** 实验是否存在（读端点用它区分「没有分配」与「查无此实验」，不能都回空列表） */
export async function experimentExists(experimentId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: experiments.id })
    .from(experiments)
    .where(eq(experiments.id, experimentId))
    .limit(1);
  return row !== undefined;
}

export async function listExperimentAssignments(experimentId: string): Promise<AssignmentView[]> {
  const rows = await db
    .select()
    .from(experimentAssignments)
    .where(eq(experimentAssignments.experimentId, experimentId))
    .orderBy(asc(experimentAssignments.assignedAt));
  return rows.map(toView);
}

export interface AssignmentGroups {
  a: string[];
  b: string[];
  /** 分配了但没绑定内容（生成失败/中断）——必须被说出来，不能悄悄少算 */
  unbound: number;
  total: number;
}

/**
 * 评估用的两组内容（docs/22 §4.3：新流程以 assignments 为事实来源）。
 * 返回 null = 这条实验没有任何分配记录 → 调用方回退到旧的 variantA/B.contentIds 并如实声明。
 */
export async function loadAssignmentGroups(experimentId: string): Promise<AssignmentGroups | null> {
  const rows = await db
    .select({
      variant: experimentAssignments.variant,
      contentId: experimentAssignments.contentId,
    })
    .from(experimentAssignments)
    .where(eq(experimentAssignments.experimentId, experimentId));
  if (rows.length === 0) return null;
  // 同一条内容只算一次：bind 已拒绝重复归属，这里兜住历史脏数据——
  // 否则同一个视频会同时进 A 与 B，等于自己跟自己比
  const seen = new Set<string>();
  const a: string[] = [];
  const b: string[] = [];
  let unbound = 0;
  for (const r of rows) {
    if (r.contentId === null) {
      unbound += 1;
      continue;
    }
    if (seen.has(r.contentId)) continue;
    seen.add(r.contentId);
    if (r.variant === "A") a.push(r.contentId);
    else b.push(r.contentId);
  }
  return { a, b, unbound, total: rows.length };
}
