/**
 * 证据链与采纳服务测试（docs/22 §4.2 / §5.2，批次二）
 *
 * 这一层要钉的是「编排 + 诚实性分支」，路由测试把 service 整个 mock 掉了，
 * 真库不变量只在 :3307 在跑时执行，所以这两条纪律必须在常规单测里有归宿：
 * 1. 建议值 / 预填值 / 最终值三者分开存，建议值只从建议行读，不信前端回传；
 * 2. 证据追到哪一层就说到哪一层，追不到就 evidence_unavailable，绝不拼一份看起来完整的证据。
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
  /**
   * 链式 fake：一次 select() 占一个槽位，链上每个环节共享同一槽位，
   * 所以「谁被 await」都能拿到同一份预置行集，而消费顺序 = select() 的创建顺序。
   * insert/update 不占槽位，只记录载荷（服务层不使用其返回值）。
   */
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
  bindRecommendationApplication,
  getRecommendationEvidence,
  listApplicationsByContent,
  recordRecommendationApplication,
} from "./analytics-recommend-evidence.service";

function unwrap<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("期望有返回值，实际为空");
  return value;
}

/** 写入载荷按 unknown 记录，取用时显式判定形状（不用 as 绕过） */
function payloadRecord(payload: unknown): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("期望写入载荷是对象");
  }
  return payload as Record<string, unknown>;
}

const computedAt = new Date("2026-10-01T08:00:00.000Z");

function recRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "rec_1",
    recommendationType: "hook",
    recommendation: { value: "question", label: "疑问句开场", kindLabel: "Hook" },
    reason: "抖音 · 近 90 天 · 疑问句开场完播率中位 0.42，高于账号整体 0.31（样本 10）",
    sourceMetric: "completion_rate",
    sourceSampleCount: 10,
    analysisResultId: 7,
    ...over,
  };
}

function snapshotRow(
  payload: unknown,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 7,
    analysisType: "factors:completion_rate",
    modelVersion: "group-stats-v1",
    createdAt: computedAt,
    result: payload,
    ...over,
  };
}

/** 与 analytics-factors.service 的落库形状一致：dimensions[].groups[].recordIds */
function payloadWith(groups: Record<string, unknown>[]): Record<string, unknown> {
  return {
    metric: "completion_rate",
    accountMedian: 0.31,
    accountSampleCount: 14,
    accountRealSampleCount: 10,
    scope: { platform: "抖音", windowDays: 90 },
    dimensions: [{ dimension: "hook", groups }],
  };
}

function metricRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    publishRecordId: "pub_1",
    metricName: "completion_rate",
    metricValue: 0.42,
    sourceType: "CREATOR_IMPORT",
    sourceField: "完播率",
    dataDate: "2026-10-01",
    isEstimated: 0,
    metadata: { batch_id: "imp_1", import_row: 3, matched_by: "platform_work_id_exact" },
    ...over,
  };
}

beforeEach(() => {
  h.results.length = 0;
  h.writes.length = 0;
  h.cursor.slot = 0;
});

describe("recordRecommendationApplication", () => {
  it("建议不存在时不落采纳（不给幽灵建议记一次采纳）", async () => {
    h.results.push([]);
    const res = await recordRecommendationApplication({
      recommendationId: "rec_none",
      prefillParams: { hook: "question" },
    });
    expect(res).toEqual({ kind: "recommendation-not-found" });
    expect(h.writes).toEqual([]);
  });

  it("建议值由服务端从建议行读出，预填值另存；两者不同源即留下两条不同字段", async () => {
    h.results.push([recRow({ recommendation: { value: "question", label: "疑问句开场" } })]);
    const res = await recordRecommendationApplication({
      recommendationId: "rec_1",
      prefillParams: { hook: "question", speechRate: 1.05 },
    });
    const created = unwrap(res.kind === "created" ? res : null);
    expect(created.targetMetric).toBe("completion_rate");
    expect(created.analysisResultId).toBe(7);
    const insert = unwrap(h.writes[0]);
    const values = payloadRecord(insert.payload);
    expect(values.suggestedParams).toEqual({ value: "question", label: "疑问句开场" });
    expect(values.prefillParams).toEqual({ hook: "question", speechRate: 1.05 });
    expect(values.contentId).toBeNull();
    expect(values.finalParams).toBeNull();
    expect(values.analysisResultId).toBe(7);
  });
});

