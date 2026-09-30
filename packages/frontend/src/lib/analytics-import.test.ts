/**
 * parsePastedTable 测试（批次 H2：旧向导专属函数已随组件删除，解析器由四步导入工作台复用）
 */
import { describe, expect, it } from "vitest";
import { parsePastedTable } from "./analytics-import";

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
