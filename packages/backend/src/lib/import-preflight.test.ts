/**
 * import-preflight 测试 — STEP 4 十项校验（纯函数）
 * 阻断级：③重复导入 ④未处理CONFLICT ⑨非法数值 ⑩重复提交；其余 warning
 */
import { describe, expect, it } from "vitest";
import {
  type PreflightInput,
  type PreflightRowInput,
  runPreflightChecks,
} from "./import-preflight";

function row(over: Partial<PreflightRowInput> & { rowId: number }): PreflightRowInput {
  return {
    rowNumber: over.rowId,
    matchStatus: "confirmed",
    granularity: "work_level_strong",
    account: null,
    platform: "抖音",
    metricRaws: { 播放量: "100" },
    importTimeEpoch: Date.parse("2026-08-27T10:00:00Z"),
    ...over,
  };
}

function input(over: Partial<PreflightInput>): PreflightInput {
  return {
    batchId: "imp_test",
    fileHash: "abc",
    committedSameHash: false,
    alreadyCommitted: false,
    accountMapping: {},
    nowEpoch: Date.parse("2026-09-28T00:00:00Z"),
    rows: [],
    ...over,
  };
}

describe("runPreflightChecks", () => {
  it("干净批次：全部通过，计数正确", () => {
    const report = runPreflightChecks(
      input({
        rows: [
          row({
            rowId: 1,
            attributionKind: "video",
            confirmed: {
              videoId: "v1",
              videoPlatform: "抖音",
              videoPublishEpoch: Date.parse("2026-08-27T10:00:21Z"),
            },
          }),
          row({ rowId: 2, matchStatus: "ignored", metricRaws: {} }),
        ],
      }),
    );
    expect(report.pass).toBe(true);
    expect(report.counts.workLevel).toBe(1);
    expect(report.counts.ignored).toBe(1);
    expect(report.checks.every((c) => c.level !== "blocking")).toBe(true);
  });

  it("④ 未处理 CONFLICT → blocking 且定位行号", () => {
    const report = runPreflightChecks(
      input({
        rows: [
          row({ rowId: 7, matchStatus: "conflict" }),
          row({ rowId: 8, matchStatus: "unmatched", metricRaws: { 播放量: "5" } }),
        ],
      }),
    );
    const c4 = report.checks.find((c) => c.id === 4);
    expect(c4?.level).toBe("blocking");
    expect(c4?.rowIds).toEqual([7]);
    expect(report.pass).toBe(false);
    expect(report.counts.pendingUnmatched).toBe(1);
  });

  it("③ 同 hash 已提交批次 / ⑩ 本批已提交 → blocking", () => {
    const dup = runPreflightChecks(input({ committedSameHash: true }));
    expect(dup.checks.find((c) => c.id === 3)?.level).toBe("blocking");
    expect(dup.pass).toBe(false);
    const again = runPreflightChecks(input({ alreadyCommitted: true }));
    expect(again.checks.find((c) => c.id === 10)?.level).toBe("blocking");
  });

  it("⑨ 负数/非数值指标 → blocking；⑧ 缺播放量 → warning", () => {
    const report = runPreflightChecks(
      input({
        rows: [
          row({ rowId: 1, metricRaws: { 播放量: "-5" } }),
          row({ rowId: 2, metricRaws: { 点赞量: "abc" } }),
        ],
      }),
    );
    expect(report.checks.find((c) => c.id === 9)?.level).toBe("blocking");
    expect(report.checks.find((c) => c.id === 8)?.level).toBe("warning");
    expect(report.checks.find((c) => c.id === 8)?.rowIds).toContain(2);
  });

  it("⑤ 账号未映射 → warning 定位行", () => {
    const report = runPreflightChecks(
      input({
        accountMapping: { 主号: "A" },
        rows: [row({ rowId: 1, account: "主号" }), row({ rowId: 2, account: "小号" })],
      }),
    );
    const c5 = report.checks.find((c) => c.id === 5);
    expect(c5?.level).toBe("warning");
    expect(c5?.rowIds).toEqual([2]);
  });

  it("⑥ 平台不一致 / ⑦ 时间差超 24h 或未来时间 → warning", () => {
    const report = runPreflightChecks(
      input({
        rows: [
          row({
            rowId: 1,
            platform: "快手",
            attributionKind: "video",
            confirmed: {
              videoId: "v1",
              videoPlatform: "抖音",
              videoPublishEpoch: Date.parse("2026-08-27T10:00:00Z"),
            },
          }),
          row({
            rowId: 2,
            importTimeEpoch: Date.parse("2026-08-25T10:00:00Z"),
            attributionKind: "video",
            confirmed: {
              videoId: "v2",
              videoPlatform: "抖音",
              videoPublishEpoch: Date.parse("2026-08-27T10:00:00Z"),
            },
          }),
          row({ rowId: 3, importTimeEpoch: Date.parse("2027-01-01T00:00:00Z") }),
        ],
      }),
    );
    expect(report.checks.find((c) => c.id === 6)?.rowIds).toEqual([1]);
    expect(report.checks.find((c) => c.id === 7)?.rowIds).toEqual([2, 3]);
    expect(report.pass).toBe(true); // warning 不阻断
  });

  it("② 多行确认到同一视频 → warning 列出全部行", () => {
    const confirmed = { videoId: "v1", videoPlatform: "抖音", videoPublishEpoch: null };
    const report = runPreflightChecks(
      input({
        rows: [
          row({ rowId: 1, attributionKind: "video", confirmed }),
          row({ rowId: 2, attributionKind: "video", confirmed }),
        ],
      }),
    );
    const c2 = report.checks.find((c) => c.id === 2);
    expect(c2?.level).toBe("warning");
    expect(c2?.rowIds).toEqual([1, 2]);
  });

  it("① 作品级 confirmed 行缺失目标视频（数据不一致）→ blocking", () => {
    const report = runPreflightChecks(
      input({ rows: [row({ rowId: 5, attributionKind: "video" })] }),
    );
    expect(report.checks.find((c) => c.id === 1)?.level).toBe("blocking");
    expect(report.checks.find((c) => c.id === 1)?.rowIds).toEqual([5]);
    expect(report.pass).toBe(false);
  });

  it("账号日级批次计数归入 accountDayLevel（未处理与已确认都算账号级，不进作品级）", () => {
    const report = runPreflightChecks(
      input({
        rows: [
          row({ rowId: 1, matchStatus: "account_day_level", granularity: "account_day_level" }),
          row({
            rowId: 2,
            matchStatus: "confirmed",
            granularity: "account_day_level",
            attributionKind: "account_day",
          }),
        ],
      }),
    );
    expect(report.counts.accountDayLevel).toBe(2);
    expect(report.counts.workLevel).toBe(0);
  });
});
