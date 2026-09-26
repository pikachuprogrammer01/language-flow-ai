import { describe, expect, it } from "vitest";
import type { CreatorDailyFieldEntry, MetricCatalogEntry } from "../api/client";
import {
  autoMatchColumns,
  autoMatchCreatorDaily,
  buildImportRows,
  buildMetricMapping,
  detectTableKind,
  mappedCount,
  matchRowByDate,
  normalizeDateCell,
  parsePastedTable,
  recordDateKey,
  sheetToParsedTable,
} from "./analytics-import";

const CATALOG: MetricCatalogEntry[] = [
  {
    name: "play_count",
    label: "播放量",
    unit: "count",
    availability: "IMPORT_ONLY",
    importable: true,
  },
  {
    name: "completion_rate",
    label: "完播率",
    unit: "rate",
    availability: "IMPORT_ONLY",
    importable: true,
  },
  {
    name: "new_fan_count",
    label: "新增粉丝（视频级）",
    unit: "count",
    availability: "IMPORT_ONLY",
    importable: true,
  },
  {
    name: "like_rate",
    label: "点赞率",
    unit: "rate",
    availability: "DERIVED",
    importable: false,
  },
];

describe("parsePastedTable", () => {
  it("制表符分隔（创作者后台复制）：首行表头，行列对齐", () => {
    const table = parsePastedTable(
      "作品名称\t作品ID\t播放量\t完播率\n机场英语\t7432123456789012345\t12000\t36%\n点餐会话\t7432987654321098765\t8000\t41.3%",
    );
    expect(table).not.toBeNull();
    expect(table?.delimiter).toBe("\\t");
    expect(table?.headers).toEqual(["作品名称", "作品ID", "播放量", "完播率"]);
    expect(table?.rows).toHaveLength(2);
    expect(table?.rows[1]).toEqual(["点餐会话", "7432987654321098765", "8000", "41.3%"]);
  });

  it("CSV 逗号 + 引号包裹 + 尾随空行 + BOM：全部清洗", () => {
    const table = parsePastedTable('﻿标题,播放量\n"错过登机",12000\n\n');
    expect(table?.headers).toEqual(["标题", "播放量"]);
    expect(table?.rows).toEqual([["错过登机", "12000"]]);
  });

  it("数据行缺列 → 补空串对齐表头宽度", () => {
    const table = parsePastedTable("a\tb\tc\n1\t2");
    expect(table?.rows[0]).toEqual(["1", "2", ""]);
  });

  it("不足两行 / 单列表头 → null（无数据 ≠ 强解析）", () => {
    expect(parsePastedTable("只有一行表头")).toBeNull();
    expect(parsePastedTable("")).toBeNull();
    expect(parsePastedTable("标题\n机场英语")).toBeNull();
  });
});

describe("autoMatchColumns", () => {
  it("目录 label 精确命中优先；别名表兜底；都不中为 null", () => {
    const mapping = autoMatchColumns(["播放量", "播放数", "作品ID", "点赞率", "奇怪列"], CATALOG);
    expect(mapping).toEqual(["play_count", "play_count", null, null, null]);
  });

  it("DERIVED（importable=false）指标永不作为映射目标", () => {
    const mapping = autoMatchColumns(["点赞率"], CATALOG);
    expect(mapping).toEqual([null]);
  });

  it("label 包含式模糊匹配（完播率(%) → completion_rate）", () => {
    const mapping = autoMatchColumns(["完播率(%)"], CATALOG);
    expect(mapping).toEqual(["completion_rate"]);
  });
});

describe("buildImportRows / buildMetricMapping", () => {
  const table = parsePastedTable(
    "作品名称\t作品ID\t播放量\t完播率\n机场英语\t7432123456789012345\t12,000\t36%",
  );
  if (table === null) throw new Error("fixture 解析失败");

  it("values 键用原始表头；千分位数字转 number；百分号串透传给后端清洗", () => {
    const rows = buildImportRows(table, 1, [null, null, "play_count", "completion_rate"]);
    expect(rows[0].match).toEqual({ platformVideoId: "7432123456789012345" });
    expect(rows[0].values).toEqual({ 播放量: 12000, 完播率: "36%" });
  });

  it("未映射列与空单元格都不进 values", () => {
    const rows = buildImportRows(table, 1, ["play_count", null, null, null]);
    // 第 0 列被映射为 play_count（错误映射演示）：值透传，合法性由后端把关
    expect(rows[0].values).toEqual({ 作品名称: "机场英语" });
  });

  it("metricMapping 只包含已映射列", () => {
    const mapping = buildMetricMapping(table.headers, [
      null,
      null,
      "play_count",
      "completion_rate",
    ]);
    expect(mapping).toEqual({ 播放量: "play_count", 完播率: "completion_rate" });
    expect(mappedCount([null, null, "play_count", "completion_rate"])).toBe(2);
  });
});

