<script setup lang="ts">
/**
 * 内容实验页（Phase 6，需求 §八.9/§二十）— A/B 内容实验登记与描述统计评估
 * 纪律：评估只给描述统计（中位/差值/样本数），小样本明确标注不构成结论；
 * completed 状态仅由「评估」写入，评估结论不可手改
 */
import { computed, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import {
  type AnalyticsVideoRow,
  type ExperimentAssignmentView,
  type ExperimentView,
  createAnalyticsExperiment,
  evaluateAnalyticsExperiment,
  listAnalyticsExperimentAssignments,
  listAnalyticsExperiments,
  listAnalyticsVideos,
  updateAnalyticsExperimentStatus,
} from "../api/client";
import Spinner from "../components/ui/spinner.vue";
import { EXPERIMENT_VARIABLE_OPTIONS, experimentVariableLabel } from "../lib/analytics-insights";
import { toast } from "../lib/toast";

// 变量选项来自 lib/analytics-insights（与新建页选择器同源）
const METRICS = [
  { value: "completion_rate", label: "完播率" },
  { value: "effective_play_rate_2s", label: "2秒有效播放率" },
  { value: "engagement_rate", label: "互动率" },
  { value: "like_rate", label: "点赞率" },
  { value: "play_count", label: "播放量" },
];
const STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  running: "进行中",
  completed: "已评估",
  cancelled: "已取消",
};

const experiments = ref<ExperimentView[]>([]);
const contents = ref<AnalyticsVideoRow[]>([]);
const loading = ref(true);
const errorMsg = ref("");

/* 创建表单 */
const form = ref({
  variable: "hook",
  targetMetric: "completion_rate",
  labelA: "",
  labelB: "",
  idsA: [] as string[],
  idsB: [] as string[],
  controlNote: "",
});
const submitting = ref(false);

/** 同一内容不能同时在两组（表单层即时拦截，后端仍会校验） */
const conflictIds = computed(() => form.value.idsA.filter((id) => form.value.idsB.includes(id)));

function togglePick(group: "A" | "B", contentId: string): void {
  const key = group === "A" ? "idsA" : "idsB";
  const list = form.value[key];
  form.value[key] = list.includes(contentId)
    ? list.filter((id) => id !== contentId)
    : [...list, contentId];
}

