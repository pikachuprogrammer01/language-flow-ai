/**
 * DataTable 纯逻辑层 — 分页窗口/选择集运算（无副作用，全部返回新值，便于单测与复用）
 */

/** 列定义：cell 渲染通过组件 #cell-<key> 插槽定制，缺省取 row[key] 文本 */
export interface DataTableColumn {
  key: string;
  label: string;
  /** th/td 固定宽度（如 "w-8"、"min-w-[220px]"） */
  cellClass?: string;
  align?: "left" | "center" | "right";
  /** 分组列：配合 groupKey 对连续同组行做 rowspan 合并（仅首行渲染、垂直居中） */
  group?: boolean;
}

/** 总页数（至少 1 页，空数据也显示第 1 页） */
export function totalPages(total: number, pageSize: number): number {
  if (pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}

/** 钳制页码到 [1, totalPages] */
export function clampPage(page: number, total: number, pageSize: number): number {
  return Math.min(Math.max(1, page), totalPages(total, pageSize));
}

/** 客户端分页切片：返回当前页行（immutable） */
export function slicePage<T>(rows: T[], page: number, pageSize: number): T[] {
  const start = (clampPage(page, rows.length, pageSize) - 1) * pageSize;
  return rows.slice(start, start + pageSize);
}

/**
 * 分页码序列：首尾恒显，当前页左右 window 个，间隙以 "…" 占位。
 * 例：pageItems(5, 100, 10) → [1, "…", 4, 5, 6, "…", 10]
 */
export function pageItems(
  page: number,
  total: number,
  pageSize: number,
  window = 1,
): (number | "…")[] {
  const last = totalPages(total, pageSize);
  if (last <= 7) return Array.from({ length: last }, (_, i) => i + 1);
  const items: (number | "…")[] = [];
  const from = Math.max(2, page - window);
  const to = Math.min(last - 1, page + window);
  items.push(1);
  if (from > 2) items.push("…");
  for (let p = from; p <= to; p += 1) items.push(p);
  if (to < last - 1) items.push("…");
  items.push(last);
  return items;
}

/** 切换单行选中（返回新 Set，不改入参） */
export function toggleSelection(selected: Set<string>, key: string): Set<string> {
  const next = new Set(selected);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** 全选/取消全选一组 key（返回新 Set） */
export function setPageSelection(selected: Set<string>, keys: string[], on: boolean): Set<string> {
  const next = new Set(selected);
  for (const key of keys) {
    if (on) next.add(key);
    else next.delete(key);
  }
  return next;
}

/** 当前页是否已全选（空页视为未全选） */
export function isPageAllSelected(selected: Set<string>, keys: string[]): boolean {
  return keys.length > 0 && keys.every((key) => selected.has(key));
}

/** 安全读取行字段用于默认单元格渲染（未知字段回退空串） */
export function cellText(row: object, key: string): string {
  const value = (row as Record<string, unknown>)[key];
  if (value == null) return "";
  return String(value);
}

/** 分组行元信息：span=组内总行数（仅首行使用），first=是否组首行 */
export interface GroupSpan {
  span: number;
  first: boolean;
}

/**
 * 连续同键行为一组（要求数据已按组排序）：
 * 首行 {span: 组大小, first: true}，后续行 {span: 0, first: false}。
 */
export function computeGroupSpans<T>(rows: T[], key: (row: T) => string): GroupSpan[] {
  const spans: GroupSpan[] = new Array<GroupSpan>(rows.length);
  let start = 0;
  for (let i = 0; i <= rows.length; i += 1) {
    if (i === rows.length || (i > 0 && key(rows[i]) !== key(rows[start]))) {
      for (let j = start; j < i; j += 1) {
        spans[j] = { span: j === start ? i - start : 0, first: j === start };
      }
      start = i;
    }
  }
  return spans;
}
