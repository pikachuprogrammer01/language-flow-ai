<script setup lang="ts">
/**
 * 视频表现列表（页面 B）— 批次一切到统一内容主视图：一条已生成内容一行
 *
 * 与旧口径（GET /analytics/videos，一发布记录一行）的区别：
 * - 本地有成片但没登记发布记录的集现在也在列表里（platforms=[]，状态「未发布」），
 *   不再只靠一条提示数字点破。
 * - 指标只在平台明细里按平台读；一条内容对应多平台时主行**不显示任何数值**，
 *   因为跨平台口径不可比，相加/取平均都是假数据（docs/22 §3 不变量）。
 * - 缺失指标显示「暂无数据」，不是 0。
 */
import { onMounted, ref } from "vue";
import { RouterLink, useRouter } from "vue-router";
import {
  type ContentVideoRow,
  type ContentVideoSort,
  type ContentVideoStatus,
  listAnalyticsContentVideos,
} from "../api/client";
import Spinner from "../components/ui/spinner.vue";
import {
  CONTENT_STATUS_HINT,
  CONTENT_STATUS_LABEL,
  VIDEO_LIST_COLUMNS,
  contentCoverageText,
  formatByKind,
  platformMetricText,
  publishTimeSourceLabel,
  sourceLabel,
} from "../lib/analytics-insights";
import { STATUS_LABEL, TEMPLATE_LABEL } from "../lib/status";

const router = useRouter();
const rows = ref<ContentVideoRow[]>([]);
const total = ref(0);
const page = ref(1);
const pageSize = 20;
const sort = ref<ContentVideoSort>("created_time");
const order = ref<"asc" | "desc">("desc");
const status = ref<ContentVideoStatus | "all">("all");
const loading = ref(true);
const errorMsg = ref("");
/** 展开的平台明细行集合（默认收起：多平台内容的指标只在展开后读） */
const expanded = ref<Set<string>>(new Set());

const STATUS_OPTIONS: { value: ContentVideoStatus | "all"; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "unpublished", label: "未发布" },
  { value: "published_unimported", label: "已发布未导入" },
  { value: "imported", label: "已有指标" },
  { value: "import_conflict", label: "导入待裁决" },
  { value: "failed", label: "生成失败" },
  { value: "deleted", label: "已删除" },
];

async function load(): Promise<void> {
  loading.value = true;
  errorMsg.value = "";
  try {
    const data = await listAnalyticsContentVideos({
      status: status.value,
      sort: sort.value,
      order: order.value,
      page: page.value,
      pageSize,
    });
    rows.value = data.items;
    total.value = data.total;
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
    rows.value = [];
    total.value = 0;
  } finally {
    loading.value = false;
  }
}

function sortBy(next: ContentVideoSort): void {
  if (sort.value === next) {
    order.value = order.value === "desc" ? "asc" : "desc";
  } else {
    sort.value = next;
    order.value = "desc";
  }
  page.value = 1;
  void load();
}

function filterBy(next: ContentVideoStatus | "all"): void {
  status.value = next;
  page.value = 1;
  void load();
}

function ariaSort(active: boolean): "ascending" | "descending" | "none" {
  if (!active) return "none";
  return order.value === "asc" ? "ascending" : "descending";
}

function gotoPage(p: number): void {
  if (p < 1 || (p - 1) * pageSize >= total.value) return;
  page.value = p;
  void load();
}

/**
 * 本页可排序的指标列：新接口的排序白名单只有 play/completion/engagement，
 * 涨粉是估算/窗口归因值，不做排序入口（避免把它当真实单视频归因比较）。
 */
const COLUMN_SORT: Record<string, ContentVideoSort> = {
  play_count: "play",
  completion_rate: "completion",
};
const COLUMNS = VIDEO_LIST_COLUMNS.map((c) => ({ ...c, sortKey: COLUMN_SORT[c.key] }));

function toggle(contentId: string): void {
  const next = new Set(expanded.value);
  if (next.has(contentId)) next.delete(contentId);
  else next.add(contentId);
  expanded.value = next;
}

/**
 * 主行是否可以直接显示指标数值：只有一条平台记录时可以（不存在跨平台合并）。
 * 多平台时返回 false，单元格显示「多平台」引导展开——绝不填一个合计值。
 */
