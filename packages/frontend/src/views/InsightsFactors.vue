<script setup lang="ts">
/**
 * 内容因子分析（页面 D，需求 §十一/§十四）— 回答「哪些生产参数与效果有关？」
 * 纪律：分组统计（中位数/均值/样本数）非因果非模型；每组必须展示样本数，
 * 样本 <8 的组黄色标注「仅供参考」；未标注桶如实呈现（覆盖率本身就是信号）
 */
import { computed, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import {
  type FactorAnalysis,
  type FactorDimensionName,
  type FactorMetricName,
  type RecommendationEvidence,
  type RecommendationView,
  createAnalyticsRecommendationApplication,
  decideAnalyticsRecommendation,
  generateAnalyticsRecommendations,
  getAnalyticsFactors,
  getAnalyticsRecommendationEvidence,
  listAnalyticsRecommendations,
  recomputeAnalyticsFactors,
} from "../api/client";
import Spinner from "../components/ui/spinner.vue";
import {
  FACTOR_DIMENSION_OPTIONS,
  FACTOR_METRIC_OPTIONS,
  formatRate,
} from "../lib/analytics-insights";
import { type CreatePrefill, goCreate } from "../lib/create-session";
import { toast } from "../lib/toast";

const metric = ref<FactorMetricName>("completion_rate");
const dimensions = ref<FactorDimensionName[]>(["hook", "scene", "durationBand", "template"]);
const result = ref<FactorAnalysis | null>(null);
const loading = ref(true);
const errorMsg = ref("");

const metricUnit = computed(
  () => FACTOR_METRIC_OPTIONS.find((m) => m.value === metric.value)?.unit ?? "rate",
);
const dimensionLabel = (dim: string): string =>
  FACTOR_DIMENSION_OPTIONS.find((d) => d.value === dim)?.label ?? dim;
const metricLabel = computed(
  () => FACTOR_METRIC_OPTIONS.find((m) => m.value === metric.value)?.label ?? metric.value,
);

function formatMetric(value: number | null): string {
  if (value === null) return "—";
  return metricUnit.value === "rate"
    ? formatRate(value)
    : Math.round(value).toLocaleString("zh-CN");
}

/**
 * 目标指标无数据时的切换提示（docs/22 §6.1：默认 completion_rate，缺失要提示换
 * effective_play_rate_2s，但**不静默替用户换**——换与不换由他点）。
 */
const metricHasNoSample = computed(
  () => metric.value === "completion_rate" && (result.value?.accountSampleCount ?? 0) === 0,
);

function toggleDimension(dim: FactorDimensionName): void {
  const set = new Set(dimensions.value);
  if (set.has(dim)) set.delete(dim);
  else set.add(dim);
  dimensions.value = [...set];
  void load();
}

async function load(): Promise<void> {
  if (dimensions.value.length === 0) {
    errorMsg.value = "至少选择一个因子维度";
    return;
  }
  loading.value = true;
  errorMsg.value = "";
  try {
    result.value = await getAnalyticsFactors({
      metric: metric.value,
      dimensions: dimensions.value,
    });
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
    result.value = null;
  } finally {
    loading.value = false;
  }
}

function pickMetric(next: string): void {
  if (metric.value === next) return;
  metric.value = next as FactorMetricName;
  void load();
}

/** 显式重算并留档（批次 5B：页面加载/切指标均为纯读，只有这里写 analysis_result） */
const archiving = ref(false);

async function recomputeAndArchive(): Promise<void> {
  if (dimensions.value.length === 0) {
    errorMsg.value = "至少选择一个因子维度";
    return;
  }
  archiving.value = true;
  try {
    result.value = await recomputeAnalyticsFactors({
      metric: metric.value,
      dimensions: dimensions.value,
    });
    toast.success("因子分析已重算并留档（analysis_result 快照）", { key: "factors" });
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err), { key: "factors" });
  } finally {
    archiving.value = false;
  }
}

/* ── 优化建议面板（§十六：分析结果回流生产） ── */
const recs = ref<RecommendationView[]>([]);
const recSummary = ref<{
  total: number;
  pending: number;
  accepted: number;
  rejected: number;
  applied: number;
} | null>(null);
const recLoading = ref(false);
const recGenerating = ref(false);

/** 建议是否可直接预填到创建表单（时长/段落/CTA 无对应表单参数，仅展示理由） */
const APPLICABLE_TYPES = new Set(["hook", "scene", "template", "speech_rate"]);

