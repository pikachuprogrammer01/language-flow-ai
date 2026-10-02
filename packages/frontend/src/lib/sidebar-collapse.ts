/**
 * 侧边栏折叠态 —「完整」与「只剩图标」两态切换，跨刷新记住。
 *
 * 单例 ref：切换按钮挂在侧边栏右缘、导航项在 `<nav>` 内，两处模板必须共享同一状态
 * （与 lib/create-session.ts 同一惯例）。
 * 仅作用于 lg 以上：小屏侧边栏是抽屉形态，折叠对它没有意义，也不该与 drawerOpen 争状态。
 */
import { ref } from "vue";
import { safeWriteStorage } from "./analytics-state";

const STORAGE_KEY = "language-flow-sidebar-collapsed";

/** 只有 "1" 算折叠；脏值/无值/隐私模式读失败一律回展开（默认态必须可达） */
export function parseCollapsed(raw: string | null): boolean {
  return raw === "1";
}

export function serializeCollapsed(collapsed: boolean): string {
  return collapsed ? "1" : "0";
}

function readStored(): boolean {
  try {
    return parseCollapsed(localStorage.getItem(STORAGE_KEY));
  } catch {
    return false;
  }
}

const collapsed = ref(readStored());

export function useSidebarCollapse() {
  function toggle(): void {
    collapsed.value = !collapsed.value;
    safeWriteStorage(() => localStorage.setItem(STORAGE_KEY, serializeCollapsed(collapsed.value)));
  }

  return { collapsed, toggle };
}
