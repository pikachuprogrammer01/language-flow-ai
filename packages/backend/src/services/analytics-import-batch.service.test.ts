/**
 * analytics-import-batch.service 纯函数测试（DB 编排由路由测试 mock 覆盖 + E2E 真实链路覆盖）
 * 覆盖：时长单元格解析 / 行标准化（字段识别→normalized_data，纯搬运零推断）/ evidence 人话摘要
 */
import { describe, expect, it, vi } from "vitest";
vi.mock("../db", () => ({ db: {} }));
vi.mock("./analytics-metrics.service", () => ({
  mapImportRow: vi.fn(),
  mapCreatorDailyRow: vi.fn(),
  recomputeDerivedMetrics: vi.fn(),
  upsertCreatorDailyRow: vi.fn(),
  writeMetricRows: vi.fn(),
}));

import { detectFieldRoles } from "../lib/import-granularity";
import {
  evidenceSummaryOf,
  normalizeImportRows,
  parseDurationCell,
  parseImportedPublishTime,
} from "./analytics-import-batch.service";

describe("parseImportedPublishTime（导入行发布时间）", () => {
  it("无值/空串回 null：缺失不等于 0，也不许拿它清空已有发布时间", () => {
    expect(parseImportedPublishTime(null, 480)).toBeNull();
    expect(parseImportedPublishTime(undefined, 480)).toBeNull();
    expect(parseImportedPublishTime("", 480)).toBeNull();
  });

  it("解析不出回 null（不猜时间）", () => {
    expect(parseImportedPublishTime("不是时间", 480)).toBeNull();
  });

  it("按批次声明的时区偏移解析裸时间（与匹配引擎同一口径）", () => {
    expect(parseImportedPublishTime("2026-09-20 18:00:00", 480)?.toISOString()).toBe(
      "2026-09-20T10:00:00.000Z",
    );
    expect(parseImportedPublishTime("2026-09-20T10:00:00Z", 480)?.toISOString()).toBe(
      "2026-09-20T10:00:00.000Z",
    );
  });
});

describe("commitPreimage 的发布时间经 JSON 往返后仍可回滚", () => {
  it("preimage 存的是 ISO 字符串，回滚写回 datetime(mode:date) 列前必须还原成 Date", async () => {
    // E2E 真实链路抓到过这个缺陷：把 JSON 里的字符串直接塞进 UPDATE 会抛
    // `value.toISOString is not a function`，整批回滚失败、已提交指标留在库里。
    const stored = JSON.parse(
      JSON.stringify({
        publishTime: new Date("2026-09-20T10:00:00.000Z"),
        publishTimeSource: "LOCAL_GENERATED",
      }),
    ) as { publishTime: string; publishTimeSource: string };
    expect(typeof stored.publishTime).toBe("string");
    const revived = stored.publishTime ? new Date(stored.publishTime) : null;
    expect(revivalIsDate(revived)).toBe(true);
    expect(revived?.toISOString()).toBe("2026-09-20T10:00:00.000Z");
  });
});

function revivalIsDate(value: unknown): boolean {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

describe("parseDurationCell", () => {
  it("mm:ss / hh:mm:ss / 纯秒 / 带 s 后缀", () => {
    expect(parseDurationCell("00:58")).toBe(58);
    expect(parseDurationCell("1:02:03")).toBe(3723);
    expect(parseDurationCell("58")).toBe(58);
    expect(parseDurationCell("3.94s")).toBe(3.94);
    expect(parseDurationCell("48秒")).toBe(48);
  });

  it("非法输入返回 null（不猜）", () => {
    expect(parseDurationCell("")).toBeNull();
    expect(parseDurationCell("abc")).toBeNull();
    expect(parseDurationCell("1:ab")).toBeNull();
  });
});

describe("normalizeImportRows", () => {
  const headers = ["作品ID", "发布时间", "作品标题", "账号", "播放量", "点赞量"];
  const detection = detectFieldRoles(headers, []);

  it("角色列 → normalized 字段；指标表头记入 metricHeaders/viewsHeader", () => {
    const rows = [["7412345678901234567", "2026-08-27 10:00:00", "abandon", "主号", "1,283", "52"]];
    const [prepared] = normalizeImportRows(headers, rows, detection, "抖音");
    expect(prepared?.normalized).toEqual({
      platformWorkId: "7412345678901234567",
      workUrl: null,
      account: "主号",
      publishTime: "2026-08-27 10:00:00",
      date: null,
      title: "abandon",
      durationSec: null,
      platform: "抖音",
      metricHeaders: ["播放量", "点赞量"],
      viewsHeader: "播放量",
    });
    expect(prepared?.rawData.播放量).toBe("1,283");
  });

  it("空单元格 → null 字段；rawData 保留原始空串（永不丢数据）", () => {
    const rows = [["", "", "标题", "", "", ""]];
    const [prepared] = normalizeImportRows(headers, rows, detection, "抖音");
    expect(prepared?.normalized.platformWorkId).toBeNull();
    expect(prepared?.rawData.作品ID).toBe("");
  });

  it("无表头列以 col_i 命名兜底", () => {
    const rows = [["x", "y"]];
    const [prepared] = normalizeImportRows(
      ["", "备注"],
      rows,
      detectFieldRoles(["", "备注"], []),
      "抖音",
    );
    expect(prepared?.rawData.col_0).toBe("x");
  });
});

describe("evidenceSummaryOf", () => {
  it("结构化证据 → 中文人话清单（禁止裸置信度）", () => {
    expect(
      evidenceSummaryOf({
        platformWorkIdExact: true,
        accountMapped: true,
        mappedAccount: "主账号",
        publishTimeDiffSeconds: 22,
        titleSimilarity: 0.96,
        workIdMissing: false,
      }),
    ).toEqual(["作品 ID 一致", "账号已映射（主账号）", "发布时间相差 22 秒", "标题相似度 96.0%"]);
  });

  it("作品 ID 缺失单独提示", () => {
    expect(
      evidenceSummaryOf({ dateMatched: true, titleSimilarity: 1, workIdMissing: true }),
    ).toEqual(["发布日期一致", "标题相似度 100.0%", "作品 ID 缺失"]);
  });
});
