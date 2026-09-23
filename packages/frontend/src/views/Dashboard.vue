<script setup lang="ts">
/**
 * 工作台（原型 #dashboard）— 指标 / 生产流水线 / 最近任务
 * 数据源：GET /api/dashboard/summary 聚合端点
 * 轮询策略：仅本页组件存活期间运行（onMounted 起 / onUnmounted 即停），间隔 500ms；
 * 页面隐藏（切后台）时跳过请求，单飞防重入，失败保留上一次数据。
 */
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import { client } from "../api/client";
import StatusPill from "../components/ui/status-pill.vue";
import { goCreate } from "../lib/create-session";
import { STATUS_LABEL, TEMPLATE_LABEL, relativeTime, statusVariant } from "../lib/status";

/** 聚合响应类型（与 openapi schema 对齐，不一致会在赋值处编译报错） */
interface Summary {
  today: number;
  yesterday: number;
  pendingRender: number;
  ttsActive: number;
  completedVideos: number;
  topTemplate: { name: string; share: number } | null;
  failed: number;
  failureReasons: string[];
  pipeline: {
    generating: number;
    validating: number;
    tts: number;
    rendering: number;
    publishable: number;
  };
  recent: {
    id: string;
    title: string;
    template: string;
    level: string;
    status: string;
    intro: string;
    updatedAt: string;
  }[];
}

const router = useRouter();
const summary = ref<Summary | null>(null);
const errorMsg = ref("");
const lastSync = ref("");
let inFlight = false;

/* 模块级单例轮询器：同一时刻全局只有一个 timer。
 * 后挂载实例接管时先清旧 timer，消除 HMR/快速切页场景的残留叠加轮询。 */
let pollTimer: ReturnType<typeof setInterval> | undefined;
let pollTick: (() => void) | null = null;
function startPolling(tick: () => void): void {
  stopPolling();
  pollTick = tick;
  pollTimer = setInterval(() => pollTick?.(), 500);
}
function stopPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = undefined;
  pollTick = null;
}

/** 单次拉取：单飞（上一请求未完则跳过，500ms 高频下避免叠加）；失败不清旧数据 */
async function refresh(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const { data, error } = await client.GET("/api/dashboard/summary");
    if (data) {
      summary.value = data as Summary;
      errorMsg.value = "";
      lastSync.value = new Date().toLocaleTimeString("zh-CN");
    } else {
      errorMsg.value = typeof error === "string" ? error : "聚合数据拉取失败";
    }
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    inFlight = false;
  }
}

onMounted(() => {
  void refresh();
  // 页面隐藏（切后台/切走）：不发请求，回到前台自动恢复
  startPolling(() => {
    if (document.visibilityState === "visible") void refresh();
  });
});
/** 离开 Dashboard 组件即销毁轮询 — 不占用其他页面的网络/CPU */
onUnmounted(stopPolling);

/* ── Hero 问候（按当前时段） ── */
const greeting = computed(() => {
  const hour = new Date().getHours();
  if (hour < 6) return "凌晨好";
  if (hour < 12) return "早上好";
  if (hour < 18) return "下午好";
  return "晚上好";
});

/* ── 指标派生（全部来自聚合端点，前端不再拉全量列表自算） ── */
const loading = computed(() => summary.value === null);
const todayDelta = computed(() => {
  const s = summary.value;
  if (!s) return "—";
  if (s.yesterday === 0) return s.today > 0 ? "较昨日 +100%" : "较昨日 持平";
  const pct = Math.round(((s.today - s.yesterday) / s.yesterday) * 100);
  return `较昨日 ${pct >= 0 ? "+" : ""}${pct}%`;
});
const topTemplateShare = computed(() => {
  const s = summary.value;
  if (!s) return "—";
  if (!s.topTemplate) return "暂无已完成成片";
  const label = TEMPLATE_LABEL[s.topTemplate.name] ?? s.topTemplate.name;
  return `模板分布：${label} 占 ${s.topTemplate.share}%（共 ${s.completedVideos} 条成片）`;
});
const failureSummary = computed(() => summary.value?.failureReasons.join("、") ?? "");
/** 待推进拆解（纯前端派生）：待配音 = 内容就绪存量，待渲染 = 待推进 - 待配音，直接回答卡在哪一步 */
const pendingBreakdown = computed(() => {
  const s = summary.value;
  if (!s) return null;
  const awaitingTts = s.pipeline.validating;
  const awaitingRender = Math.max(0, s.pendingRender - awaitingTts);
  return `待配音 ${awaitingTts} · 待渲染 ${awaitingRender}`;
});

