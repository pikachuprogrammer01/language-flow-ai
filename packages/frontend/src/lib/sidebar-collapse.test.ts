import { beforeEach, describe, expect, it } from "vitest";
import { parseCollapsed, serializeCollapsed, useSidebarCollapse } from "./sidebar-collapse";

describe("parseCollapsed / serializeCollapsed", () => {
  it("只有 1 算折叠，脏值与缺省回展开", () => {
    expect(parseCollapsed("1")).toBe(true);
    for (const raw of ["0", "", "true", "yes", null]) expect(parseCollapsed(raw)).toBe(false);
  });

  it("序列化与解析互为逆运算", () => {
    for (const value of [true, false])
      expect(parseCollapsed(serializeCollapsed(value))).toBe(value);
  });
});

describe("useSidebarCollapse", () => {
  beforeEach(() => localStorage.clear());

  it("切换后写入 localStorage，供刷新后恢复", () => {
    const first = useSidebarCollapse();
    const start = first.collapsed.value;
    first.toggle();
    expect(first.collapsed.value).toBe(!start);
    expect(localStorage.getItem("language-flow-sidebar-collapsed")).toBe(
      serializeCollapsed(!start),
    );
  });

  it("单例：任一处 toggle 后另一处读到同一状态", () => {
    const a = useSidebarCollapse();
    const b = useSidebarCollapse();
    const start = a.collapsed.value;
    a.toggle();
    expect(b.collapsed.value).toBe(!start);
    b.toggle();
    expect(a.collapsed.value).toBe(start);
  });
});