async function load(): Promise<void> {
  loading.value = true;
  errorMsg.value = "";
  try {
    const [exps, videos] = await Promise.all([
      listAnalyticsExperiments(),
      listAnalyticsVideos({ pageSize: 100 }),
    ]);
    experiments.value = exps;
    // 参与分组的内容 = 已有发布记录的（按 contentId 去重，保留首行标题）
    const seen = new Set<string>();
    contents.value = videos.items.filter((v) =>
      seen.has(v.contentId) ? false : seen.add(v.contentId),
    );
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function submit(): Promise<void> {
  if (conflictIds.value.length > 0) {
    toast.warning("同一内容不能同时属于 A/B 两组");
    return;
  }
  submitting.value = true;
  try {
    await createAnalyticsExperiment({
      variable: form.value.variable,
      targetMetric: form.value.targetMetric,
      variantA: { label: form.value.labelA || "A 组", contentIds: form.value.idsA },
      variantB: { label: form.value.labelB || "B 组", contentIds: form.value.idsB },
      ...(form.value.controlNote ? { controlVariables: { note: form.value.controlNote } } : {}),
    });
    toast.success("实验已登记（草稿）");
    form.value = {
      variable: "hook",
      targetMetric: "completion_rate",
      labelA: "",
      labelB: "",
      idsA: [],
      idsB: [],
      controlNote: "",
    };
    await load();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  } finally {
    submitting.value = false;
  }
}

async function evaluate(exp: ExperimentView): Promise<void> {
  try {
    await evaluateAnalyticsExperiment(exp.id);
    toast.success("评估完成（描述统计，非因果结论）");
    await load();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  }
}

async function cancel(exp: ExperimentView): Promise<void> {
  try {
    await updateAnalyticsExperimentStatus(exp.id, "cancelled");
    await load();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  }
}

/** 分配台账（批次三）：评估以它为准；旧的两组清单只是事后登记 */
const ledgerOpen = ref<string | null>(null);
/** 请求令牌：先点 A 再点 B 时，A 的迟到响应不得写进 B 的台账 */
const ledgerToken = ref(0);
const ledger = ref<ExperimentAssignmentView[]>([]);
const ledgerLoading = ref(false);
const ledgerError = ref("");

const ledgerUnbound = computed(() => ledger.value.filter((a) => a.contentId === null).length);

async function toggleLedger(exp: ExperimentView): Promise<void> {
  if (ledgerOpen.value === exp.id) {
    ledgerOpen.value = null;
    ledger.value = [];
    ledgerToken.value += 1;
    return;
  }
  const token = ++ledgerToken.value;
  ledgerOpen.value = exp.id;
  ledger.value = [];
  ledgerError.value = "";
  ledgerLoading.value = true;
  try {
    const rows = await listAnalyticsExperimentAssignments(exp.id);
    // 迟到的响应只允许写回它自己那次点击展开的卡片
    if (token !== ledgerToken.value) return;
    ledger.value = rows;
  } catch (err) {
    if (token !== ledgerToken.value) return;
    ledgerError.value = err instanceof Error ? err.message : String(err);
  } finally {
    if (token === ledgerToken.value) ledgerLoading.value = false;
  }
}

function fmt(value: number | null, metric: string): string {
  if (value === null) return "—";
  return metric.includes("rate")
    ? `${(value * 100).toFixed(1)}%`
    : Math.round(value).toLocaleString("zh-CN");
}

/** 控制变量说明（后端存 { note } 自由文本；非法形状返回空） */
function controlNote(exp: ExperimentView): string {
  const cv = exp.controlVariables;
  if (cv && typeof cv === "object" && typeof (cv as { note?: unknown }).note === "string") {
    return (cv as { note: string }).note;
  }
  return "";
}

onMounted(load);
</script>

<template>
  <main class="px-7 pt-[26px] pb-12">
    <section class="mb-[22px] flex items-end justify-between gap-5">
      <div>
        <h1 class="mb-1.5 text-[26px] font-bold">内容实验</h1>
        <p class="text-subtle">A/B 内容实验登记与评估：一个变量 × 两组内容；结论恒为描述统计（相关≠因果）。</p>
      </div>
      <RouterLink to="/insights/factors" class="rounded-[10px] border border-hairline bg-white px-3.5 py-[9px] text-sm text-gray-600 no-underline hover:bg-gray-50">返回因子分析</RouterLink>
    </section>

    <div v-if="errorMsg" role="alert" class="mb-4 flex items-center justify-between gap-3 rounded-xl bg-red-50 p-3 text-sm text-red-600">
      <span>{{ errorMsg }}</span>
      <button class="cursor-pointer rounded border border-red-300 px-2 py-1 text-xs hover:bg-red-100" @click="load">重试</button>
    </div>

    <!-- 创建实验 -->
    <section class="mb-5 rounded-2xl border border-hairline bg-panel p-4">
      <h2 class="mb-3 font-bold">登记新实验</h2>
      <div class="grid grid-cols-3 gap-3 max-lg:grid-cols-1">
        <label class="text-[13px] text-subtle">实验变量
          <select v-model="form.variable" class="mt-1 w-full cursor-pointer rounded-[10px] border border-hairline bg-white px-2 py-2 text-sm text-ink focus:border-brand focus:outline-none">
            <option v-for="v in EXPERIMENT_VARIABLE_OPTIONS" :key="v.value" :value="v.value">{{ v.label }}</option>
          </select>
        </label>
        <label class="text-[13px] text-subtle">目标指标
          <select v-model="form.targetMetric" class="mt-1 w-full cursor-pointer rounded-[10px] border border-hairline bg-white px-2 py-2 text-sm text-ink focus:border-brand focus:outline-none">
            <option v-for="m in METRICS" :key="m.value" :value="m.value">{{ m.label }}</option>
          </select>
        </label>
        <label class="text-[13px] text-subtle">控制变量说明
          <input v-model="form.controlNote" class="mt-1 w-full rounded-[10px] border border-hairline bg-white px-2 py-2 text-sm text-ink focus:border-brand focus:outline-none" placeholder="除实验变量外保持一致的维度" maxlength="200" />
        </label>
      </div>
      <div class="mt-3 grid grid-cols-2 gap-3 max-lg:grid-cols-1">
        <div class="rounded-xl border border-hairline bg-white p-3">
          <input v-model="form.labelA" class="w-full rounded border border-hairline px-2 py-1.5 text-sm" placeholder="A 组名称（如：错误示范 Hook）" maxlength="255" />
          <p class="mt-2 mb-1 text-xs text-subtle">选择 A 组内容（仅已建发布记录的）</p>
          <div class="max-h-44 space-y-1 overflow-y-auto">
            <label v-for="c in contents" :key="`a-${c.contentId}`" class="flex cursor-pointer items-center gap-2 text-[13px]">
              <input type="checkbox" class="accent-[var(--color-brand,#6d5dfc)]" :checked="form.idsA.includes(c.contentId)" @change="togglePick('A', c.contentId)" />
              <span class="truncate">{{ c.title }}</span><span class="shrink-0 text-xs text-subtle">{{ c.platform }}</span>
            </label>
            <p v-if="contents.length === 0" class="text-xs text-subtle">暂无可选内容</p>
          </div>
        </div>
        <div class="rounded-xl border border-hairline bg-white p-3">
          <input v-model="form.labelB" class="w-full rounded border border-hairline px-2 py-1.5 text-sm" placeholder="B 组名称（如：提问 Hook）" maxlength="255" />
          <p class="mt-2 mb-1 text-xs text-subtle">选择 B 组内容</p>
          <div class="max-h-44 space-y-1 overflow-y-auto">
            <label v-for="c in contents" :key="`b-${c.contentId}`" class="flex cursor-pointer items-center gap-2 text-[13px]">
              <input type="checkbox" class="accent-[var(--color-brand,#6d5dfc)]" :checked="form.idsB.includes(c.contentId)" @change="togglePick('B', c.contentId)" />
              <span class="truncate">{{ c.title }}</span><span class="shrink-0 text-xs text-subtle">{{ c.platform }}</span>
            </label>
          </div>
        </div>
      </div>
      <div class="mt-3 flex items-center justify-between">
        <p v-if="conflictIds.length > 0" class="text-xs text-bad">冲突：{{ conflictIds.join(", ") }} 同时在两组</p>
        <p v-else class="text-xs text-subtle">两组各 ≥8 条时评估才有结论力；不足只给描述统计</p>
        <button class="cursor-pointer rounded-[10px] border border-brand bg-brand px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50" :disabled="submitting || conflictIds.length > 0 || form.idsA.length === 0 || form.idsB.length === 0" @click="submit">
          {{ submitting ? "登记中…" : "登记实验" }}
        </button>
      </div>
    </section>

    <!-- 实验列表 -->
    <p v-if="loading" class="flex items-center gap-2 p-8 text-sm text-subtle"><Spinner size="sm" /> 加载中…</p>
    <p v-else-if="experiments.length === 0" class="p-8 text-center text-sm text-subtle">暂无实验 —— 用上方表单登记第一组 A/B 实验</p>
    <div v-else class="space-y-3">
      <section v-for="exp in experiments" :key="exp.id" class="rounded-2xl border border-hairline bg-panel p-4">
        <div class="mb-1 flex items-center justify-between gap-3">
          <h3 class="font-bold">
            {{ experimentVariableLabel(exp.variable) }}实验：{{ exp.variantA.label || "A" }} vs {{ exp.variantB.label || "B" }}
            <span class="ml-2 rounded-full bg-gray-100 px-2 py-0.5 align-middle text-[10px] font-normal text-gray-600">{{ STATUS_LABEL[exp.status] ?? exp.status }}</span>
          </h3>
          <div class="flex shrink-0 gap-2">
            <button v-if="exp.status !== 'cancelled'" class="cursor-pointer rounded-[10px] border border-brand bg-brand px-3 py-1.5 text-xs text-white hover:opacity-90" @click="evaluate(exp)">
              {{ exp.result ? "重新评估" : "评估" }}
            </button>
            <button class="cursor-pointer rounded-[10px] border border-hairline bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50" :aria-expanded="ledgerOpen === exp.id" @click="toggleLedger(exp)">
              {{ ledgerOpen === exp.id ? "收起台账" : "分配台账" }}
            </button>
            <button v-if="exp.status === 'draft' || exp.status === 'running'" class="cursor-pointer rounded-[10px] border border-hairline bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50" @click="cancel(exp)">取消</button>
          </div>
        </div>
        <p class="mb-2 text-xs text-subtle">
          登记清单 A：{{ exp.variantA.contentIds.length }} 条 · B：{{ exp.variantB.contentIds.length }} 条 · 目标指标 {{ exp.targetMetric }}
          <template v-if="controlNote(exp)"> · 控制变量：{{ controlNote(exp) }}</template>
        </p>
        <div v-if="exp.result" class="rounded-xl bg-shell p-3 text-[13px]">
          <p class="font-medium">{{ exp.result.verdict }}</p>
          <p class="mt-1 text-xs text-subtle">
            A 中位 {{ fmt(exp.result.medianA, exp.result.targetMetric) }}（n={{ exp.result.sampleA }}）·
            B 中位 {{ fmt(exp.result.medianB, exp.result.targetMetric) }}（n={{ exp.result.sampleB }}）·
            差值 {{ exp.result.diff === null ? "—" : exp.result.targetMetric.includes("rate") ? `${(exp.result.diff * 100).toFixed(1)}pp` : exp.result.diff.toFixed(0) }}
            <span v-if="exp.result.lowSample" class="ml-1 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">样本不足，仅供参考</span>
          </p>
          <p class="mt-1 text-[10px] text-subtle">{{ exp.result.note }}（{{ exp.result.modelVersion }} · {{ exp.result.evaluatedAt.slice(0, 16).replace("T", " ") }}）</p>
        </div>
        <!-- 分配台账：谁在生成前被定为哪一组、是否已绑定内容 -->
        <div
          v-if="ledgerOpen === exp.id"
          class="mt-2 rounded-xl border border-hairline bg-[#fafbfc] p-3 text-xs"
          data-testid="assignment-ledger"
        >
          <p v-if="ledgerLoading" class="text-subtle">台账加载中…</p>
          <p v-else-if="ledgerError" role="alert" class="text-red-600">{{ ledgerError }}</p>
          <template v-else>
            <p class="text-subtle">
              共 {{ ledger.length }} 条分配 · 已绑定 {{ ledger.length - ledgerUnbound }} 条 · 未绑定
              {{ ledgerUnbound }} 条（生成失败、未完成或绑定未成功，不计入样本）
            </p>
            <p v-if="ledger.length === 0" class="mt-1 text-subtle">
              还没有生成前的变体分配：这条实验只能按登记清单做事后分组。在新建页选它并选 A/B 后，
              每次生成都会先登记一条分配。
            </p>
            <ul v-else class="mt-1.5 space-y-1">
              <li v-for="a in ledger" :key="a.id" data-testid="assignment-row">
                {{ a.variant }} 组 ·
                {{ a.contentId ?? "未绑定内容" }} · 分配于
                {{ a.assignedAt.slice(0, 16).replace("T", " ") }} ·
                {{
                  a.boundAt
                    ? `绑定于 ${a.boundAt.slice(0, 16).replace("T", " ")}`
                    : "尚未绑定内容（生成失败、未完成或绑定未成功）"
                }}
              </li>
            </ul>
          </template>
        </div>
      </section>
    </div>
  </main>
</template>
