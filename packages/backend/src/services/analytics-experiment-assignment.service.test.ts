/**
 * 实验分配服务测试（docs/22 §4.3 / §5.3，批次三）
 *
 * 钉住四件真会出错的事：
 * 1. 已归档（completed/cancelled）的实验不接受新分配——事后追加会把对比污染成挑数据；
 * 2. 分配时没有内容，绑定才有；生成失败的内容不绑定（失败产物不是实验样本）；
 * 3. 一次分配只绑一次，二次绑定拒绝而不是静默改写；
 * 4. 评估取两组内容时，「分配了但没绑定」的条数必须单独说出来，不能悄悄少算。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const results: unknown[][] = [];
  const writes: { op: "insert" | "update"; payload: unknown }[] = [];
  const cursor = { slot: 0 };
  type Chain = Promise<unknown[]> & {
    from: () => Chain;
    innerJoin: () => Chain;
    where: () => Chain;
    orderBy: () => Chain;
    limit: () => Chain;
    values: (payload: unknown) => Chain;
    set: (payload: unknown) => Chain;
  };
  /** 一次 select() 占一个槽位，链上每个环节共享同一槽位（消费顺序 = select 创建顺序） */
  const makeChain = (slot: number): Chain => {
    const link = (): Chain => makeChain(slot);
    const rows = (): unknown[] => (slot < 0 ? [] : (results[slot] ?? []));
    return Object.assign(Promise.resolve().then(rows), {
      from: link,
      innerJoin: link,
      where: link,
      orderBy: link,
      limit: link,
      values: (payload: unknown) => {
        writes.push({ op: "insert", payload });
        return link();
      },
      set: (payload: unknown) => {
        writes.push({ op: "update", payload });
        return link();
      },
    });
  };
  return {
    results,
    writes,
    // 必须是同一个 cursor 对象：beforeEach 重置的就是 select() 正在递增的那个游标
    cursor,
    db: {
      select: () => makeChain(cursor.slot++),
      insert: () => makeChain(-1),
      update: () => makeChain(-1),
    },
  };
});

vi.mock("../db", () => ({ db: h.db }));

import {
  bindExperimentAssignment,
  createExperimentAssignment,
  listExperimentAssignments,
  loadAssignmentGroups,
} from "./analytics-experiment-assignment.service";

function unwrap<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("期望有返回值，实际为空");
  return value;
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("期望写入载荷是对象");
  }
  return payload as Record<string, unknown>;
}

function assignmentRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "expa_1",
    experimentId: "exp_1",
    contentId: null,
    variant: "A",
    assignmentMethod: "operator_selected",
    assignedParams: { variantLabel: "提问开场" },
    finalParams: null,
    assignedAt: new Date("2026-10-01T08:00:00.000Z"),
    boundAt: null,
    createdAt: new Date("2026-10-01T08:00:00.000Z"),
    updatedAt: new Date("2026-10-01T08:00:00.000Z"),
    ...over,
  };
}

beforeEach(() => {
  h.results.length = 0;
  h.writes.length = 0;
  h.cursor.slot = 0;
});

describe("createExperimentAssignment", () => {
  it("实验不存在 → experiment-not-found，且不写入", async () => {
    h.results.push([]);
    const res = await createExperimentAssignment({
      experimentId: "exp_none",
      variant: "A",
      assignedParams: {},
    });
    expect(res).toEqual({ kind: "experiment-not-found" });
    expect(h.writes).toEqual([]);
  });

  it("已归档/已取消的实验拒绝再分配（事后追加等于挑数据）", async () => {
    for (const status of ["completed", "cancelled"]) {
      h.results.push([{ id: "exp_1", status }]);
      const res = await createExperimentAssignment({
        experimentId: "exp_1",
        variant: "B",
        assignedParams: {},
      });
      expect(res).toEqual({ kind: "not-assignable", status });
    }
    expect(h.writes).toEqual([]);
  });

  it("draft 实验可分配：此刻还没有内容，contentId 与 finalParams 都为空", async () => {
    h.results.push([{ id: "exp_1", status: "draft" }], [assignmentRow()]);
    const res = await createExperimentAssignment({
      experimentId: "exp_1",
      variant: "A",
      assignedParams: { variantLabel: "提问开场", template: "scene_word" },
    });
    const insert = payloadRecord(unwrap(h.writes[0]).payload);
    expect(insert.contentId).toBeNull();
    expect(insert.finalParams).toBeNull();
    expect(insert.variant).toBe("A");
    expect(insert.assignmentMethod).toBe("operator_selected");
    expect(insert.assignedParams).toEqual({ variantLabel: "提问开场", template: "scene_word" });
    const created = unwrap(res.kind === "created" ? res.assignment : null);
    expect(created.id).toBe("expa_1");
    expect(created.boundAt).toBeNull();
    expect(created.assignedAt).toBe("2026-10-01T08:00:00.000Z");
  });
});

