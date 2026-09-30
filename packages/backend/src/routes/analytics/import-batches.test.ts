/**
 * import-batches 路由契约测试 — 四步导入端点的状态码映射与错误信封
 * service 层 mock 隔离（真实链路在 E2E/批次 I 覆盖）；重点钉住各红线与门控的 HTTP 表达
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { analyticsRoute } from "../analytics";

vi.mock("../../db", () => ({ db: {} }));
vi.mock("../../services/analytics-metrics.service", () => ({
  mapImportRow: vi.fn(),
  mapCreatorDailyRow: vi.fn(),
  recomputeDerivedMetrics: vi.fn(),
  upsertCreatorDailyRow: vi.fn(),
  writeMetricRows: vi.fn(),
}));

const svc = vi.hoisted(() => ({
  createImportBatch: vi.fn(),
  listImportBatches: vi.fn(),
  getBatchView: vi.fn(),
  deleteImportBatch: vi.fn(),
  confirmGranularity: vi.fn(),
  saveRules: vi.fn(),
  prematchBatch: vi.fn(),
  listBatchRows: vi.fn(),
  getRowDetail: vi.fn(),
  applyDecisions: vi.fn(),
  preflightBatch: vi.fn(),
  commitBatch: vi.fn(),
  rollbackBatch: vi.fn(),
  quickImport: vi.fn(),
}));

vi.mock("../../services/analytics-import-batch.service", () => svc);

const app = analyticsRoute;

const validCreateBody = {
  filename: "发布记录_20260827.xlsx",
  fileSize: 2_411_520,
  fileHash: "a".repeat(64),
  platform: "抖音",
  headers: ["作品ID", "播放量"],
  rows: [["7412345678901234567", "1283"]],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /import-batches", () => {
  it("201：返回粒度判定 + 字段识别 + 预览", async () => {
    svc.createImportBatch.mockResolvedValue({
      kind: "created",
      batchId: "imp_1",
      granularity: "work_level_strong",
      granularityEvidence: { note: "ok" },
      fieldDetection: [],
      summary: { rowCount: 1, accountCount: 0, dateFrom: null, dateTo: null },
      preview: [],
    });
    svc.listImportBatches.mockResolvedValue([]);
    const res = await app.request("/import-batches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validCreateBody),
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.batchId).toBe("imp_1");
    expect(data.dataGranularity).toBe("work_level_strong");
  });

  it("409：同 hash 已有 committed 批次（重复导入拦截）", async () => {
    svc.listImportBatches.mockResolvedValue([
      { id: "imp_old", fileHash: "a".repeat(64), status: "committed", filename: "old.xlsx" },
    ]);
    const res = await app.request("/import-batches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validCreateBody),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("DUPLICATE_IMPORT");
    expect(svc.createImportBatch).not.toHaveBeenCalled();
  });

  it("400：hash 格式非法 / 空行", async () => {
    const bad = await app.request("/import-batches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validCreateBody, fileHash: "xyz" }),
    });
    expect(bad.status).toBe(400);
    svc.listImportBatches.mockResolvedValue([]);
    svc.createImportBatch.mockResolvedValue({ kind: "empty" });
    const empty = await app.request("/import-batches", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validCreateBody),
    });
    expect(empty.status).toBe(400);
  });
});

describe("GET /import-batches/{id} · DELETE", () => {
  it("404 批次不存在；200 视图", async () => {
    svc.getBatchView.mockResolvedValue(null);
    expect((await app.request("/import-batches/imp_x")).status).toBe(404);
    svc.getBatchView.mockResolvedValue({
      id: "imp_x",
      filename: "f.xlsx",
      fileSize: 1,
      fileHash: "h",
      platform: "抖音",
      rowCount: 1,
      dataGranularity: "work_level_strong",
      granularityEvidence: {},
      headers: [],
      fieldDetection: [],
      matchRules: null,
      status: "draft",
      stats: {
        uniqueMatch: 0,
        conflict: 0,
        unmatched: 0,
        accountDayLevel: 0,
        confirmed: 0,
        ignored: 0,
      },
      commitSummary: null,
      createdAt: "2026-09-28T00:00:00.000Z",
      completedAt: null,
    });
    expect((await app.request("/import-batches/imp_x")).status).toBe(200);
  });

  it("DELETE：已提交批次 409（只能回滚），草稿 200", async () => {
    svc.deleteImportBatch.mockResolvedValue({ kind: "committed" });
    expect((await app.request("/import-batches/imp_x", { method: "DELETE" })).status).toBe(409);
    svc.deleteImportBatch.mockResolvedValue({ kind: "deleted" });
    expect((await app.request("/import-batches/imp_x", { method: "DELETE" })).status).toBe(200);
  });
});

describe("粒度确认与规则", () => {
  it("400 GRANULARITY_UPGRADE_DENIED：账号日级不得升格作品级", async () => {
    svc.confirmGranularity.mockResolvedValue({
      kind: "upgrade-denied",
      current: "account_day_level",
      requested: "work_level_strong",
    });
    const res = await app.request("/import-batches/imp_x/confirm-granularity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ granularity: "work_level_strong" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("GRANULARITY_UPGRADE_DENIED");
  });

  it("PUT rules：200 携 dry-run 预估；未确认粒度 409", async () => {
    svc.saveRules.mockResolvedValue({
      kind: "ok",
      granularity: "work_level_strong",
      estimate: {
        total: 1000,
        expectStrongMatch: 926,
        expectManualConfirm: 51,
        expectUnmatched: 23,
      },
    });
    const res = await app.request("/import-batches/imp_x/rules", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.estimate.expectStrongMatch).toBe(926);
    svc.saveRules.mockResolvedValue({ kind: "invalid-state", status: "draft" });
    expect(
      (
        await app.request("/import-batches/imp_x/rules", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(409);
  });
});

describe("预匹配与裁决", () => {
  it("prematch：needs_confirmation → 409 携清空提示", async () => {
    svc.prematchBatch.mockResolvedValue({ kind: "needs-confirmation", operatorDecisions: 5 });
    const res = await app.request("/import-batches/imp_x/prematch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toContain("人工裁决");
  });

  it("decisions assign 账号日级行 → 400 红线；confirm 混入冲突行 → 400", async () => {
    svc.applyDecisions.mockResolvedValue({ kind: "account-day-denied" });
    const res = await app.request("/import-batches/imp_x/decisions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "assign", rowId: 1, videoId: "pub_1" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("ACCOUNT_DAY_ASSIGN_DENIED");

    svc.applyDecisions.mockResolvedValue({ kind: "not-confirmable", rowIds: [3, 4] });
    const res2 = await app.request("/import-batches/imp_x/decisions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "confirm", rowIds: [3, 4] }),
    });
    expect(res2.status).toBe(400);
  });

  it("decisions confirm allUnique → 200 携最新统计", async () => {
    const stats = {
      uniqueMatch: 0,
      conflict: 51,
      unmatched: 23,
      accountDayLevel: 0,
      confirmed: 926,
      ignored: 0,
    };
    svc.applyDecisions.mockResolvedValue({ kind: "ok", affected: 926, stats });
    const res = await app.request("/import-batches/imp_x/decisions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "confirm", allUnique: true }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.affected).toBe(926);
    expect(svc.applyDecisions).toHaveBeenCalledWith("imp_x", {
      action: "confirm",
      allUnique: true,
    });
  });
});

describe("一键导入 quick", () => {
  it("零异常 → committed 透传摘要", async () => {
    svc.quickImport.mockResolvedValue({
      kind: "committed",
      batchId: "imp_q",
      summary: { workLevel: 38, accountDayLevel: 0, ignored: 0, external: 0, skippedRows: [] },
    });
    const res = await app.request("/import-batches/quick", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "c.csv",
        fileSize: 10,
        fileHash: "b".repeat(64),
        platform: "抖音",
        headers: ["作品名称", "发布时间"],
        rows: [["甲", "2026-09-20 18:00:00"]],
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.mode).toBe("committed");
    expect(data.summary.workLevel).toBe(38);
  });

  it("有异常 → manual_required 携批次号与原因（整批不入库）", async () => {
    svc.quickImport.mockResolvedValue({
      kind: "manual_required",
      batchId: "imp_q2",
      stats: {
        uniqueMatch: 3,
        conflict: 1,
        unmatched: 2,
        accountDayLevel: 0,
        confirmed: 0,
        ignored: 0,
      },
      reason: "存在 1 行冲突、2 行未匹配，一键模式整批不入库，请在四步工作台处理异常",
    });
    const res = await app.request("/import-batches/quick", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "c.csv",
        fileSize: 10,
        fileHash: "b".repeat(64),
        platform: "抖音",
        headers: ["作品名称", "发布时间"],
        rows: [["甲", "2026-09-20 18:00:00"]],
      }),
    });
    const data = await res.json();
    expect(data.mode).toBe("manual_required");
    expect(data.batchId).toBe("imp_q2");
    expect(data.reason).toContain("整批不入库");
  });

  it("账号日汇总 → account_day_denied（红线拒绝）", async () => {
    svc.quickImport.mockResolvedValue({
      kind: "account_day_denied",
      batchId: "imp_q3",
      reason: "账号日汇总",
    });
    const res = await app.request("/import-batches/quick", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename: "d.csv",
        fileSize: 10,
        fileHash: "b".repeat(64),
        platform: "抖音",
        headers: ["日期", "播放量"],
        rows: [["2026-09-20", "1200"]],
      }),
    });
    expect((await res.json()).mode).toBe("account_day_denied");
  });
});

describe("preflight · commit · rollback", () => {
  const report = {
    pass: false,
    checks: [
      { id: 4, name: "未处理 CONFLICT", level: "blocking", message: "仍有 2 行", rowIds: [7, 8] },
    ],
    counts: {
      workLevel: 0,
      accountDayLevel: 0,
      ignored: 0,
      external: 0,
      pendingUnique: 0,
      pendingConflict: 2,
      pendingUnmatched: 0,
    },
  };

  it("commit：preflight 不过 → 409 携完整报告（前端可定位阻断行）", async () => {
    svc.commitBatch.mockResolvedValue({ kind: "preflight_failed", report });
    const res = await app.request("/import-batches/imp_x/commit", { method: "POST" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("PREFLIGHT_FAILED");
    expect(body.report.checks[0].rowIds).toEqual([7, 8]);
  });

  it("commit：成功 200 携四类计数", async () => {
    svc.commitBatch.mockResolvedValue({
      kind: "committed",
      summary: { workLevel: 974, accountDayLevel: 18, ignored: 8, external: 2, skippedRows: [] },
    });
    const res = await app.request("/import-batches/imp_x/commit", { method: "POST" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.summary.workLevel).toBe(974);
  });

  it("rollback：未提交 409；成功 200", async () => {
    svc.rollbackBatch.mockResolvedValue({ kind: "not-committed" });
    expect((await app.request("/import-batches/imp_x/rollback", { method: "POST" })).status).toBe(
      409,
    );
    svc.rollbackBatch.mockResolvedValue({ kind: "rolled_back", records: 3, creatorDailyKeys: 1 });
    const ok = await app.request("/import-batches/imp_x/rollback", { method: "POST" });
    expect(ok.status).toBe(200);
    expect((await ok.json()).records).toBe(3);
  });
});