function inlineMetricsRow(row: ContentVideoRow): boolean {
  return row.platforms.length <= 1;
}

onMounted(load);
</script>

<template>
  <main class="px-7 pt-[26px] pb-12">
    <section class="mb-[22px] flex items-end justify-between gap-5">
      <div>
        <h1 class="mb-1.5 text-[26px] font-bold">视频表现</h1>
        <p class="text-subtle">
          一条已生成内容一行；发布记录与指标按平台展开查看，不同平台的播放/完播口径不同，不做相加。
          缺失指标显示「暂无数据」，不代表 0。
        </p>
      </div>
      <button
        class="cursor-pointer rounded-[10px] border border-hairline bg-white px-3.5 py-[9px] text-sm hover:bg-gray-50"
        :disabled="loading"
        @click="load"
      >
        刷新数据
      </button>
    </section>

    <div class="mb-4 flex flex-wrap items-center gap-2" role="group" aria-label="按状态筛选">
      <button
        v-for="opt in STATUS_OPTIONS"
        :key="opt.value"
        type="button"
        class="cursor-pointer rounded-full border px-3 py-1.5 text-xs transition-colors"
        :class="
          status === opt.value
            ? 'border-brand bg-brand-soft text-ink'
            : 'border-hairline bg-white text-subtle hover:bg-gray-50'
        "
        :aria-pressed="status === opt.value"
        @click="filterBy(opt.value)"
      >
        {{ opt.label }}
      </button>
    </div>

    <div
      v-if="errorMsg"
      role="alert"
      class="mb-4 flex items-center justify-between gap-3 rounded-xl bg-red-50 p-3 text-sm text-red-600"
    >
      <span>{{ errorMsg }}</span>
      <button
        class="cursor-pointer rounded border border-red-300 px-2 py-1 text-xs hover:bg-red-100"
        @click="load"
      >
        重试
      </button>
    </div>

    <section class="overflow-hidden rounded-2xl border border-hairline bg-panel" :aria-busy="loading">
      <p v-if="loading && rows.length === 0" class="flex items-center justify-center gap-2 p-8 text-sm text-subtle">
        <Spinner size="sm" /> 加载中…
      </p>
      <p v-else-if="!loading && rows.length === 0" class="p-8 text-center text-sm text-subtle">
        当前筛选条件下没有内容行 —— 默认只看「已完成且有成片」的集；换「生成失败」或「已删除」可扩大范围。
      </p>
      <div v-else class="overflow-x-auto" :class="loading ? 'opacity-60' : ''">
        <p class="px-3.5 pt-2.5 text-[10px] text-subtle sm:hidden">表格支持左右滑动查看全部指标列</p>
        <table class="w-full border-collapse text-left text-[13px]">
          <thead class="bg-[#fafbfc] text-subtle">
            <tr>
              <th class="border-b border-hairline px-2 py-[13px]">
                <span class="sr-only">展开平台明细</span>
              </th>
              <th class="border-b border-hairline px-3.5 py-[13px] font-semibold">标题 / 状态</th>
              <th class="border-b border-hairline px-3.5 py-[13px] font-semibold">模板</th>
              <th
                class="border-b border-hairline p-0 font-semibold"
                :aria-sort="ariaSort(sort === 'created_time')"
              >
                <button
                  type="button"
                  class="w-full cursor-pointer px-3.5 py-[13px] text-left whitespace-nowrap select-none hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand"
                  @click="sortBy('created_time')"
                >
                  生成 {{ sort === "created_time" ? (order === "desc" ? "↓" : "↑") : "" }}
                </button>
              </th>
              <th
                class="border-b border-hairline p-0 font-semibold"
                :aria-sort="ariaSort(sort === 'publish_time')"
              >
                <button
                  type="button"
                  class="w-full cursor-pointer px-3.5 py-[13px] text-left whitespace-nowrap select-none hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand"
                  @click="sortBy('publish_time')"
                >
                  发布 {{ sort === "publish_time" ? (order === "desc" ? "↓" : "↑") : "" }}
                </button>
              </th>
              <th class="border-b border-hairline px-3.5 py-[13px] font-semibold whitespace-nowrap">
                覆盖
              </th>
              <th
                v-for="col in COLUMNS"
                :key="col.key"
                class="border-b border-hairline p-0 text-right font-semibold"
                :aria-sort="col.sortKey ? ariaSort(sort === col.sortKey) : undefined"
              >
                <button
                  v-if="col.sortKey"
                  type="button"
                  class="w-full cursor-pointer px-3.5 py-[13px] text-right whitespace-nowrap select-none hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand"
                  :class="sort === col.sortKey ? 'text-brand' : ''"
                  @click="sortBy(col.sortKey)"
                >
                  {{ col.label }}
                  <template v-if="sort === col.sortKey">{{ order === "desc" ? "↓" : "↑" }}</template>
                </button>
                <span v-else class="block px-3.5 py-[13px] text-right whitespace-nowrap">
                  {{ col.label }}
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            <template v-for="row in rows" :key="row.contentId">
              <tr class="border-b border-hairline transition-colors hover:bg-brand-soft/40">
                <td class="px-2 py-[13px] align-middle">
                  <button
                    type="button"
                    class="cursor-pointer rounded border border-hairline bg-white px-2 py-1 text-xs hover:bg-gray-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                    :aria-expanded="expanded.has(row.contentId)"
                    :aria-label="`展开 ${row.title} 的平台明细`"
                    @click="toggle(row.contentId)"
                  >
                    {{ expanded.has(row.contentId) ? "收起" : "明细" }}
                  </button>
                </td>
                <td class="max-w-[240px] px-3.5 py-[13px]">
                  <RouterLink
                    :to="`/insights/videos/${row.contentId}`"
                    class="block truncate font-medium text-ink no-underline hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                  >
                    {{ row.title }}
                  </RouterLink>
                  <p class="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-subtle">
                    <span
                      class="rounded-full px-2 py-0.5"
                      :class="row.status === 'imported' ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100'"
                      data-testid="content-status"
                    >
                      {{ CONTENT_STATUS_LABEL[row.status] }}
                    </span>
                    <span>{{ STATUS_LABEL[row.localStatus] ?? row.localStatus }}</span>
                  </p>
                </td>
                <td class="px-3.5 py-[13px] whitespace-nowrap">
                  {{ TEMPLATE_LABEL[row.template] ?? row.template }}
                </td>
                <td class="px-3.5 py-[13px] text-xs whitespace-nowrap tabular-nums">
                  {{ row.generatedAt.slice(0, 10) }}
                </td>
                <td class="px-3.5 py-[13px] text-xs whitespace-nowrap tabular-nums">
                  <template v-if="row.platforms.length === 1">
                    {{ row.platforms[0]?.publishTime ? row.platforms[0].publishTime.slice(0, 10) : "—" }}
                  </template>
                  <template v-else-if="row.platforms.length > 1">
                    {{ row.platforms.length }} 条登记
                  </template>
                  <span v-else class="text-subtle">未发布</span>
                </td>
                <td class="px-3.5 py-[13px] text-xs whitespace-nowrap text-subtle">
                  {{ contentCoverageText(row.metricCoverage) }}
                </td>
                <!-- 多平台：整段合并成一个说明格，而不是把「多平台」铺满每一列 -->
                <td
                  v-if="!inlineMetricsRow(row)"
                  :colspan="COLUMNS.length"
                  class="px-3.5 py-[13px] text-right text-xs text-subtle whitespace-nowrap"
                  data-testid="multi-platform-guard"
                >
                  {{ row.platforms.length }} 个平台各自的数据 · 点「明细」展开看
                </td>
                <td
                  v-for="col in COLUMNS"
                  v-else
                  :key="col.key"
                  class="px-3.5 py-[13px] text-right align-middle whitespace-nowrap tabular-nums"
                >
                  <template v-if="row.platforms[0]?.metrics[col.key]">
                    <span
                      class="cursor-help"
                      :title="`来源：[${sourceLabel(row.platforms[0]?.metrics[col.key]?.sourceType)}]${row.platforms[0]?.metrics[col.key]?.isEstimated ? ' · 估算/窗口归因' : ''}${row.platforms[0]?.metrics[col.key]?.dataDate ? ` · ${row.platforms[0]?.metrics[col.key]?.dataDate}` : ''}`"
                    >
                      <span v-if="row.platforms[0]?.metrics[col.key]?.isEstimated" class="mr-0.5 text-amber-600">≈</span>
                      {{ formatByKind(row.platforms[0]?.metrics[col.key]?.value ?? null, col.kind) }}
                    </span>
                  </template>
                  <template v-else>
                    <span class="text-subtle" title="暂无数据（不代表 0）">—</span>
                  </template>
                </td>
              </tr>
              <!-- 平台明细：每个平台各自一行指标，发布时间来源如实标注 -->
              <tr v-if="expanded.has(row.contentId)" class="border-b border-hairline bg-[#fafbfc]">
                <td :colspan="6 + COLUMNS.length" class="px-3.5 py-3">
                  <p class="mb-2 text-xs text-subtle">{{ CONTENT_STATUS_HINT[row.status] }}</p>
                  <p v-if="row.platforms.length === 0" class="text-xs text-subtle">
                    这条内容还没有任何平台发布记录（未创建 local 伪记录）。
                  </p>
                  <ul v-else class="space-y-2">
                    <li
                      v-for="p in row.platforms"
                      :key="p.recordId"
                      class="rounded-lg border border-hairline bg-white p-2.5"
                      data-testid="platform-detail"
                    >
                      <p class="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                        <span class="font-medium text-ink">{{ p.platform }}</span>
                        <span v-if="p.platformVideoId" class="text-gray-400">#{{ p.platformVideoId }}</span>
                        <span class="rounded-full bg-gray-100 px-2 py-0.5">{{ p.publishStatus }}</span>
                        <span
                          v-if="p.hasImportConflict"
                          class="rounded-full bg-amber-100 px-2 py-0.5 text-amber-800"
                        >
                          导入待裁决
                        </span>
                        <span class="text-subtle">
                          发布 {{ p.publishTime ? p.publishTime.slice(0, 10) : "—" }} ·
                          {{ publishTimeSourceLabel(p.publishTimeSource) }}
                        </span>
                      </p>
                      <p v-if="p.metricCount === 0" class="text-xs text-subtle">
                        暂无导入指标 —— 去「数据接入」导入该平台创作者后台导出表（缺失不折算成 0）。
                      </p>
                      <ul v-else class="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                        <li v-for="col in VIDEO_LIST_COLUMNS" :key="col.key" class="tabular-nums">
                          <span class="text-subtle">{{ col.label }}</span>
                          <span
                            v-if="p.metrics[col.key]?.isEstimated"
                            class="ml-1 text-amber-600"
                            title="估算/窗口归因，不是精确归因"
                          >
                            ≈
                          </span>
                          <span :class="p.metrics[col.key] ? '' : 'text-subtle'">
                            {{ platformMetricText(p.metrics[col.key], col.kind) }}
                          </span>
                          <span v-if="p.metrics[col.key]" class="ml-1 text-gray-400">
                            [{{ sourceLabel(p.metrics[col.key]?.sourceType) }}]
                          </span>
                        </li>
                      </ul>
                    </li>
                  </ul>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
      <div v-if="total > pageSize" class="flex items-center justify-end gap-2 border-t border-hairline px-4 py-2.5 text-sm">
        <button
          class="cursor-pointer rounded-[10px] border border-hairline bg-white px-2.5 py-1 disabled:opacity-40"
          :disabled="page <= 1"
          @click="gotoPage(page - 1)"
        >
          上一页
        </button>
        <span class="text-xs text-subtle">第 {{ page }} / {{ Math.ceil(total / pageSize) }} 页 · 共 {{ total }} 条</span>
        <button
          class="cursor-pointer rounded-[10px] border border-hairline bg-white px-2.5 py-1 disabled:opacity-40"
          :disabled="page * pageSize >= total"
          @click="gotoPage(page + 1)"
        >
          下一页
        </button>
      </div>
    </section>

    <p class="mt-3 text-xs text-subtle">
      排序里的播放/完播/互动取该内容各平台该指标的最好值（max），只用于排序；跨平台合计不存在于本页面。
    </p>
  </main>
</template>