function prefillOf(rec: RecommendationView): CreatePrefill {
  const value = rec.recommendation.value;
  switch (rec.recommendationType) {
    case "hook":
      return { labelHook: value, recommendationId: rec.id };
    case "scene":
      return {
        labelScene: value,
        topic: `${rec.recommendation.label}场景英语`,
        recommendationId: rec.id,
      };
    case "template":
      return { template: value as CreatePrefill["template"], recommendationId: rec.id };
    case "speech_rate":
      return {
        // 必须落在创建页语速档位上（0.8 / 1 / 1.2）：预填一个表单里选不出来的值
        // 会让三个档位都不高亮，用户看到的「已预填」与实际提交值不一致
        rate: value.startsWith("慢") ? 0.8 : value.startsWith("快") ? 1.2 : 1,
        recommendationId: rec.id,
      };
    default:
      return { recommendationId: rec.id };
  }
}

async function loadRecommendations(): Promise<void> {
  recLoading.value = true;
  try {
    const data = await listAnalyticsRecommendations();
    recs.value = data.items;
    recSummary.value = data.summary;
  } catch {
    recs.value = [];
  } finally {
    recLoading.value = false;
  }
}

async function generate(): Promise<void> {
  recGenerating.value = true;
  try {
    const { created } = await generateAnalyticsRecommendations();
    toast.success(`已按最新数据生成 ${created} 条建议`);
    await loadRecommendations();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  } finally {
    recGenerating.value = false;
  }
}

async function ignore(rec: RecommendationView): Promise<void> {
  try {
    await decideAnalyticsRecommendation(rec.id, { accepted: false });
    await loadRecommendations();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  }
}

/**
 * 采纳一条建议：先登记采纳记录（服务端自己读建议值），再带着预填进新建页。
 *
 * 登记失败不假装成功：仍然跳转预填（不因一个记录写入卡死生产），但横幅与提示都会
 * 明说「这次没记上采纳」——不然效果回路会静默断链，比不预填更糟。
 */
async function adopt(rec: RecommendationView): Promise<void> {
  const base = prefillOf(rec);
  try {
    const app = await createAnalyticsRecommendationApplication(rec.id, {
      ...base,
    });
    goCreate({ ...base, applicationId: app.id, adoptionNote: rec.reason });
  } catch (err) {
    toast.warning(
      `采纳记录登记失败（${err instanceof Error ? err.message : "未知错误"}）：已按建议预填，但这次采纳不会被计入效果回路`,
    );
    goCreate({ ...base, adoptionNote: rec.reason });
  }
}

/* ── 证据链（docs/22 §5.2：建议必须能追到原始数据） ── */
const evidenceOpen = ref<string | null>(null);
const evidence = ref<RecommendationEvidence | null>(null);
const evidenceLoading = ref(false);
const evidenceError = ref("");

async function toggleEvidence(rec: RecommendationView): Promise<void> {
  if (evidenceOpen.value === rec.id) {
    evidenceOpen.value = null;
    evidence.value = null;
    return;
  }
  evidenceOpen.value = rec.id;
  evidence.value = null;
  evidenceError.value = "";
  evidenceLoading.value = true;
  try {
    evidence.value = await getAnalyticsRecommendationEvidence(rec.id);
  } catch (err) {
    evidenceError.value = err instanceof Error ? err.message : String(err);
  } finally {
    evidenceLoading.value = false;
  }
}

onMounted(() => {
  void load();
  void loadRecommendations();
});
</script>