/* ── 生产流水线（后端实时存量；第一个有存量的阶段即卡点） ── */
const stages = computed(() => {
  const p = summary.value?.pipeline;
  return [
    { label: "内容生成", count: p?.generating ?? 0, mini: "LLM 处理中" },
    { label: "内容就绪", count: p?.validating ?? 0, mini: "验收通过，等待配音" },
    { label: "TTS 配音", count: p?.tts ?? 0, mini: "配音进行中" },
    { label: "视频渲染", count: p?.rendering ?? 0, mini: "Playwright + FFmpeg" },
    { label: "可发布", count: p?.publishable ?? 0, mini: "成片未标记，等待运营" },
  ];
});
const activeStage = computed(() => stages.value.findIndex((s) => s.count > 0));

const recentTasks = computed(() => summary.value?.recent ?? []);
</script>

<template>
  <div class="px-7 pt-[26px] pb-12">
    <p v-if="errorMsg" class="mb-4 rounded-xl bg-red-50 p-3 text-sm text-red-600">{{ errorMsg }}</p>

    <!-- Hero（原型 .hero） -->
    <section class="mb-[22px] flex items-end justify-between gap-5">
      <div>
        <h1 class="mb-1.5 text-[26px] font-bold">{{ greeting }}，今天继续生产高质量英语短视频</h1>
        <p class="text-subtle">从内容生成到渲染发布，所有生产状态都在这里。</p>
      </div>
      <button
        class="rounded-[10px] border border-brand bg-brand px-4 py-[10px] text-white cursor-pointer hover:opacity-90"
        @click="goCreate()"
      >
        开始创建
      </button>
    </section>

    <!-- 指标卡（原型 .grid4 .metric） -->
    <section class="grid grid-cols-4 gap-3.5 max-lg:grid-cols-2">
      <div class="rounded-2xl border border-hairline bg-panel p-[18px]">
        <p class="text-[13px] text-subtle">今日生成</p>
        <p class="mt-2 text-[30px] leading-none font-extrabold">{{ loading ? "—" : summary?.today }}</p>
        <p class="mt-1.5 text-xs text-subtle">{{ todayDelta }}</p>
      </div>
      <div class="rounded-2xl border border-hairline bg-panel p-[18px]">
        <p class="text-[13px] text-subtle">待推进任务</p>
        <p class="mt-2 text-[30px] leading-none font-extrabold">
          {{ loading ? "—" : summary?.pendingRender }}
        </p>
        <!-- 口径说明：待推进 = 内容就绪等配音 + 配音完成等渲染，前端拆解直接回答卡在哪一步 -->
        <p class="mt-1.5 text-xs text-subtle">
          {{ pendingBreakdown ?? "内容就绪等配音 + 已配音待渲染" }}
        </p>
      </div>
      <div class="rounded-2xl border border-hairline bg-panel p-[18px]">
        <p class="text-[13px] text-subtle">已完成视频</p>
        <p class="mt-2 text-[30px] leading-none font-extrabold">
          {{ loading ? "—" : summary?.completedVideos }}
        </p>
        <p class="mt-1.5 text-xs text-subtle">{{ topTemplateShare }}</p>
      </div>
      <!-- 异常任务：存在失败时整卡标红，副文案直出失败原因（后端从审计档案聚合） -->
      <div
        class="rounded-2xl border p-[18px] transition-colors"
        :class="
          (summary?.failed ?? 0) > 0
            ? 'border-bad/50 bg-red-50'
            : 'border-hairline bg-panel'
        "
      >
        <p class="text-[13px]" :class="(summary?.failed ?? 0) > 0 ? 'font-semibold text-bad' : 'text-subtle'">
          异常任务
        </p>
        <p
          class="mt-2 text-[30px] leading-none font-extrabold"
          :class="(summary?.failed ?? 0) > 0 ? 'text-bad' : ''"
        >
          {{ loading ? "—" : summary?.failed }}
        </p>
        <p class="mt-1.5 text-xs" :class="(summary?.failed ?? 0) > 0 ? 'text-bad' : 'text-subtle'">
          {{ (summary?.failed ?? 0) > 0 ? failureSummary : "暂无异常，运行平稳" }}
        </p>
      </div>
    </section>

    <!-- 生产流水线（原型 .pipeline .stage） -->
    <section class="mt-[22px]">
      <div class="mb-3 flex items-center justify-between">
        <h2 class="text-[17px] font-bold">生产流水线</h2>
        <!-- 真实时：500ms 轮询聚合端点，角标展示最后同步时刻 -->
        <span class="flex items-center gap-1.5 text-[13px] text-subtle">
          <i class="h-1.5 w-1.5 animate-pulse rounded-full bg-ok"></i>
          实时状态{{ lastSync ? ` · ${lastSync}` : "" }}
        </span>
      </div>
      <div class="grid grid-cols-5 gap-2.5 max-lg:grid-cols-2">
        <div
          v-for="(s, i) in stages"
          :key="s.label"
          class="rounded-[14px] border bg-panel p-3.5 transition-colors"
          :class="i === activeStage ? 'border-brand-line bg-brand-soft' : 'border-hairline'"
        >
          <b class="text-[13px]">{{ s.label }}</b>
          <p class="my-1.5 text-2xl leading-none font-extrabold">{{ loading ? "—" : s.count }}</p>
          <p class="text-xs text-subtle">{{ s.mini }}</p>
        </div>
      </div>
    </section>

    <!-- 最近任务（原型 .table-card） -->
    <section class="mt-[22px]">
      <div class="mb-3 flex items-center justify-between">
        <h2 class="text-[17px] font-bold">最近任务</h2>
        <button
          class="rounded-[10px] border border-hairline bg-white px-3.5 py-[9px] cursor-pointer hover:bg-gray-50"
          @click="router.push('/tasks')"
        >
          查看全部
        </button>
      </div>
      <div class="overflow-hidden rounded-2xl border border-hairline bg-panel">
        <table class="w-full border-collapse text-left text-[13px]">
          <thead>
            <tr class="bg-[#fafbfc] text-subtle">
              <th class="border-b border-hairline px-3.5 py-[13px] font-semibold">标题</th>
              <th class="border-b border-hairline px-3.5 py-[13px] font-semibold">模板</th>
              <th class="border-b border-hairline px-3.5 py-[13px] font-semibold">等级</th>
              <th class="border-b border-hairline px-3.5 py-[13px] font-semibold">状态</th>
              <th class="border-b border-hairline px-3.5 py-[13px] font-semibold">片头</th>
              <th class="border-b border-hairline px-3.5 py-[13px] font-semibold">更新时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading">
              <td colspan="6" class="px-3.5 py-10 text-center text-subtle">加载中…</td>
            </tr>
            <tr v-else-if="recentTasks.length === 0">
              <td colspan="6" class="px-3.5 py-10 text-center text-subtle">
                暂无生成记录，点右上「新建视频」开始生产
              </td>
            </tr>
            <template v-else>
              <tr
                v-for="t in recentTasks"
                :key="t.id"
                class="cursor-pointer hover:bg-brand-soft/60"
                @click="router.push(`/tasks/${t.id}`)"
              >
                <td class="border-b border-hairline px-3.5 py-[13px]">{{ t.title }}</td>
                <td class="border-b border-hairline px-3.5 py-[13px]">
                  {{ TEMPLATE_LABEL[t.template] ?? t.template }}
                </td>
                <td class="border-b border-hairline px-3.5 py-[13px]">{{ t.level }}</td>
                <td class="border-b border-hairline px-3.5 py-[13px]">
                  <StatusPill :variant="statusVariant(t.status)">
                    {{ STATUS_LABEL[t.status] ?? t.status }}
                  </StatusPill>
                </td>
                <td class="border-b border-hairline px-3.5 py-[13px]">{{ t.intro }}</td>
                <td class="border-b border-hairline px-3.5 py-[13px] text-subtle">
                  {{ relativeTime(t.updatedAt) }}
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>
