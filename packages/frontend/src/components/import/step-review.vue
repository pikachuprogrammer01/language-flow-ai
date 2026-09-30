<script setup lang="ts">
import { CheckCheck, RefreshCw, Search, SkipForward, UserRoundSearch } from "lucide-vue-next";
/**
 * STEP 3 匹配校验（核心页）：统计卡筛选 + 批量操作 + 高密度匹配表 + 行选中联动右栏
 * 状态只用六枚举；UNIQUE_MATCH 默认勾选支持一键批量确认；
 * CONFLICT/UNMATCHED/ACCOUNT_DAY_LEVEL 的处理动作在右侧详情面板（本页不逐行下拉框——旧方案已禁止）。
 */
import { computed, ref } from "vue";
import type {
  ImportBatchStats,
  ImportBatchView,
  ImportRowListItem,
  ImportRowStatus,
} from "../../api/client";
import { formatDuration, statusPillMeta } from "../../lib/import-batch";
import Button from "../ui/button.vue";
import Select from "../ui/select.vue";
import Spinner from "../ui/spinner.vue";

const props = defineProps<{
  view: ImportBatchView;
  items: ImportRowListItem[];
  total: number;
  page: number;
  pageSize: number;
  statusFilter: string;
  keyword: string;
  loading: boolean;
  busy: boolean;
  selectedRowId: number | null;
}>();

const emit = defineEmits<{
  filter: [status: string];
  search: [keyword: string];
  page: [page: number];
  pageSize: [size: number];
  select: [row: ImportRowListItem];
  confirmAllUnique: [];
  batchIgnore: [rowIds: number[]];
  batchAccountDay: [rowIds: number[]];
  rematch: [];
  next: [];
}>();

const isAccountDayBatch = computed(() => props.view.dataGranularity === "account_day_level");

/** 统计卡计数（全部 = 六态总和） */
const cards = computed(() => {
  const s: ImportBatchStats = props.view.stats;
  const all =
    s.uniqueMatch + s.conflict + s.unmatched + s.accountDayLevel + s.confirmed + s.ignored;
  return [
    { key: "all", label: "全部", value: all, tone: "text-ink" },
    { key: "unique_match", label: "唯一匹配", value: s.uniqueMatch, tone: "text-green-600" },
    { key: "conflict", label: "待确认", value: s.conflict, tone: "text-amber-600" },
    { key: "unmatched", label: "未匹配", value: s.unmatched, tone: "text-red-600" },
    {
      key: "account_day_level",
      label: "账号日级",
      value: s.accountDayLevel,
      tone: "text-blue-600",
    },
  ];
});

function onCardClick(key: string): void {
  emit("filter", key === props.statusFilter ? "all" : key);
}

// ── 行选择（批量操作用） ──
const checked = ref<Set<number>>(new Set());

function toggleRow(rowId: number, value: boolean): void {
  const next = new Set(checked.value);
  if (value) next.add(rowId);
  else next.delete(rowId);
  checked.value = next;
}

const pageIds = computed(() => props.items.map((i) => i.rowId));
const allChecked = computed(
  () => pageIds.value.length > 0 && pageIds.value.every((id) => checked.value.has(id)),
);

function toggleAll(event: Event): void {
  const value = (event.target as HTMLInputElement).checked;
  for (const id of pageIds.value) toggleRow(id, value);
}

const checkedIds = computed(() => [...checked.value]);

const searchInput = ref(props.keyword);

const pageSizeOptions = [
  { value: "10", label: "每页 10 条" },
  { value: "20", label: "每页 20 条" },
  { value: "50", label: "每页 50 条" },
  { value: "100", label: "每页 100 条" },
];

const totalPages = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)));

function pillClass(status: ImportRowStatus): string {
  const tone = statusPillMeta(status).tone;
  switch (tone) {
    case "success":
      return "bg-green-50 text-green-700";
    case "warning":
      return "bg-amber-50 text-amber-700";
    case "danger":
      return "bg-red-50 text-red-600";
    case "info":
      return "bg-blue-50 text-blue-700";
    default:
      return "bg-gray-100 text-subtle";
  }
}

function fmtTime(iso: string | null): string {
  if (iso === null) return "—";
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}
</script>