<template>
  <main class="px-7 pt-[26px] pb-12">
    <section class="mb-[22px] flex items-end justify-between gap-5">
      <div>
        <h1 class="mb-1.5 text-[26px] font-bold">因子分析</h1>
        <p class="text-subtle">哪些生产参数与高表现同时出现？分组统计是相关性观察，不构成因果结论。</p>
      </div>
      <div class="flex items-center gap-2">
        <RouterLink
          to="/insights/experiments"
          class="rounded-[10px] border border-hairline bg-white px-3.5 py-[9px] text-sm text-gray-600 no-underline hover:bg-gray-50"
        >
          内容实验
        </RouterLink>
        <RouterLink
          to="/insights"
          class="rounded-[10px] border border-hairline bg-white px-3.5 py-[9px] text-sm text-gray-600 no-underline hover:bg-gray-50"
        >
          返回分析首页
        </RouterLink>
      </div>
    </section>

    <!-- 优化建议（§十六：下一条视频怎么做） -->
    <section class="mb-5 rounded-2xl border border-hairline bg-panel p-[18px]">
      <div class="mb-2 flex items-center justify-between gap-3">
        <div>
          <h2 class="font-bold">优化建议（下一条视频怎么做）</h2>
          <p class="mt-0.5 text-xs text-subtle">
            从因子分组派生：仅样本 ≥8 的组出参数建议；采纳后自动预填创建流程并回写采纳回路
            <template v-if="recSummary && recSummary.total > 0">
              · 累计 采纳 {{ recSummary.accepted }} / 忽略 {{ recSummary.rejected }} / 已产出新内容 {{ recSummary.applied }}
            </template>
          </p>
        </div>
        <button
          class="shrink-0 cursor-pointer rounded-[10px] border border-brand bg-brand px-3.5 py-[9px] text-sm text-white hover:opacity-90 disabled:opacity-50"
          :disabled="recGenerating"
          @click="generate"
        >
          {{ recGenerating ? "生成中…" : "按最新数据生成" }}
        </button>
      </div>
      <p v-if="recLoading" class="flex items-center gap-2 py-4 text-sm text-subtle">
        <Spinner size="sm" /> 加载中…
      </p>
      <p v-else-if="recs.length === 0" class="py-4 text-sm text-subtle">
        暂无建议 —— 点上方按钮按当前数据生成（数据不足时会给出数据准备建议）。
      </p>
      <div v-else class="grid grid-cols-2 gap-2.5 max-lg:grid-cols-1">
        <div
          v-for="rec in recs"
          :key="rec.id"
          class="rounded-xl border p-3"
          :class="[
            rec.accepted === null ? 'border-brand/30 bg-brand-soft/40' : 'border-hairline bg-white opacity-70',
            evidenceOpen === rec.id ? 'col-span-2 max-lg:col-span-1' : '',
          ]"
          data-testid="rec-card"
        >
          <p class="text-[13px] font-semibold">
            {{ rec.recommendation.kindLabel }}：{{ rec.recommendation.label }}
            <span v-if="rec.accepted === true" class="ml-1 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-normal text-emerald-700">已采纳</span>
            <span v-else-if="rec.accepted === false" class="ml-1 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-normal text-gray-500">已忽略</span>
          </p>
          <p class="mt-1 text-xs leading-relaxed text-gray-600">{{ rec.reason }}</p>
          <p class="mt-1 text-[10px] text-subtle">
            依据样本 n={{ rec.sourceSampleCount }}
            <span v-if="rec.confidence !== null">· 置信度 {{ rec.confidence.toFixed(1) }}</span>
            · 指标 {{ rec.sourceMetric }}
          </p>
          <div v-if="rec.accepted === null" class="mt-2 flex gap-2">
            <button
              v-if="APPLICABLE_TYPES.has(rec.recommendationType)"
              type="button"
              class="cursor-pointer rounded-[10px] border border-brand bg-brand px-2.5 py-1 text-xs text-white hover:opacity-90"
              @click="adopt(rec)"
            >
              使用推荐参数创建
            </button>
            <button
              type="button"
              class="cursor-pointer rounded-[10px] border border-hairline bg-white px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50"
              :aria-expanded="evidenceOpen === rec.id"
              @click="toggleEvidence(rec)"
            >
              {{ evidenceOpen === rec.id ? "收起证据" : "查看证据" }}
            </button>
            <button
              type="button"
              class="cursor-pointer rounded-[10px] border border-hairline bg-white px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50"
              @click="ignore(rec)"
            >
              忽略
            </button>
          </div>
          <!-- 证据链：建议 → 快照（平台/窗口/指标）→ 分组 → 参与视频 → 指标来源 → 导入原始行 -->
          <div
            v-if="evidenceOpen === rec.id"
            class="mt-2 rounded-lg border border-hairline bg-[#fafbfc] p-2.5 text-xs"
            data-testid="evidence-panel"
          >
            <p v-if="evidenceLoading" class="text-subtle">证据加载中…</p>
            <p v-else-if="evidenceError" role="alert" class="text-red-600">{{ evidenceError }}</p>
            <template v-else-if="evidence">
              <p v-if="evidence.status === 'evidence_unavailable'" class="text-amber-800">
                证据不完整：{{ evidence.unavailableReasons.join("；") || "缺少可回放的统计快照" }}
              </p>
              <p v-if="evidence.snapshot" class="text-subtle">
                快照 #{{ evidence.snapshot.analysisType }} · 口径
                {{ evidence.snapshot.scope?.platform ?? "未限定平台" }} ·
                {{
                  evidence.snapshot.scope?.windowDays
                    ? `近 ${evidence.snapshot.scope.windowDays} 天`
                    : "全部历史"
                }}
                · 模型 {{ evidence.snapshot.modelVersion }} ·
                {{ evidence.snapshot.computedAt.slice(0, 10) }}
              </p>
              <p v-for="g in evidence.groups" :key="g.dimension + g.value" class="mt-1">
                分组 {{ g.dimension }}={{ g.value }}：真实样本 {{ g.realSampleCount }} / 共
                {{ g.sampleCount }}，中位 {{ g.median ?? "—" }}
              </p>
              <p v-if="evidence.videos.length > 0" class="mt-1.5 text-subtle">
                参与样本 {{ evidence.videos.length }} 条
              </p>
              <ul v-if="evidence.videos.length > 0" class="mt-1 space-y-1">
                <li v-for="v in evidence.videos.slice(0, 5)" :key="v.recordId">
                  {{ v.title }}（{{ v.platform }} · {{ v.recordId }}）
                  <span class="text-subtle">
                    指标 {{ Object.keys(v.metrics).length }} 项；生产特征字段来源
                    {{ v.fieldSources ? Object.keys(v.fieldSources).length : 0 }} 项；审计档案
                    {{ v.auditAvailable ? "有" : "无" }}
                  </span>
                </li>
              </ul>
              <p v-if="evidence.videos.length > 5" class="text-subtle">
                （仅列前 5 条，共 {{ evidence.videos.length }} 条）
              </p>
              <p v-if="evidence.importRows.length > 0" class="mt-1.5 text-subtle">
                导入原始行 {{ evidence.importRows.length }} 条
              </p>
              <ul v-if="evidence.importRows.length > 0" class="mt-1 space-y-1">
                <li
                  v-for="r in evidence.importRows.slice(0, 5)"
                  :key="`${r.batchId}-${r.rowNumber}`"
                  data-testid="evidence-import-row"
                >
                  批次 {{ r.batchId }} · 第 {{ r.rowNumber }} 行 ·
                  {{ r.filename ?? "文件名未知" }} · 裁决 {{ r.decisionType ?? "无记录" }}
                </li>
              </ul>
              <p
                v-for="reason in evidence.unavailableReasons"
                :key="reason"
                class="mt-1 text-amber-800"
              >
                {{ reason }}
              </p>
            </template>
          </div>
        </div>
      </div>
    </section>

    <!-- 目标指标（批次 5B：页面装载/切指标均为纯读 GET，留档必须走显式按钮） -->
    <section class="mb-4 flex flex-wrap items-center gap-2">
      <span class="text-sm text-subtle">目标指标：</span>
      <button
        v-for="m in FACTOR_METRIC_OPTIONS"
        :key="m.value"
        type="button"
        class="cursor-pointer rounded-full border px-3 py-1 text-xs transition-colors"
        :class="
          metric === m.value
            ? 'border-brand bg-brand-soft text-brand font-medium'
            : 'border-hairline bg-white text-gray-600 hover:bg-gray-50'
        "
        @click="pickMetric(m.value)"
      >
        {{ m.label }}
      </button>
    </section>

    <!-- 默认完播率无导入数据时点破并给出可换指标，但不替用户换（docs/22 §6.1） -->
    <p
      v-if="metricHasNoSample"
      class="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800"
      data-testid="metric-switch-hint"
    >
      <span>完播率暂无可统计的导入数据，分组结果会是空的。</span>
      <button
        type="button"
        class="cursor-pointer rounded-[10px] border border-amber-300 bg-white px-2.5 py-1 text-xs hover:bg-amber-100"
        @click="pickMetric('effective_play_rate_2s')"
      >
        改看「2 秒有效播放率」
      </button>
      <span class="text-xs">系统不会自动替你换指标。</span>
    </p>

    <!-- 因子维度多选 -->
    <section class="mb-5 flex flex-wrap items-center gap-2">
      <span class="text-sm text-subtle">因子维度：</span>
      <label
        v-for="d in FACTOR_DIMENSION_OPTIONS"
        :key="d.value"
        class="flex cursor-pointer items-center gap-1.5 rounded-full border border-hairline bg-white px-3 py-1 text-xs text-gray-600 hover:bg-gray-50"
      >
        <input
          type="checkbox"
          class="accent-[var(--color-brand,#6d5dfc)]"
          :checked="dimensions.includes(d.value)"
          @change="toggleDimension(d.value)"
        />
        {{ d.label }}
      </label>
    </section>

    <!-- 留档显式化（批次 5B）：重算才写 analysis_result，页面加载不再静默写库 -->
    <div class="mb-4 flex items-center gap-2">
      <button
        type="button"
        class="cursor-pointer rounded-[10px] border border-brand bg-brand px-3.5 py-[9px] text-sm text-white hover:opacity-90 disabled:opacity-50"
        :disabled="archiving"
        @click="recomputeAndArchive"
      >
        {{ archiving ? "重算并留档中…" : "重算并留档" }}
      </button>
      <span class="text-xs text-subtle">重新计算当前指标与维度并写入快照留痕；不点击仅展示，不写库。</span>
    </div>

    <div
      v-if="errorMsg"
      role="alert"
      class="mb-4 flex items-center justify-between gap-3 rounded-xl bg-red-50 p-3 text-sm text-red-600"
    >
      <span>{{ errorMsg }}</span>
      <button class="cursor-pointer rounded border border-red-300 px-2 py-1 text-xs hover:bg-red-100" @click="load">
        重试
      </button>
    </div>

    <p v-if="loading" class="flex items-center gap-2 p-8 text-sm text-subtle">
      <Spinner size="sm" /> 分组统计中…
    </p>

    <template v-else-if="result">
      <!-- 账号基准 -->
      <div class="mb-4 rounded-2xl border border-hairline bg-panel p-[18px]">
        <p class="text-[13px] text-subtle">账号整体基准（{{ metricLabel }}）</p>
        <p class="mt-1 text-[26px] leading-none font-extrabold">
          {{ formatMetric(result.accountMedian) }}
          <span class="ml-2 align-middle text-sm font-normal text-subtle">
            有该指标的样本 {{ result.accountSampleCount }} 条
          </span>
        </p>
        <p v-if="result.accountSampleCount < 8" class="mt-2 rounded-lg border border-[#f8df9c] bg-[#fff8e8] px-3 py-2 text-xs">
          总样本不足 8 条：以下所有对比仅供参考，请勿据此下结论。
        </p>
      </div>

      <!-- 各维度分组卡 -->
      <div class="grid grid-cols-2 gap-4 max-lg:grid-cols-1">
        <section
          v-for="dim in result.dimensions"
          :key="dim.dimension"
          class="rounded-2xl border border-hairline bg-panel p-4"
        >
          <h2 class="mb-2 font-bold">{{ dimensionLabel(dim.dimension) }}</h2>
          <p v-if="dim.groups.length === 0" class="text-xs text-subtle">暂无可统计样本（未导入该指标）。</p>
          <table v-else class="w-full border-collapse text-left text-[13px]">
            <thead class="text-xs text-subtle">
              <tr>
                <th class="border-b border-hairline py-1.5 pr-2 font-semibold">取值</th>
                <th class="border-b border-hairline py-1.5 pr-2 text-right font-semibold">样本</th>
                <th class="border-b border-hairline py-1.5 pr-2 text-right font-semibold">中位</th>
                <th class="border-b border-hairline py-1.5 pr-2 text-right font-semibold">均值</th>
                <th class="border-b border-hairline py-1.5 text-right font-semibold">vs 账号</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="g in dim.groups" :key="g.value">
                <td class="border-b border-hairline py-1.5 pr-2">
                  {{ g.value }}
                  <span
                    v-if="g.lowSample"
                    class="ml-1 rounded bg-amber-50 px-1 py-0.5 text-[10px] text-amber-700"
                    title="样本不足 8 条，仅供参考"
                    >参考</span
                  >
                </td>
                <td class="border-b border-hairline py-1.5 pr-2 text-right tabular-nums">{{ g.sampleCount }}</td>
                <td class="border-b border-hairline py-1.5 pr-2 text-right tabular-nums">{{ formatMetric(g.median) }}</td>
                <td class="border-b border-hairline py-1.5 pr-2 text-right tabular-nums text-subtle">{{ formatMetric(g.mean) }}</td>
                <td
                  class="border-b border-hairline py-1.5 text-right tabular-nums"
                  :class="(g.diff ?? 0) >= 0 ? 'text-ok' : 'text-bad'"
                >
                  <template v-if="g.diff !== null && metricUnit === 'rate'">
                    {{ (g.diff * 100).toFixed(1) }}pp
                  </template>
                  <template v-else-if="g.diff !== null">{{ g.diff.toFixed(0) }}</template>
                  <template v-else>—</template>
                </td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>

      <p class="mt-4 text-xs text-subtle">{{ result.note }}（计算时间 {{ result.computedAt.slice(0, 16).replace("T", " ") }}，结果已留痕 analysis_result）</p>
    </template>
  </main>
</template>