describe("normalizeDateCell / recordDateKey（年月日粒度，不做时分秒对齐）", () => {
  it("多格式日期归一为 YYYY-MM-DD", () => {
    expect(normalizeDateCell("2026-09-17")).toBe("2026-09-17");
    expect(normalizeDateCell("2026/9/7")).toBe("2026-09-07");
    expect(normalizeDateCell("2026.09.20 00:00:00")).toBe("2026-09-20");
    expect(normalizeDateCell("09-17")).toBeNull();
    expect(normalizeDateCell("2026-13-01")).toBeNull();
  });

  it("发布记录归日：发布时间优先，缺失回退创建时间", () => {
    expect(recordDateKey("2026-09-20T18:00:00.000Z", "2026-09-01T00:00:00Z")).toBe("2026-09-20");
    expect(recordDateKey(null, "2026-09-01T23:59:59Z")).toBe("2026-09-01");
  });
});

const DAILY_FIELDS: CreatorDailyFieldEntry[] = [
  { name: "playIncrement", label: "播放量（当日）", unit: "count" },
  { name: "watchRate5s", label: "5秒完播率", unit: "rate" },
  { name: "coverClickRate", label: "封面点击率", unit: "rate" },
  { name: "postCount", label: "投稿量（当日）", unit: "count" },
];

describe("autoMatchCreatorDaily（真实「全量指标」表头预匹配）", () => {
  it("目录 label 精确 + 别名表命中，无关列为 null", () => {
    const mapping = autoMatchCreatorDaily(
      ["日期", "投稿量", "总播放量", "5秒完播率", "封面点击率", "神秘列"],
      DAILY_FIELDS,
    );
    expect(mapping).toEqual([
      null,
      "postCount",
      "playIncrement",
      "watchRate5s",
      "coverClickRate",
      null,
    ]);
  });
});

describe("matchRowByDate（自动匹配 + 人工确认三态，系统绝不拆数）", () => {
  const one = [{ recordId: "r1", label: "机场英语（抖音）" }];
  const two = [
    { recordId: "r1", label: "A" },
    { recordId: "r2", label: "B" },
  ];

  it("当日 1 条且设置=1 → unique 预选", () => {
    const v = matchRowByDate(one, 1);
    expect(v.status).toBe("unique");
    expect(v.suggestedRecordId).toBe("r1");
    expect(v.warning).toBeNull();
  });

  it("当日多条 → ambiguous 不预选（必人工裁决），超条数设置额外提醒", () => {
    const v = matchRowByDate(two, 1);
    expect(v.status).toBe("ambiguous");
    expect(v.suggestedRecordId).toBeNull();
    expect(v.warning).toContain("超过一天的条数设置");
  });

  it("当日 0 条 → none（默认仅账号级）；未绑定作品 ID 的记录不参与自动匹配（向导层过滤）", () => {
    const v = matchRowByDate([], 1);
    expect(v.status).toBe("none");
    expect(v.warning).toContain("当日无发布记录");
  });

  it("设置=2 而当日仅 1 条 → 仍 unique 但条数不符警告", () => {
    const v = matchRowByDate(one, 2);
    expect(v.status).toBe("unique");
    expect(v.warning).toContain("少于一天的条数设置");
  });
});

describe("detectTableKind / sheetToParsedTable", () => {
  it("有作品 ID 列 → video；有日期列无 ID → creator-daily", () => {
    const video = parsePastedTable("作品ID\t播放量\n123\t100");
    const daily = parsePastedTable("日期\t总播放量\n2026-09-17\t708");
    expect(video !== null && detectTableKind(video)).toBe("video");
    expect(daily !== null && detectTableKind(daily)).toBe("creator-daily");
  });

  it("表头无明示时按首列值判日期", () => {
    const t = parsePastedTable("X\tY\n2026-09-17\t708");
    expect(t !== null && detectTableKind(t)).toBe("creator-daily");
  });

  it("xlsx 二维数组：Date 单元格 → YYYY-MM-DD，数字转字符串，行列对齐", () => {
    const matrix: unknown[][] = [
      ["日期", "总播放量", "平均播放时长"],
      [new Date(Date.UTC(2026, 8, 17)), 708, 3.94],
      [null, "1,200", ""],
    ];
    const table = sheetToParsedTable(matrix, (cell) => {
      if (cell instanceof Date && !Number.isNaN(cell.getTime())) {
        return cell.toISOString().slice(0, 10);
      }
      return typeof cell === "string" ? normalizeDateCell(cell) : null;
    });
    expect(table?.delimiter).toBe("xlsx");
    expect(table?.headers).toEqual(["日期", "总播放量", "平均播放时长"]);
    expect(table?.rows[0]).toEqual(["2026-09-17", "708", "3.94"]);
    expect(table?.rows[1]).toEqual(["", "1,200", ""]);
  });

  it("不足两行的工作表 → null", () => {
    expect(sheetToParsedTable([["只有表头", "两列"]], () => null)).toBeNull();
  });
});
