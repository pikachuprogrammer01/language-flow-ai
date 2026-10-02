<script setup lang="ts">
/**
 * 视频表现列表（页面 B，需求 §十一）— 每条发布记录一行，指标列带来源标注
 * 排序仅走后端白名单（play/completion/engagement/fans/publish_time）；缺数据显示「—」而非 0
 */
import { onMounted, ref } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { type AnalyticsVideoRow, type InsightSort, listAnalyticsVideos } from "../api/client";
import Spinner from "../components/ui/spinner.vue";
import { VIDEO_LIST_COLUMNS, formatByKind, sourceLabel } from "../lib/analytics-insights";

const router = useRouter();
const rows = ref<AnalyticsVideoRow[]>([]);
const total = ref(0);
/** 有成片但未登记发布记录的集数——它们不在本列表行集内，必须显式点破 */
const unregistered = ref(0);
const page = ref(1);
const pageSize = 20;
const sort = ref<InsightSort>("play");
const order = ref<"asc" | "desc">("desc");
const loading = ref(true);
const errorMsg = ref("");
const TEMPLATE_LABEL: Record<string, string> = {
  scene_word: "情景背词",
  word_card: "单词卡片",
  quiz: "选择题",
};

async function load(): Promise<void> {
  loading.value = true;
  errorMsg.value = "";
  try {
    const data = await listAnalyticsVideos({
      sort: sort.value,
      order: order.value,
      page: page.value,
      pageSize,
    });
    rows.value = data.items;
    total.value = data.total;
    unregistered.value = data.unregisteredContentCount;
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
    rows.value = [];
    unregistered.value = 0;
  } finally {
    loading.value = false;
  }
}

/** 表头点击：同列翻转方向，换列重置为 desc（publish_time desc 语义为最新优先） */
function sortBy(next: InsightSort): void {
  if (sort.value === next) {
    order.value = order.value === "desc" ? "asc" : "desc";
  } else {
    sort.value = next;
    order.value = "desc";
  }
  page.value = 1;
  void load();
}

/** aria-sort 当前列状态（审查批次 4A：屏幕阅读器播报排序方向） */
function ariaSort(active: boolean): "ascending" | "descending" | "none" {
  if (!active) return "none";
  return order.value === "asc" ? "ascending" : "descending";
}

function gotoPage(p: number): void {
  if (p < 1 || (p - 1) * pageSize >= total.value) return;
  page.value = p;
  void load();
}

onMounted(load);
</script>

<template>
  <main class="px-7 pt-[26px] pb-12">
    <section class="mb-[22px] flex items-end justify-between gap-5">
      <div>
        <h1 class="mb-1.5 text-[26px] font-bold">视频表现</h1>
        <p class="text-subtle">按发布记录逐条呈现；点表头排序（后端白名单），缺失指标显示「—」不代表 0。</p>
      </div>
      <button
        class="cursor-pointer rounded-[10px] border border-hairline bg-white px-3.5 py-[9px] text-sm hover:bg-gray-50"
        :disabled="loading"
        @click="load"
      >
        刷新数据
      </button>
    </section>

    <p
      v-if="unregistered > 0 && !loading"
      class="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800"
      data-testid="unregistered-episodes"
    >
      另有 {{ unregistered }} 集已有成片但未登记发布记录，因此不在本列表里——在
      <RouterLink class="font-medium underline" to="/marks">上传标记</RouterLink>
      中标记一次即自动登记（标记即发布）。
    </p>

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

    <section
      class="overflow-hidden rounded-2xl border border-hairline bg-panel"
      :aria-busy="loading"
    >
      <!-- 刷新时保留表格只淡化（aria-busy 播报）：整表替换会丢键盘焦点，排序后 Tab 连续性受损 -->
      <p
        v-if="loading && rows.length === 0"
        class="flex items-center justify-center gap-2 p-8 text-sm text-subtle"
      >
        <Spinner size="sm" /> 加载中…
      </p>
      <p v-else-if="!loading && rows.length === 0" class="p-8 text-center text-sm text-subtle">
        暂无发布记录 —— 先到「数据分析 → 数据接入」创建发布记录（绑定平台作品 ID）并导入指标
      </p>
      <div v-else class="overflow-x-auto" :class="loading ? 'opacity-60' : ''">
        <p class="px-3.5 pt-2.5 text-[10px] text-subtle sm:hidden">表格支持左右滑动查看全部指标列</p>
        <table class="w-full border-collapse text-left text-[13px]">
          <thead class="bg-[#fafbfc] text-subtle">
            <tr>
              <th class="border-b border-hairline px-3.5 py-[13px] font-semibold">标题 / 平台</th>
              <th class="border-b border-hairline px-3.5 py-[13px] font-semibold">模板</th>
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
              <th
                v-for="col in VIDEO_LIST_COLUMNS"
                :key="col.key"
                class="border-b border-hairline p-0 text-right font-semibold"
                :aria-sort="col.sort ? ariaSort(sort === col.sort) : undefined"
              >
                <button
                  v-if="col.sort"
                  type="button"
                  class="w-full cursor-pointer px-3.5 py-[13px] text-right whitespace-nowrap select-none hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand"
                  :class="sort === col.sort ? 'text-brand' : ''"
                  @click="sortBy(col.sort)"
                >
                  {{ col.label }}
                  <template v-if="sort === col.sort">{{ order === "desc" ? "↓" : "↑" }}</template>
                </button>
                <span v-else class="block px-3.5 py-[13px] text-right whitespace-nowrap">
                  {{ col.label }}
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in rows"
              :key="row.recordId"
              class="cursor-pointer border-b border-hairline transition-colors last:border-b-0 hover:bg-brand-soft/40"
              @click="router.push(`/insights/videos/${row.contentId}`)"
            >
              <td class="max-w-[240px] px-3.5 py-[13px]">
                <!-- 审查批次 4A：真链接可键盘聚焦/中键新开；整行点击保留为便捷操作 -->
                <RouterLink
                  :to="`/insights/videos/${row.contentId}`"
                  class="block truncate font-medium text-ink no-underline hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                >
                  {{ row.title }}
                </RouterLink>
                <p class="mt-0.5 text-xs text-subtle">
                  {{ row.platform }}
                  <span v-if="row.platformVideoId" class="ml-1 text-gray-400">#{{ row.platformVideoId }}</span>
                </p>
              </td>
              <td class="px-3.5 py-[13px] whitespace-nowrap">{{ TEMPLATE_LABEL[row.template] ?? row.template }}</td>
              <td class="px-3.5 py-[13px] text-xs whitespace-nowrap">
                {{ row.publishTime ? row.publishTime.slice(0, 10) : "—" }}
              </td>
              <td
                v-for="col in VIDEO_LIST_COLUMNS"
                :key="col.key"
                class="px-3.5 py-[13px] text-right align-middle whitespace-nowrap tabular-nums"
              >
                <template v-if="row.metrics[col.key]">
                  <span
                    class="cursor-help"
                    :title="`来源：[${sourceLabel(row.metrics[col.key]?.sourceType)}]${row.metrics[col.key]?.isEstimated ? ' · 估算/窗口归因' : ''}${row.metrics[col.key]?.dataDate ? ` · ${row.metrics[col.key]?.dataDate}` : ''}`"
                  >
                    <span v-if="row.metrics[col.key]?.isEstimated" class="mr-0.5 text-amber-600">≈</span>
                    {{ formatByKind(row.metrics[col.key]?.value ?? null, col.kind) }}
                  </span>
                </template>
                <template v-else><span class="text-subtle">—</span></template>
              </td>
            </tr>
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
  </main>
</template>
