<script setup lang="ts">
/**
 * 分析首页（页面 A，需求 §十一）— 回答「最近的视频表现怎么样？」
 * 只展示增长漏斗与周期对比；阶段缺失显示「暂无数据 + 原因」（无数据 ≠ 0）
 * 指标聚合与环比一律后端计算（/api/analytics/overview），本页仅呈现
 */
import { onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { type AnalyticsOverview, getAnalyticsOverview } from "../api/client";
import Spinner from "../components/ui/spinner.vue";
import {
  emptyReasonLabel,
  formatChange,
  formatCount,
  funnelBarWidth,
  funnelCoverageText,
  funnelStepHint,
  funnelStepRateText,
  sourceLabel,
} from "../lib/analytics-insights";

const days = ref(7);
const overview = ref<AnalyticsOverview | null>(null);
const loading = ref(true);
const errorMsg = ref("");

/** 按 key 取阶段（不依赖后端返回顺序） */
function stage(key: string): AnalyticsOverview["stages"][number] | undefined {
  return overview.value?.stages.find((s) => s.key === key);
}

async function load(): Promise<void> {
  loading.value = true;
  errorMsg.value = "";
  try {
    overview.value = await getAnalyticsOverview(days.value);
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
    overview.value = null;
  } finally {
    loading.value = false;
  }
}

function pick(d: number): void {
  if (days.value === d) return;
  days.value = d;
  void load();
}

onMounted(load);
</script>

<template>
  <main class="px-7 pt-[26px] pb-12">
    <section class="mb-[22px] flex flex-wrap items-end justify-between gap-x-5 gap-y-2">
      <div>
        <h1 class="mb-1.5 text-[26px] font-bold">数据分析</h1>
        <p class="text-subtle">增长漏斗与周期对比；每个阶段标注数据来源，导入创作者后台数据后自动填充。</p>
      </div>
      <div class="flex items-center gap-2">
        <div class="flex overflow-hidden rounded-[10px] border border-hairline">
          <button
            v-for="d in [7, 30]"
            :key="d"
            type="button"
            class="cursor-pointer px-3.5 py-[9px] text-sm transition-colors"
            :class="days === d ? 'bg-brand text-white' : 'bg-white text-gray-600 hover:bg-gray-50'"
            @click="pick(d)"
          >
            最近 {{ d }} 天
          </button>
        </div>
        <RouterLink
          to="/insights/videos"
          class="rounded-[10px] border border-hairline bg-white px-3.5 py-[9px] text-sm text-gray-600 no-underline hover:bg-gray-50"
        >
          视频表现列表
        </RouterLink>
        <RouterLink
          to="/insights/factors"
          class="rounded-[10px] border border-hairline bg-white px-3.5 py-[9px] text-sm text-gray-600 no-underline hover:bg-gray-50"
        >
          因子分析
        </RouterLink>
        <RouterLink
          to="/insights/data"
          class="rounded-[10px] border border-hairline bg-white px-3.5 py-[9px] text-sm text-gray-600 no-underline hover:bg-gray-50"
        >
          数据接入
        </RouterLink>
      </div>
    </section>

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

    <p v-if="loading" class="flex items-center gap-2 p-8 text-center text-sm text-subtle">
      <Spinner size="sm" /> 聚合中…
    </p>

    <template v-else-if="overview">
      <!-- KPI（原型 .metric；移动端单列堆叠） -->
      <div class="mb-[22px] grid grid-cols-1 gap-3.5 sm:grid-cols-3">
        <div class="rounded-2xl border border-hairline bg-panel p-[18px]">
          <p class="text-[13px] text-subtle">窗口内发布</p>
          <p class="mt-2 text-[30px] leading-none font-extrabold">{{ overview.publishedVideos }}</p>
          <p class="mt-1.5 text-xs text-subtle">
            上一周期 {{ overview.previousPublishedVideos }} 条 ·
            {{ overview.from }} ~ {{ overview.to }}
          </p>
        </div>
        <div class="rounded-2xl border border-hairline bg-panel p-[18px]">
          <p class="text-[13px] text-subtle">播放（合计）</p>
          <p class="mt-2 text-[30px] leading-none font-extrabold">
            {{ formatCount(stage("plays")?.value ?? null) }}
          </p>
          <p class="mt-1.5 text-xs text-subtle">
            环比 <b :class="(stage('plays')?.changePct ?? 0) >= 0 ? 'text-ok' : 'text-bad'">{{ formatChange(stage("plays")?.changePct ?? null) }}</b>
            <template v-if="stage('plays')?.sourceTypes.length">
              · <span v-for="s in stage('plays')?.sourceTypes" :key="s" class="rounded bg-gray-100 px-1 text-[10px]">[{{ sourceLabel(s) }}]</span>
            </template>
          </p>
        </div>
        <div class="rounded-2xl border border-hairline bg-panel p-[18px]">
          <p class="text-[13px] text-subtle">关注（账号日新增合计）</p>
          <p class="mt-2 text-[30px] leading-none font-extrabold">
            {{ formatCount(stage("follows")?.value ?? null) }}
          </p>
          <p class="mt-1.5 text-xs text-subtle">账号级窗口归因，不含单视频宣称</p>
        </div>
      </div>

      <!-- 视频观看漏斗（审查批次 1B：逐级转化仅覆盖一致且不倒挂时计算；账号增长视觉分离） -->
      <section class="rounded-2xl border border-hairline bg-panel p-[18px]">
        <h2 class="mb-1 font-bold">视频观看漏斗</h2>
        <p class="mb-4 text-xs text-subtle">
          播放 → 2秒有效观看 → 5秒观看 → 完播 → 主页访问；比例类按「播放量 × 导入比例」折算。
          逐级转化仅在相邻阶段覆盖记录一致且数值不倒挂时计算（不可比显示「—」并说明原因，绝不截断百分比）；占比分母为本阶段覆盖播放。
        </p>
        <p
          v-if="overview.emptyReason"
          class="mb-3 rounded-lg border border-[#f8df9c] bg-[#fff8e8] px-3 py-2 text-xs"
        >
          暂无数据：{{ emptyReasonLabel(overview.emptyReason) }}。可在
          <RouterLink to="/analytics" class="text-brand underline">发布管理</RouterLink>
          创建发布记录并导入创作者后台数据。
        </p>
        <div class="space-y-2.5">
          <template v-for="(s, i) in overview.stages" :key="s.key">
            <!-- 账号增长：独立分区，不与观看阶段连成转化链路 -->
            <div v-if="s.kind === 'creator'" class="mt-4 border-t border-dashed border-hairline pt-3">
              <p class="mb-1.5 text-xs font-semibold text-subtle">
                账号增长（独立指标 · 不与观看阶段计算转化）
              </p>
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span class="text-[13px] font-medium">{{ s.label }}</span>
                <span class="text-[13px] tabular-nums">
                  <template v-if="s.value !== null">{{ formatCount(s.value) }}</template>
                  <template v-else
                    ><span class="text-xs text-subtle">{{
                      emptyReasonLabel(s.emptyReason ?? "") || "暂无数据"
                    }}</span></template
                  >
                </span>
                <span
                  class="text-xs tabular-nums"
                  :class="(s.changePct ?? 0) >= 0 ? 'text-ok' : 'text-bad'"
                  >{{ formatChange(s.changePct) }}</span
                >
                <span class="text-[10px] text-subtle">{{ funnelCoverageText(s) }}</span>
                <span class="rounded bg-amber-50 px-1 py-0.5 text-[10px] text-amber-700">估算</span>
                <span v-for="t in s.sourceTypes" :key="t" class="rounded bg-gray-100 px-1 text-[10px]"
                  >[{{ sourceLabel(t) }}]</span
                >
              </div>
              <p v-if="s.note" class="mt-1 text-[10px] text-subtle">{{ s.note }}</p>
            </div>
            <div v-else class="flex flex-wrap items-center gap-x-3 gap-y-0.5">
              <span class="w-[72px] shrink-0 text-[13px] font-medium sm:w-[104px]">{{ s.label }}</span>
              <div class="h-[26px] w-[140px] shrink-0 overflow-hidden rounded-lg bg-shell sm:w-auto sm:min-w-0 sm:flex-1">
                <div
                  class="flex h-full items-center rounded-lg bg-brand-soft px-2 text-xs font-semibold text-brand"
                  :style="{ width: funnelBarWidth(s.shareOfPlays) }"
                  :title="funnelStepHint(s) || undefined"
                >
                  <template v-if="i > 0">{{ funnelStepRateText(s) }}</template>
                </div>
              </div>
              <span class="w-[92px] shrink-0 text-right text-[13px] tabular-nums">
                <template v-if="s.value !== null">{{ formatCount(s.value) }}</template>
                <template v-else
                  ><span class="text-xs text-subtle">{{
                    emptyReasonLabel(s.emptyReason ?? "") || "暂无数据"
                  }}</span></template
                >
              </span>
              <span
                class="w-[84px] shrink-0 text-right text-xs tabular-nums"
                :class="(s.changePct ?? 0) >= 0 ? 'text-ok' : 'text-bad'"
              >
                {{ formatChange(s.changePct) }}
              </span>
              <span class="hidden w-[150px] shrink-0 text-right text-[10px] leading-4 text-subtle lg:block">
                <span v-for="t in s.sourceTypes" :key="t" class="mr-1 rounded bg-gray-100 px-1 py-0.5"
                  >[{{ sourceLabel(t) }}]</span
                >
              </span>
              <p class="w-full pl-[84px] text-[10px] leading-4 text-subtle sm:pl-[116px]">
                {{ funnelCoverageText(s) }}<template v-if="funnelStepHint(s)"> · {{ funnelStepHint(s) }}</template>
                <span class="lg:hidden">
                  <template v-for="t in s.sourceTypes" :key="t"> · [{{ sourceLabel(t) }}]</template>
                </span>
              </p>
            </div>
          </template>
        </div>
      </section>
    </template>
  </main>
</template>