describe("bindRecommendationApplication", () => {
  it("采纳记录不存在 → not-found", async () => {
    h.results.push([]);
    expect(
      await bindRecommendationApplication("recapp_x", { contentId: "c1", finalParams: {} }),
    ).toBe("not-found");
  });

  it("已绑定过不再改写（一次采纳对应一次生成，重渲染不覆盖首次事实）", async () => {
    h.results.push([{ id: "recapp_1", appliedAt: computedAt }]);
    expect(
      await bindRecommendationApplication("recapp_1", {
        contentId: "c1",
        finalParams: { hook: "mistake" },
      }),
    ).toBe("already-bound");
    expect(h.writes).toEqual([]);
  });

  it("内容不存在 → 不绑定（留 NULL 就是「采纳了但没生成成功」）", async () => {
    h.results.push([{ id: "recapp_1", appliedAt: null }], []);
    expect(
      await bindRecommendationApplication("recapp_1", { contentId: "c_gone", finalParams: {} }),
    ).toBe("content-not-found");
    expect(h.writes).toEqual([]);
  });

  it("绑定写入用户最终提交值，不是建议值", async () => {
    h.results.push([{ id: "recapp_1", appliedAt: null }], [{ id: "c1" }]);
    const res = await bindRecommendationApplication("recapp_1", {
      contentId: "c1",
      finalParams: { generation: { topic: "机场" }, media: { speechRate: 1.1 } },
    });
    expect(res).toBe("bound");
    const update = unwrap(h.writes[0]);
    const set = payloadRecord(update.payload);
    expect(set.contentId).toBe("c1");
    expect(set.finalParams).toEqual({ generation: { topic: "机场" }, media: { speechRate: 1.1 } });
    expect(set.appliedAt).toBeInstanceOf(Date);
  });
});

describe("listApplicationsByContent", () => {
  it("时间以 ISO 字符串回放；未绑定的 appliedAt 保持 null", async () => {
    h.results.push([
      {
        id: "recapp_1",
        recommendationId: "rec_1",
        suggestedParams: { value: "question" },
        prefillParams: { hook: "question" },
        finalParams: null,
        targetMetric: "completion_rate",
        analysisResultId: 7,
        acceptedAt: computedAt,
        appliedAt: null,
      },
    ]);
    const rows = await listApplicationsByContent("c1");
    expect(rows[0]?.acceptedAt).toBe("2026-10-01T08:00:00.000Z");
    expect(rows[0]?.appliedAt).toBeNull();
    expect(rows[0]?.finalParams).toBeNull();
  });
});

describe("getRecommendationEvidence · 断链如实说明", () => {
  it("建议本身不存在回 null（由路由回 404）", async () => {
    h.results.push([]);
    expect(await getRecommendationEvidence("rec_none")).toBeNull();
  });

  it("历史建议没有快照 id → evidence_unavailable，且不带任何猜测出来的分组", async () => {
    h.results.push([recRow({ analysisResultId: null })]);
    const ev = unwrap(await getRecommendationEvidence("rec_1"));
    expect(ev.status).toBe("evidence_unavailable");
    expect(ev.unavailableReasons[0]).toContain("尚未留档因子快照");
    expect(ev.snapshot).toBeNull();
    expect(ev.groups).toEqual([]);
    expect(ev.videos).toEqual([]);
  });

  it("引用了快照但快照行不在 → 如实报断链（比「没有快照」更该被看见）", async () => {
    h.results.push([recRow({ analysisResultId: 999 })], []);
    const ev = unwrap(await getRecommendationEvidence("rec_1"));
    expect(ev.status).toBe("evidence_unavailable");
    expect(ev.unavailableReasons[0]).toContain("analysis_result#999 不存在");
  });

  it("参数类建议找不到对应分组 → evidence_unavailable，不用别的分组凑证据", async () => {
    h.results.push(
      [recRow({ recommendationType: "cta", recommendation: { value: "comment" } })],
      [snapshotRow(payloadWith([{ value: "question", sampleCount: 10, recordIds: ["pub_1"] }]))],
    );
    const ev = unwrap(await getRecommendationEvidence("rec_1"));
    expect(ev.groups).toEqual([]);
    expect(ev.status).toBe("evidence_unavailable");
    expect(ev.unavailableReasons[0]).toContain("找不到与该建议匹配的分组");
    // 快照口径仍然如实给出：缺的是分组，不是整条证据
    expect(unwrap(ev.snapshot).scope).toEqual({ platform: "抖音", windowDays: 90 });
  });

  it("数据准备类建议不对应分组，依据是快照整体样本量口径（不是断链）", async () => {
    h.results.push(
      [
        recRow({
          recommendationType: "data_readiness",
          recommendation: { value: "import_more", label: "继续导入创作者数据" },
          sourceSampleCount: 0,
        }),
      ],
      [
        snapshotRow({
          metric: "completion_rate",
          accountSampleCount: 0,
          accountRealSampleCount: 0,
          scope: { platform: "快手", windowDays: 90 },
          dimensions: [],
        }),
      ],
    );
    const ev = unwrap(await getRecommendationEvidence("rec_1"));
    expect(ev.status).toBe("traceable");
    expect(ev.unavailableReasons[0]).toContain("真实样本 0 条 / 覆盖 0 条");
    expect(ev.groups).toEqual([]);
    expect(ev.videos).toEqual([]);
  });
});

