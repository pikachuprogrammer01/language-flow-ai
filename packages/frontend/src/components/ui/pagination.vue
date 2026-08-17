<script setup lang="ts">
import {
  PaginationEllipsis,
  PaginationList,
  PaginationListItem,
  PaginationNext,
  PaginationPrev,
  PaginationRoot,
} from "radix-vue";
// shadcn-vue 风格分页（radix-vue Pagination 封装）：页码列表 = 当前页 ± siblings，首末保留，中间省略号
import { computed } from "vue";
import Button from "./button.vue";

function paginationItems(
  page: number,
  totalPages: number,
  siblings = 1,
  boundaries = 1,
): (number | "…")[] {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const set = new Set<number>();
  for (let i = 1; i <= boundaries; i++) {
    set.add(i);
    set.add(totalPages - i + 1);
  }
  for (let i = page - siblings; i <= page + siblings; i++) {
    if (i >= 1 && i <= totalPages) set.add(i);
  }
  const sorted = [...set].sort((a, b) => a - b);
  const result: (number | "…")[] = [];
  let prev = 0;
  for (const p of sorted) {
    if (prev && p - prev > 1) result.push("…");
    result.push(p);
    prev = p;
  }
  return result;
}

const props = defineProps<{ page: number; total: number; pageSize: number }>();
const emit = defineEmits<{ "update:page": [value: number] }>();
const totalPages = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)));
const items = computed(() => paginationItems(props.page, totalPages.value));
</script>

<template>
  <PaginationRoot
    :page="page"
    :total="total"
    :items-per-page="pageSize"
    @update:page="(p) => emit('update:page', p)"
  >
    <PaginationList class="flex items-center gap-1">
      <PaginationPrev as-child>
        <Button variant="outline" size="sm">上一页</Button>
      </PaginationPrev>
      <template v-for="(item, i) in items" :key="i">
        <PaginationListItem v-if="item !== '…'" as-child :value="item">
          <Button :variant="item === page ? 'default' : 'outline'" size="sm">{{ item }}</Button>
        </PaginationListItem>
        <PaginationEllipsis v-else />
      </template>
      <PaginationNext as-child>
        <Button variant="outline" size="sm">下一页</Button>
      </PaginationNext>
    </PaginationList>
  </PaginationRoot>
</template>
