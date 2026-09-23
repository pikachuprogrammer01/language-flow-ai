<script setup lang="ts" generic="T extends object">
/**
 * DataTable — 全站统一表格组件（原型 .table-card 风格）
 * 能力：列插槽自定义 / 勾选列 + 当前页全选 / 分页 + 每页条数 / 展开行 / 选中高亮 / 行点击
 * 分页双模式：传 total = 服务端分页（rows 即当前页）；不传 = 客户端分页（内部切片）
 * 纯展示受控组件：所有状态（page/selected/expanded）由父组件持有，本组件零副作用只发事件
 */
import { computed, useAttrs } from "vue";
import {
  type DataTableColumn,
  cellText,
  computeGroupSpans,
  isPageAllSelected,
  pageItems,
  setPageSelection,
  slicePage,
  toggleSelection,
  totalPages,
} from "../../lib/data-table";

const props = withDefaults(
  defineProps<{
    columns: DataTableColumn[];
    rows: T[];
    /** 行唯一键取值函数 */
    rowKey: (row: T) => string;
    /** 服务端总条数；不传则按 rows.length 客户端分页 */
    total?: number;
    page?: number;
    pageSize?: number;
    pageSizeOptions?: number[];
    loading?: boolean;
    emptyText?: string;
    selectable?: boolean;
    selected?: Set<string>;
    /** 展开行的 key 集合（配合 #expand 插槽） */
    expanded?: Set<string>;
    /** 持续高亮的行 key（如发布管理联动选中行） */
    activeKey?: string;
    /** 分组键：提供时对 group 列做连续同组 rowspan 合并（数据需已按组排序） */
    groupKey?: (row: T) => string;
  }>(),
  {
    total: undefined,
    page: 1,
    pageSize: 10,
    pageSizeOptions: () => [10, 20, 50, 100],
    loading: false,
    emptyText: "暂无数据",
    selectable: false,
    selected: () => new Set<string>(),
    expanded: () => new Set<string>(),
    activeKey: "",
    groupKey: undefined,
  },
);

const emit = defineEmits<{
  "update:page": [page: number];
  "update:pageSize": [size: number];
  "update:selected": [selected: Set<string>];
  "update:expanded": [expanded: Set<string>];
  "row-click": [row: T];
}>();

const serverMode = computed(() => props.total != null);
/** 行可点：父组件绑定了 @row-click 才显示手型（真实检测，非占位） */
const attrs = useAttrs();
const clickable = computed(() => "onRowClick" in attrs);
const realTotal = computed(() => props.total ?? props.rows.length);
const visibleRows = computed(() =>
  serverMode.value ? props.rows : slicePage(props.rows, props.page, props.pageSize),
);
const pageKeys = computed(() => visibleRows.value.map((row) => props.rowKey(row)));
const allChecked = computed(() => isPageAllSelected(props.selected, pageKeys.value));
const colSpan = computed(() => props.columns.length + (props.selectable ? 1 : 0));
/** 分组元信息（仅当前页）：无 groupKey 时为 null，分组列退化为普通列 */
const groupSpans = computed(() =>
  props.groupKey ? computeGroupSpans(visibleRows.value, props.groupKey) : null,
);
/** 该单元格是否渲染（分组列非首行跳过） */
function cellShown(col: DataTableColumn, index: number): boolean {
  if (!col.group || !groupSpans.value) return true;
  return groupSpans.value[index].first;
}

function onToggleRow(row: T): void {
  emit("update:selected", toggleSelection(props.selected, props.rowKey(row)));
}
function onToggleAll(): void {
  emit("update:selected", setPageSelection(props.selected, pageKeys.value, !allChecked.value));
}
function onPageSize(event: Event): void {
  const size = Number((event.target as HTMLSelectElement).value);
  emit("update:pageSize", size);
  emit("update:page", 1); // 换条数回第一页（避免停留在越界页）
}
</script>