describe("getRecommendationEvidence · 追到最底层", () => {
  /** 分组 → 参与视频 → 指标行 provenance → 导入原始行 + 裁决方式 */
  async function happyPath(
    metricRows: Record<string, unknown>[],
  ): Promise<Awaited<ReturnType<typeof getRecommendationEvidence>>> {
    h.results.push(
      [recRow()],
      [
        snapshotRow(
          payloadWith([
            {
              value: "question",
              sampleCount: 12,
              realSampleCount: 10,
              median: 0.42,
              mean: 0.44,
              recordIds: ["pub_1", "pub_2"],
            },
            { value: "mistake", sampleCount: 9, recordIds: ["pub_3"] },
          ]),
        ),
      ],
      [
        {
          recordId: "pub_1",
          contentId: "c1",
          title: "咖啡店英语",
          contentStatus: "completed",
          audit: { input: { topic: "咖啡店", level: "CET4" }, output: { ok: true } },
          platform: "抖音",
          platformVideoId: "74321",
          publishStatus: "published",
          publishTime: computedAt,
          publishTimeSource: "PLATFORM_IMPORTED",
          videoAssetId: "v1.mp4",
        },
      ],
      metricRows,
      [
        {
          contentId: "c1",
          template: "scene_word",
          level: "CET4",
          duration: 48,
          segmentCount: 8,
          speechRate: 1.05,
          hook: "question",
          fieldSources: { hook: "USER_INPUT" },
        },
      ],
      [
        {
          id: 41,
          batchId: "imp_1",
          rowNumber: 3,
          rawData: { 作品ID: "74321", 完播率: "42%" },
          matchStatus: "confirmed",
          filename: "抖音创作者后台_20261001.csv",
          batchPlatform: "抖音",
          batchStatus: "committed",
        },
      ],
      [{ id: 41, importRowId: 41, decisionType: "operator_confirm" }],
    );
    return getRecommendationEvidence("rec_1");
  }

  it("只取与本建议同维同值的那一组，recordIds 去重后作为参与样本", async () => {
    const ev = unwrap(await happyPath([metricRow()]));
    expect(ev.groups).toHaveLength(1);
    expect(unwrap(ev.groups[0]).recordIds).toEqual(["pub_1", "pub_2"]);
    expect(unwrap(ev.snapshot).accountRealSampleCount).toBe(10);
    expect(unwrap(ev.snapshot).computedAt).toBe("2026-10-01T08:00:00.000Z");
    expect(ev.status).toBe("traceable");
  });

  it("指标值带批次与原始行号，可回放到导入行整行原文与裁决方式", async () => {
    const ev = unwrap(await happyPath([metricRow()]));
    const cell = unwrap(ev.videos[0]).metrics.completion_rate;
    expect(cell.batchId).toBe("imp_1");
    expect(cell.importRowNumber).toBe(3);
    expect(cell.matchedBy).toBe("platform_work_id_exact");
    const importRow = unwrap(ev.importRows[0]);
    expect(importRow.rawData).toEqual({ 作品ID: "74321", 完播率: "42%" });
    expect(importRow.decisionType).toBe("operator_confirm");
    expect(importRow.filename).toBe("抖音创作者后台_20261001.csv");
  });

  it("生产特征与审计档案按字段给出，缺的就是缺", async () => {
    const ev = unwrap(await happyPath([metricRow()]));
    const video = unwrap(ev.videos[0]);
    expect(video.publishTime).toBe("2026-10-01T08:00:00.000Z");
    expect(video.publishTimeSource).toBe("PLATFORM_IMPORTED");
    expect(unwrap(video.features).hook).toBe("question");
    expect(unwrap(video.fieldSources).hook).toBe("USER_INPUT");
    expect(video.auditAvailable).toBe(true);
    expect(video.auditInputKeys).toEqual(["topic", "level"]);
  });

  it("同一视频既有导入来的指标也有人工/平台计算的指标：前者追到原始行，后者不猜批次并如实说明只到字段名", async () => {
    const ev = unwrap(
      await happyPath([
        metricRow(),
        metricRow({ metricName: "like_count", metadata: null, sourceType: "MANUAL_INPUT" }),
      ]),
    );
    const video = unwrap(ev.videos[0]);
    const like = unwrap(video.metrics.like_count);
    expect(like.batchId).toBeNull();
    expect(like.importRowNumber).toBeNull();
    expect(like.sourceType).toBe("MANUAL_INPUT");
    expect(video.metrics.completion_rate?.batchId).toBe("imp_1");
    expect(ev.importRows).toHaveLength(1);
    expect(ev.status).toBe("traceable");
    expect(ev.unavailableReasons[0]).toContain("只能追到字段名层级");
  });

  it("估算值不因存在于快照就被当成真实样本口径（isEstimated 原样透出）", async () => {
    const ev = unwrap(
      await happyPath([metricRow({ metricName: "follower_net_increase", isEstimated: 1 })]),
    );
    const cell = unwrap(unwrap(ev.videos[0]).metrics.follower_net_increase);
    expect(cell.isEstimated).toBe(true);
  });
});