describe("bindExperimentAssignment", () => {
  it("分配不属于该实验时按不存在处理（路径里的实验不是别人的台账）", async () => {
    h.results.push([]);
    expect(
      await bindExperimentAssignment("exp_1", "expa_other", {
        contentId: "c1",
        finalParams: {},
      }),
    ).toBe("not-found");
  });

  it("同一条内容不能占这条实验的两个变体位（否则自己跟自己比）", async () => {
    h.results.push(
      [{ id: "expa_1", boundAt: null }],
      [{ status: "completed" }],
      [{ id: "expa_9" }], // 台账里已有这条内容
    );
    expect(
      await bindExperimentAssignment("exp_1", "expa_1", { contentId: "c1", finalParams: {} }),
    ).toBe("content-already-assigned");
    expect(h.writes).toEqual([]);
  });

  it("并发重发同一笔绑定：条件更新没抢到就回读，按已绑定处理，不覆盖首次事实", async () => {
    h.results.push(
      [{ id: "expa_1", boundAt: null }],
      [{ status: "completed" }],
      [], // 该实验台账里还没有这条内容
      [], // UPDATE ... WHERE bound_at IS NULL AND content_id IS NULL（0 行受影响）
      [{ contentId: "other-content" }], // 回读：别人先绑上了
    );
    expect(
      await bindExperimentAssignment("exp_1", "expa_1", { contentId: "c1", finalParams: {} }),
    ).toBe("already-bound");
    expect(h.writes).toHaveLength(1); // 只发过一次条件更新，没有第二次写入
  });

  it("已绑定过不再改写（一次分配对应一次生成）", async () => {
    h.results.push([{ id: "expa_1", boundAt: new Date() }]);
    expect(
      await bindExperimentAssignment("exp_1", "expa_1", {
        contentId: "c1",
        finalParams: { template: "quiz" },
      }),
    ).toBe("already-bound");
    expect(h.writes).toEqual([]);
  });

  it("内容不存在 → 不绑定；内容生成失败 → 也不绑定（失败产物不是样本）", async () => {
    h.results.push([{ id: "expa_1", boundAt: null }], [], []);
    expect(
      await bindExperimentAssignment("exp_1", "expa_1", { contentId: "c_gone", finalParams: {} }),
    ).toBe("content-not-found");
    h.results.length = 0;
    h.cursor.slot = 0;
    h.results.push([{ id: "expa_1", boundAt: null }], [{ status: "failed" }], []);
    expect(
      await bindExperimentAssignment("exp_1", "expa_1", { contentId: "c_bad", finalParams: {} }),
    ).toBe("content-failed");
    expect(h.writes).toEqual([]);
  });

  it("绑定写入用户最终提交值与 boundAt", async () => {
    h.results.push(
      [{ id: "expa_1", boundAt: null }],
      [{ status: "completed" }],
      [],
      [{ contentId: "c1" }],
    );
    const res = await bindExperimentAssignment("exp_1", "expa_1", {
      contentId: "c1",
      finalParams: { template: "word_card" },
    });
    expect(res).toBe("bound");
    const set = payloadRecord(unwrap(h.writes[0]).payload);
    expect(set.contentId).toBe("c1");
    expect(set.finalParams).toEqual({ template: "word_card" });
    expect(set.boundAt).toBeInstanceOf(Date);
  });
});

describe("loadAssignmentGroups", () => {
  it("没有任何分配 → null（由调用方回退旧两组清单并如实声明）", async () => {
    h.results.push([]);
    expect(await loadAssignmentGroups("exp_1")).toBeNull();
  });

  it("历史脏数据里同一条内容被登记两次：只算一次，不让自己跟自己比", async () => {
    h.results.push([
      { variant: "A", contentId: "c1" },
      { variant: "B", contentId: "c1" },
      { variant: "B", contentId: "c2" },
    ]);
    expect(await loadAssignmentGroups("exp_1")).toEqual({
      a: ["c1"],
      b: ["c2"],
      unbound: 0,
      total: 3,
    });
  });

  it("未绑定的分配单独计数，不混进两组样本", async () => {
    h.results.push([
      { variant: "A", contentId: "c1" },
      { variant: "A", contentId: "c2" },
      { variant: "B", contentId: "c3" },
      { variant: "B", contentId: null },
      { variant: "A", contentId: null },
    ]);
    const groups = unwrap(await loadAssignmentGroups("exp_1"));
    expect(groups).toEqual({ a: ["c1", "c2"], b: ["c3"], unbound: 2, total: 5 });
  });
});

describe("listExperimentAssignments", () => {
  it("时间以 ISO 回放；未绑定的 boundAt 保持 null", async () => {
    h.results.push([assignmentRow({ variant: "B" })]);
    const rows = await listExperimentAssignments("exp_1");
    expect(rows[0]).toMatchObject({
      variant: "B",
      contentId: null,
      assignedAt: "2026-10-01T08:00:00.000Z",
      boundAt: null,
    });
  });
});