<template>
  <div class="flex min-h-0 gap-3">
    <!-- 主列：统计卡 + 工具条 + 高密度表 -->
    <div class="min-w-0 flex-1 rounded-2xl border border-hairline bg-panel p-3">
      <div class="mb-2.5 flex items-center justify-between">
        <h2 class="text-[15px] font-bold">③ 匹配校验</h2>
        <span class="text-xs text-subtle">系统自动完成确定性匹配，你只处理异常；点击统计卡即筛选</span>
      </div>

      <!-- 统计卡（点击筛选） -->
      <div class="mb-2.5 grid grid-cols-5 gap-2" data-testid="review-stats">
        <button
          v-for="c in cards"
          :key="c.key"
          class="cursor-pointer rounded-xl border bg-white px-3 py-2 text-left transition-colors"
          :class="statusFilter === c.key ? 'border-brand ring-1 ring-brand' : 'border-hairline hover:border-brand/40'"
          :data-testid="`stat-card-${c.key}`"
          @click="onCardClick(c.key)"
        >
          <p class="text-[11px] text-subtle">{{ c.label }}</p>
          <p class="font-mono text-[17px] font-bold" :class="c.tone">{{ c.value }}</p>
        </button>
      </div>

      <!-- 工具条：批量操作 + 搜索 -->
      <div class="mb-2 flex flex-wrap items-center gap-2">
        <Button
          v-if="!isAccountDayBatch"
          size="sm"
          :disabled="view.stats.uniqueMatch === 0 || busy"
          data-testid="review-confirm-all"
          @click="emit('confirmAllUnique')"
        >
          <CheckCheck class="h-4 w-4" aria-hidden="true" />
          一键确认全部唯一匹配（{{ view.stats.uniqueMatch }}）
        </Button>
        <Button
          size="sm"
          variant="outline"
          :disabled="checkedIds.length === 0 || busy"
          data-testid="review-batch-ignore"
          @click="emit('batchIgnore', checkedIds); checked = new Set()"
        >
          <SkipForward class="h-4 w-4" aria-hidden="true" />
          批量忽略（{{ checkedIds.length }}）
        </Button>
        <Button
          size="sm"
          variant="outline"
          :disabled="checkedIds.length === 0 || busy"
          data-testid="review-batch-account-day"
          @click="emit('batchAccountDay', checkedIds); checked = new Set()"
        >
          <UserRoundSearch class="h-4 w-4" aria-hidden="true" />
          批量存账号级（{{ checkedIds.length }}）
        </Button>
        <Button size="sm" variant="outline" :disabled="busy" data-testid="review-rematch" @click="emit('rematch')">
          <RefreshCw class="h-4 w-4" aria-hidden="true" /> 重新匹配
        </Button>
        <div class="ml-auto flex items-center gap-2">
          <div class="relative">
            <Search class="pointer-events-none absolute left-2 top-2 h-3.5 w-3.5 text-subtle" aria-hidden="true" />
            <input
              v-model="searchInput"
              placeholder="搜索标题、文件名或账号"
              class="w-[220px] rounded-lg border border-hairline bg-white py-1.5 pl-7 pr-2 text-xs focus:border-brand focus:outline-none"
              data-testid="review-search"
              @keyup.enter="emit('search', searchInput)"
            />
          </div>
          <Select
            :value="String(pageSize)"
            :options="pageSizeOptions"
            size="sm"
            trigger-class="w-[110px]"
            @update:value="(v) => v !== null && emit('pageSize', Number(v))"
          />
        </div>
      </div>

      <!-- 高密度匹配表 -->
      <div class="overflow-auto rounded-xl border border-hairline" style="max-height: calc(100vh - 350px)">
        <table class="w-full border-collapse text-left text-[12.5px]">
          <thead class="sticky top-0 z-10 bg-[#fafbfc] text-subtle">
            <tr>
              <th class="w-8 border-b border-hairline px-2 py-2">
                <input type="checkbox" aria-label="全选本页" :checked="allChecked" @change="toggleAll" />
              </th>
              <th class="w-10 border-b border-hairline px-1.5 py-2 font-semibold">#</th>
              <th class="border-b border-hairline px-2 py-2 font-semibold">日期</th>
              <th class="border-b border-hairline px-2 py-2 font-semibold">平台</th>
              <th class="border-b border-hairline px-2 py-2 font-semibold">账号</th>
              <th class="min-w-[180px] border-b border-hairline px-2 py-2 font-semibold">平台作品标题</th>
              <th class="min-w-[130px] border-b border-hairline px-2 py-2 font-semibold">作品 ID</th>
              <th class="border-b border-hairline px-2 py-2 font-semibold">播放量</th>
              <th class="min-w-[180px] border-b border-hairline px-2 py-2 font-semibold">系统视频</th>
              <th class="border-b border-hairline px-2 py-2 font-semibold">发布时间</th>
              <th class="border-b border-hairline px-2 py-2 font-semibold">时长</th>
              <th class="border-b border-hairline px-2 py-2 font-semibold">状态</th>
              <th class="min-w-[150px] border-b border-hairline px-2 py-2 font-semibold">匹配依据</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-hairline bg-white">
            <tr v-if="loading">
              <td colspan="13" class="px-3 py-6 text-center"><Spinner size="sm" /> 加载中…</td>
            </tr>
            <tr v-else-if="items.length === 0">
              <td colspan="13" class="px-3 py-6 text-center text-subtle">当前筛选没有记录</td>
            </tr>
            <tr
              v-for="r in items"
              v-else
              :key="r.rowId"
              class="cursor-pointer"
              :class="selectedRowId === r.rowId ? 'bg-brand-soft/60' : 'hover:bg-[#fafbff]'"
              :data-testid="`row-${r.rowNumber}`"
              @click="emit('select', r)"
            >
              <td class="px-2 py-1.5" @click.stop>
                <input
                  type="checkbox"
                  :aria-label="`选择第 ${r.rowNumber} 行`"
                  :checked="checked.has(r.rowId)"
                  @change="toggleRow(r.rowId, ($event.target as HTMLInputElement).checked)"
                />
              </td>
              <td class="px-1.5 py-1.5 text-subtle">{{ r.rowNumber }}</td>
              <td class="whitespace-nowrap px-2 py-1.5 font-mono">{{ r.imported.date ?? "—" }}</td>
              <td class="whitespace-nowrap px-2 py-1.5">{{ r.imported.platform ?? "—" }}</td>
              <td class="whitespace-nowrap px-2 py-1.5">{{ r.imported.account ?? "—" }}</td>
              <td class="max-w-[220px] truncate px-2 py-1.5" :title="r.imported.title ?? ''">{{ r.imported.title ?? "—" }}</td>
              <td class="max-w-[150px] truncate px-2 py-1.5 font-mono text-[11.5px]">{{ r.imported.platformWorkId ?? "—" }}</td>
              <td class="whitespace-nowrap px-2 py-1.5 font-mono">{{ r.imported.views ?? "—" }}</td>
              <td class="px-2 py-1.5">
                <div v-if="r.matched" class="flex min-w-0 items-center gap-1.5">
                  <img
                    v-if="r.matched.coverUrl"
                    :src="r.matched.coverUrl"
                    alt=""
                    class="h-8 w-[46px] shrink-0 rounded border border-hairline object-cover"
                    @error="($event.target as HTMLImageElement).style.visibility = 'hidden'"
                  />
                  <span v-else class="flex h-8 w-[46px] shrink-0 items-center justify-center rounded border border-dashed border-hairline text-[9px] text-subtle">封面</span>
                  <span class="min-w-0">
                    <span class="block max-w-[130px] truncate">{{ r.matched.videoTitle }}</span>
                    <span class="block truncate font-mono text-[10.5px] text-subtle">{{ r.matched.videoId }}</span>
                  </span>
                </div>
                <span v-else class="text-subtle">—</span>
              </td>
              <td class="whitespace-nowrap px-2 py-1.5 text-[11.5px]">{{ fmtTime(r.matched?.publishTime ?? null) }}</td>
              <td class="whitespace-nowrap px-2 py-1.5 font-mono text-[11.5px]">{{ formatDuration(r.matched?.durationSec ?? null) }}</td>
              <td class="whitespace-nowrap px-2 py-1.5">
                <span class="rounded px-1.5 py-0.5 text-[11px] font-medium" :class="pillClass(r.matchStatus)">
                  {{ statusPillMeta(r.matchStatus).label }}
                </span>
                <span v-if="r.candidateCount > 1" class="ml-1 text-[10.5px] text-subtle">{{ r.candidateCount }} 候选</span>
              </td>
              <td class="px-2 py-1.5 text-[11.5px] text-subtle">
                <span v-if="r.evidenceSummary.length > 0">
                  {{ r.evidenceSummary.slice(0, 2).join(" · ") }}<template v-if="r.evidenceSummary.length > 2"> +{{ r.evidenceSummary.length - 2 }}</template>
                </span>
                <span v-else>—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 分页 + 下一步 -->
      <div class="mt-2.5 flex items-center justify-between">
        <div class="flex items-center gap-1 text-xs">
          <button
            class="cursor-pointer rounded border border-hairline bg-white px-2 py-1 disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="page <= 1"
            aria-label="上一页"
            @click="emit('page', page - 1)"
          >‹</button>
          <span class="px-1.5 text-subtle">第 {{ page }} / {{ totalPages }} 页 · 共 {{ total }} 条</span>
          <button
            class="cursor-pointer rounded border border-hairline bg-white px-2 py-1 disabled:cursor-not-allowed disabled:opacity-40"
            :disabled="page >= totalPages"
            aria-label="下一页"
            @click="emit('page', page + 1)"
          >›</button>
        </div>
        <Button :disabled="busy" data-testid="review-next" @click="emit('next')">下一步：提交落库 →</Button>
      </div>
    </div>

    <!-- 右侧详情面板由父级渲染（选中行联动） -->
    <slot />
  </div>
</template>
