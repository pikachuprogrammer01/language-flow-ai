/**
 * tailwind-merge 工具单测 — cn 类名合并与冲突覆盖（全站组件共用）
 */
import { describe, expect, it } from "vitest";
import { cn } from "./utils";

describe("cn", () => {
  it("合并并去重冲突类：后者优先", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });
  it("falsy 值跳过（条件类名惯用写法）", () => {
    expect(cn("text-sm", false, undefined, "font-bold")).toBe("text-sm font-bold");
  });
});
