/** data-table 纯逻辑层单测 */
import { describe, expect, it } from "vitest";
import {
  cellText,
  clampPage,
  computeGroupSpans,
  isPageAllSelected,
  pageItems,
  setPageSelection,
  slicePage,
  toggleSelection,
  totalPages,
} from "./data-table";

describe("totalPages / clampPage", () => {
  it("空数据也有 1 页；非法 pageSize 回退 1 页", () => {
    expect(totalPages(0, 10)).toBe(1);
    expect(totalPages(21, 10)).toBe(3);
    expect(totalPages(5, 0)).toBe(1);
    expect(clampPage(9, 25, 10)).toBe(3);
    expect(clampPage(-2, 25, 10)).toBe(1);
  });
});

describe("slicePage", () => {
  const rows = Array.from({ length: 25 }, (_, i) => i);
  it("按页切片且不改动入参", () => {
    expect(slicePage(rows, 2, 10)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(slicePage(rows, 3, 10)).toEqual([20, 21, 22, 23, 24]);
    expect(rows.length).toBe(25);
  });
});

describe("pageItems", () => {
  it("页数少时全列出", () => {
    expect(pageItems(2, 30, 10)).toEqual([1, 2, 3]);
  });
  it("页数多时首尾恒显 + 窗口 + 省略号", () => {
    expect(pageItems(5, 100, 10)).toEqual([1, "…", 4, 5, 6, "…", 10]);
    expect(pageItems(1, 100, 10)).toEqual([1, 2, "…", 10]);
    expect(pageItems(10, 100, 10)).toEqual([1, "…", 9, 10]);
  });
});

describe("选择集运算（immutable）", () => {
  it("toggle 返回新 Set，不改入参", () => {
    const base = new Set(["a"]);
    const next = toggleSelection(base, "b");
    expect([...next].sort()).toEqual(["a", "b"]);
    expect(toggleSelection(next, "a").has("a")).toBe(false);
    expect(base).toEqual(new Set(["a"]));
  });
  it("setPageSelection 批量增删", () => {
    const next = setPageSelection(new Set<string>(["x"]), ["a", "b"], true);
    expect([...next].sort()).toEqual(["a", "b", "x"]);
    expect([...setPageSelection(next, ["a"], false)].sort()).toEqual(["b", "x"]);
  });
  it("空页不算全选", () => {
    expect(isPageAllSelected(new Set<string>(), [])).toBe(false);
    expect(isPageAllSelected(new Set<string>(["a"]), ["a"])).toBe(true);
    expect(isPageAllSelected(new Set<string>(["a"]), ["a", "b"])).toBe(false);
  });
});

describe("cellText", () => {
  it("null/undefined 回退空串，其余转字符串", () => {
    expect(cellText({ a: 1, b: null }, "a")).toBe("1");
    expect(cellText({ a: 1 }, "missing")).toBe("");
    expect(cellText({ a: null }, "a")).toBe("");
  });
});

describe("computeGroupSpans", () => {
  it("连续同键合并：首行 span=组大小，后续行 span=0", () => {
    const rows = [{ g: "a" }, { g: "a" }, { g: "b" }, { g: "a" }];
    const spans = computeGroupSpans(rows, (r) => r.g);
    expect(spans).toEqual([
      { span: 2, first: true },
      { span: 0, first: false },
      { span: 1, first: true },
      { span: 1, first: true },
    ]);
  });
  it("空行集返回空；单行 span=1", () => {
    expect(computeGroupSpans([], () => "x")).toEqual([]);
    expect(computeGroupSpans([1], () => "x")).toEqual([{ span: 1, first: true }]);
  });
});