<template>
  <div class="overflow-hidden rounded-2xl border border-hairline bg-panel">
    <div class="overflow-x-auto">
      <table class="w-full border-collapse text-left text-[13px]">
        <thead class="bg-[#fafbfc] text-subtle">
          <tr>
            <th v-if="selectable" class="w-8 border-b border-hairline px-2 py-[13px]">
              <input type="checkbox" :checked="allChecked" @change="onToggleAll" />
            </th>
            <th
              v-for="col in columns"
              :key="col.key"
              class="whitespace-nowrap border-b border-hairline px-3.5 py-[13px] font-semibold"
              :class="[col.cellClass, col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : '']"
            >
              {{ col.label }}
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-hairline">
          <tr v-if="loading">
            <td :colspan="colSpan" class="px-3.5 py-10 text-center text-subtle">加载中…</td>
          </tr>
          <tr v-else-if="visibleRows.length === 0">
            <td :colspan="colSpan" class="px-3.5 py-10 text-center text-gray-400">{{ emptyText }}</td>
          </tr>
          <template v-else>
            <template v-for="(row, ri) in visibleRows" :key="rowKey(row)">
              <tr
                class="transition-colors"
                :class="[
                  rowKey(row) === activeKey ? 'bg-brand-soft' : 'hover:bg-brand-soft/40',
                  clickable ? 'cursor-pointer' : '',
                ]"
                @click="emit('row-click', row)"
              >
                <td v-if="selectable" class="px-2 py-[13px]" @click.stop>
                  <input
                    type="checkbox"
                    :checked="selected.has(rowKey(row))"
                    @change="onToggleRow(row)"
                  />
                </td>
                <template v-for="col in columns" :key="col.key">
                  <td
                    v-if="cellShown(col, ri)"
                    :rowspan="
                      col.group && groupSpans && groupSpans[ri].span > 1 ? groupSpans[ri].span : undefined
                    "
                    class="px-3.5 py-[13px] align-middle"
                    :class="[
                      col.cellClass,
                      col.align === 'right' ? 'text-right' : col.align === 'center' ? 'text-center' : '',
                      col.group ? 'align-middle' : '',
                    ]"
                  >
                    <!-- 自定义单元格插槽：#cell-<key>="{ row }"；缺省渲染 row[key] 文本 -->
                    <slot :name="`cell-${col.key}`" :row="row">
                      {{ cellText(row, col.key) }}
                    </slot>
                  </td>
                </template>
              </tr>
              <!-- 展开行（#expand 插槽存在且该行 key 在 expanded 集合内） -->
              <tr v-if="expanded.has(rowKey(row))">
                <td :colspan="colSpan" class="bg-shell px-3.5 py-3">
                  <slot name="expand" :row="row" />
                </td>
              </tr>
            </template>
          </template>
        </tbody>
      </table>
    </div>

    <!-- 分页栏：总条数 + 每页条数 + 页码 -->
    <div class="flex flex-wrap items-center justify-between gap-3 border-t border-hairline px-3.5 py-2.5 text-xs text-subtle">
      <span>共 {{ realTotal }} 条</span>
      <div class="flex items-center gap-3">
        <label class="flex items-center gap-1.5">
          每页
          <select
            :value="pageSize"
            class="cursor-pointer rounded border border-hairline bg-white px-1.5 py-1 text-xs focus:border-brand focus:outline-none"
            @change="onPageSize"
          >
            <option v-for="size in pageSizeOptions" :key="size" :value="size">{{ size }}</option>
          </select>
        </label>
        <div class="flex items-center gap-1">
          <!-- 上一页/下一页：边界禁用 -->
          <button
            class="min-w-7 cursor-pointer rounded-[8px] border px-1.5 py-1"
            :class="page <= 1 ? 'border-hairline bg-white text-gray-300' : 'border-hairline bg-white hover:bg-gray-100'"
            :disabled="page <= 1"
            title="上一页"
            @click="emit('update:page', Math.max(1, page - 1))"
          >
            ‹
          </button>
          <button
            v-for="item in pageItems(page, realTotal, pageSize)"
            :key="String(item)"
            class="min-w-7 cursor-pointer rounded-[8px] border px-1.5 py-1"
            :class="item === page ? 'border-brand bg-brand-soft font-semibold text-brand' : 'border-transparent hover:bg-gray-100'"
            :disabled="item === '…'"
            @click="typeof item === 'number' && emit('update:page', item)"
          >
            {{ item }}
          </button>
          <button
            class="min-w-7 cursor-pointer rounded-[8px] border px-1.5 py-1"
            :class="page >= totalPages(realTotal, pageSize) ? 'border-hairline bg-white text-gray-300' : 'border-hairline bg-white hover:bg-gray-100'"
            :disabled="page >= totalPages(realTotal, pageSize)"
            title="下一页"
            @click="emit('update:page', Math.min(totalPages(realTotal, pageSize), page + 1))"
          >
            ›
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
