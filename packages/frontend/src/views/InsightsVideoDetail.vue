<script setup lang="ts">
/**
 * 单视频分析（页面 C，需求 §十一/§十五/§十七）— 生产参数与最终表现放同一屏
 * 数据来源分块独立加载（部分来源缺失不影响其它块）；
 * 无秒级留存数据 → 明确提示不展示曲线，绝不伪造（需求 §二十二）
 */
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  type AnalyticsBenchmark,
  type AnalyticsFeature,
  type AnalyticsTrendRecord,
  type TimelineSegment,
  type VideoMetricView,
  getAnalyticsBenchmark,
  getAnalyticsFeature,
  getAnalyticsTimeline,
  getAnalyticsTrend,
  getAnalyticsVideoMetrics,
  getAnalyticsVideoStructure,
  patchAnalyticsFeature,
  syncAnalyticsFeature,
} from "../api/client";
import Spinner from "../components/ui/spinner.vue";
import {
  HOOK_OPTIONS,
  METRIC_FALLBACK_LABEL,
  SCENE_OPTIONS,
  SEGMENT_TYPE_LABEL,
  emptyReasonLabel,
  formatDiff,
  sourceLabel,
  trendGeometry,
} from "../lib/analytics-insights";
import { goCreate } from "../lib/create-session";
import { toast } from "../lib/toast";

const route = useRoute();
const router = useRouter();
const contentId = computed(() => String(route.params.id ?? ""));

const feature = ref<AnalyticsFeature | null>(null);
const metrics = ref<VideoMetricView[]>([]);
const metricsEmptyReason = ref<string | null>(null);
const publishMeta = ref<
  { platform: string; platformVideoId: string | null; publishTime: string | null }[]
>([]);
const benchmark = ref<AnalyticsBenchmark | null>(null);
const trends = ref<AnalyticsTrendRecord[]>([]);
const timeline = ref<TimelineSegment[]>([]);
const timelineEmptyReason = ref<string | null>("not_derived");
const timelineSyncing = ref(false);
const loading = ref(true);
const loadError = ref("");

/** 最新值按 canonical 名索引（缺键 = 无数据，UI 渲染「暂无数据」） */
const metricByName = computed(() => new Map(metrics.value.map((m) => [m.metricName, m])));

/** 时间轴单独加载（不阻断主流程；未派生时页面给同步入口） */
async function loadTimeline(): Promise<void> {
  try {
    const data = await getAnalyticsTimeline(contentId.value);
    timeline.value = data.segments;
    timelineEmptyReason.value = data.emptyReason;
  } catch {
    timeline.value = [];
    timelineEmptyReason.value = "not_derived";
  }
}

async function syncTimeline(): Promise<void> {
  timelineSyncing.value = true;
  try {
    await syncAnalyticsFeature(contentId.value);
    await loadTimeline();
    toast.success("时间轴已按生产口径重建");
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  } finally {
    timelineSyncing.value = false;
  }
}

/** 复用此视频结构（§十七）：提取骨架 + 模板/语速预填，换主题/场景/词汇由创建页完成 */
async function reuseStructure(): Promise<void> {
  try {
    const structure = await getAnalyticsVideoStructure(contentId.value);
    if (structure.skeleton.length === 0) {
      toast.warning("暂无可复用骨架，请先重建时间轴");
      return;
    }
    goCreate({
      template: feature.value?.template,
      rate: feature.value?.speechRate ?? undefined,
      structure: structure.skeleton.map((s) => ({
        label: s.label,
        startTime: s.startTime,
        endTime: s.endTime,
        durationShare: s.durationShare,
      })),
      structureSourceContentId: contentId.value,
    });
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  }
}

async function loadAll(): Promise<void> {
  loading.value = true;
  loadError.value = "";
  const id = contentId.value;
  const [f, m, b, t] = await Promise.allSettled([
    getAnalyticsFeature(id),
    getAnalyticsVideoMetrics(id),
    getAnalyticsBenchmark(id),
    getAnalyticsTrend(id),
  ]);
  // 特征 404 属正常（该内容还没发布记录）；其余分块失败单独提示不打断整页
  feature.value = f.status === "fulfilled" ? f.value : null;
  if (m.status === "fulfilled") {
    metrics.value = m.value.records.flatMap((r) => r.latest);
    metricsEmptyReason.value = m.value.emptyReason;
    publishMeta.value = m.value.records.map((r) => ({
      platform: r.platform,
      platformVideoId: r.platformVideoId,
      publishTime: r.publishTime,
    }));
  } else {
    metrics.value = [];
    metricsEmptyReason.value = "not_published";
  }
  benchmark.value = b.status === "fulfilled" ? b.value : null;
  trends.value = t.status === "fulfilled" ? t.value : [];
  void loadTimeline();
  const failed = [f, m, b, t].filter((r) => r.status === "rejected").length;
  if (failed === 4) {
    loadError.value = m.status === "rejected" ? String(m.reason) : "分析数据加载失败";
  }
  loading.value = false;
}

/* ── 人工标签（scene/hook 生产未建模，USER_INPUT 补齐后进入同类分组） ── */
const tagSaving = ref(false);

async function saveTag(patch: { scene?: string | null; hook?: string | null }): Promise<void> {
  if (!contentId.value) return;
  tagSaving.value = true;
  try {
    feature.value = await patchAnalyticsFeature(contentId.value, patch);
    toast.success("标签已保存（来源：手动录入）");
    void loadAll();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  } finally {
    tagSaving.value = false;
  }
}

function onTagSelect(field: "scene" | "hook", event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  void saveTag({ [field]: value === "" ? null : value });
}

/* ── 趋势图 ── */
const trendMetric = ref("play_count");
const trendSeries = computed(() => {
  const all = trends.value.flatMap((r) =>
    r.series
      .filter((s) => s.metricName === trendMetric.value)
      .map((s) => ({ ...s, platform: r.platform })),
  );
  return all;
});
const trendMetricOptions = computed(() => {
  const names = new Set<string>();
  for (const r of trends.value) for (const s of r.series) names.add(s.metricName);
  return [...names];
});
const trendCharts = computed(() =>
  trendSeries.value.map((s) => ({
    platform: s.platform,
    geo: trendGeometry(s.points.map((p) => ({ date: p.date, value: p.value }))),
    count: s.points.length,
    source: s.points[0]?.sourceType ?? "",
  })),
);

const BENCH_LABEL: Record<string, string> = {
  play_count: "播放量",
  effective_play_rate_2s: "2秒有效播放率",
  watch_rate_5s: "5秒观看率",
  completion_rate: "完播率",
  avg_watch_ratio: "平均观看比例",
  like_rate: "点赞率",
  engagement_rate: "互动率",
};

const FEATURE_ROWS: { key: keyof AnalyticsFeature; label: string; kind?: "sec" | "num" }[] = [
  { key: "template", label: "模板" },
  { key: "level", label: "词汇等级" },
  { key: "duration", label: "成片时长", kind: "sec" },
  { key: "knowledgePointCount", label: "知识点数", kind: "num" },
  { key: "segmentCount", label: "段落数", kind: "num" },
  { key: "dialogueCount", label: "台词块数", kind: "num" },
  { key: "shotCount", label: "镜头数", kind: "num" },
  { key: "speechRate", label: "语速倍率", kind: "num" },
  { key: "voiceId", label: "音色" },
  { key: "bgm", label: "背景音乐" },
  { key: "introEffect", label: "Three.js 片头" },
  { key: "promptVersion", label: "Prompt 版本" },
  { key: "rendererVersion", label: "渲染器版本" },
];

function featureValue(row: (typeof FEATURE_ROWS)[number]): string {
  const v = feature.value?.[row.key];
  if (v === null || v === undefined || v === "") return "暂无数据";
  if (row.kind === "sec") return `${Number(v).toFixed(1)}s`;
  if (row.kind === "num") return String(v);
  if (row.key === "introEffect") return Number(v) === 1 ? "已启用" : "未启用";
  return String(v);
}

function featureSource(key: keyof AnalyticsFeature): string {
  return sourceLabel(feature.value?.fieldSources?.[key] ?? "PLATFORM_PRODUCTION");
}

function metricValueText(view: VideoMetricView | undefined): string {
  if (!view) return "暂无数据";
  if (view.unit === "rate") return `${(view.metricValue * 100).toFixed(1)}%`;
  if (view.unit === "seconds") return `${view.metricValue.toFixed(1)}s`;
  return Math.round(view.metricValue).toLocaleString("zh-CN");
}

onMounted(loadAll);
</script>

<template>
  <main class="px-7 pt-[26px] pb-12">
    <section class="mb-[22px] flex items-end justify-between gap-5">
      <div class="min-w-0">
        <button class="mb-1 cursor-pointer text-xs text-subtle hover:text-ink" @click="router.back()">
          ← 返回
        </button>
        <h1 class="mb-1.5 truncate text-[26px] font-bold">单视频分析</h1>
        <p class="text-subtle">生产参数（左）× 发布表现（右）同屏对照；每项数据标注来源。</p>
      </div>
      <button
        class="shrink-0 cursor-pointer rounded-[10px] border border-hairline bg-white px-3.5 py-[9px] text-sm hover:bg-gray-50"
        @click="loadAll"
      >
        刷新
      </button>
    </section>

    <div
      v-if="loadError"
      role="alert"
      class="mb-4 flex items-center justify-between gap-3 rounded-xl bg-red-50 p-3 text-sm text-red-600"
    >
      <span>{{ loadError }}</span>
      <button class="cursor-pointer rounded border border-red-300 px-2 py-1 text-xs hover:bg-red-100" @click="loadAll">
        重试
      </button>
    </div>

    <p v-if="loading" class="flex items-center gap-2 p-8 text-sm text-subtle">
      <Spinner size="sm" /> 加载分析数据…
    </p>

    <div v-else class="grid grid-cols-[380px_1fr] gap-[18px] max-xl:grid-cols-1">
      <!-- 左：生产参数 -->
      <div class="space-y-4">
        <section class="rounded-2xl border border-hairline bg-panel p-4">
          <h2 class="mb-2 font-bold">生产参数</h2>
          <p v-if="!feature" class="text-xs text-subtle">该内容尚无特征记录（创建发布记录后自动落库）。</p>
          <dl v-else class="space-y-1.5 text-[13px]">
            <div v-for="row in FEATURE_ROWS" :key="String(row.key)" class="flex items-baseline justify-between gap-3">
              <dt class="shrink-0 text-subtle">{{ row.label }}</dt>
              <dd class="min-w-0 truncate text-right font-medium">
                {{ featureValue(row) }}
                <span v-if="featureValue(row) === '暂无数据'" class="ml-1 text-[10px] font-normal">[生产未留痕]</span>
                <span v-else class="ml-1 text-[10px] font-normal text-subtle">[{{ featureSource(row.key) }}]</span>
              </dd>
            </div>
          </dl>
        </section>

        <section class="rounded-2xl border border-hairline bg-panel p-4">
          <h2 class="mb-1 font-bold">内容标签</h2>
          <p class="mb-2 text-xs text-subtle">生产阶段未建模的维度，手动标注后进入同类 Benchmark 分组</p>
          <div class="grid grid-cols-2 gap-2">
            <label class="text-[13px] text-subtle">
              场景
              <select
                class="mt-1 w-full cursor-pointer rounded-[10px] border border-hairline bg-white px-2 py-2 text-sm text-ink focus:border-brand focus:outline-none disabled:opacity-50"
                :disabled="tagSaving"
                :value="feature?.scene ?? ''"
                @change="onTagSelect('scene', $event)"
              >
                <option value="">未标注</option>
                <option v-for="o in SCENE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
            </label>
            <label class="text-[13px] text-subtle">
              Hook
              <select
                class="mt-1 w-full cursor-pointer rounded-[10px] border border-hairline bg-white px-2 py-2 text-sm text-ink focus:border-brand focus:outline-none disabled:opacity-50"
                :disabled="tagSaving"
                :value="feature?.hook ?? ''"
                @change="onTagSelect('hook', $event)"
              >
                <option value="">未标注</option>
                <option v-for="o in HOOK_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
            </label>
          </div>
        </section>

        <section v-if="publishMeta.length > 0" class="rounded-2xl border border-hairline bg-panel p-4">
          <h2 class="mb-2 font-bold">发布信息</h2>
          <div v-for="p in publishMeta" :key="`${p.platform}-${p.platformVideoId ?? 'na'}`" class="mb-1.5 flex items-baseline justify-between gap-3 text-[13px]">
            <span class="text-subtle">{{ p.platform }}</span>
            <span class="font-medium tabular-nums">
              {{ p.platformVideoId ? `#${p.platformVideoId}` : "未绑定作品 ID" }}
              <span v-if="p.publishTime" class="ml-2 text-xs text-subtle">{{ p.publishTime.slice(0, 10) }}</span>
            </span>
          </div>
        </section>
      </div>

      <!-- 右：表现 / 趋势 / 同类基准 -->
      <div class="min-w-0 space-y-4">
        <section class="rounded-2xl border border-hairline bg-panel p-4">
          <h2 class="mb-2 font-bold">发布表现</h2>
          <p
            v-if="metricsEmptyReason"
            class="rounded-lg border border-[#f8df9c] bg-[#fff8e8] px-3 py-2 text-xs"
          >
            暂无数据：{{ emptyReasonLabel(metricsEmptyReason) || "创作者尚未导入" }}。
          </p>
          <div v-else class="grid grid-cols-3 gap-2 max-lg:grid-cols-2">
            <div
              v-for="name in ['play_count', 'effective_play_rate_2s', 'completion_rate', 'avg_watch_time', 'like_rate', 'profile_visit_count', 'engagement_rate', 'new_fan_count', 'watch_rate_5s']"
              :key="name"
              class="rounded-xl border border-hairline bg-white p-3"
            >
              <p class="text-xs text-subtle">
                {{ metricByName.get(name)?.label ?? METRIC_FALLBACK_LABEL[name] ?? name }}
                <span v-if="metricByName.get(name)?.isEstimated" class="text-amber-600" title="估算/时间窗口归因">≈</span>
              </p>
              <p class="mt-1 text-[19px] leading-none font-extrabold tabular-nums">{{ metricValueText(metricByName.get(name)) }}</p>
              <p class="mt-1 text-[10px] text-subtle">
                <template v-if="metricByName.get(name)">
                  [{{ sourceLabel(metricByName.get(name)?.sourceType) }}]
                  <span v-if="metricByName.get(name)?.dataDate">· {{ metricByName.get(name)?.dataDate }}</span>
                </template>
                <template v-else>未导入</template>
              </p>
            </div>
          </div>
        </section>

        <section class="rounded-2xl border border-hairline bg-panel p-4">
          <div class="mb-2 flex items-center justify-between gap-3">
            <h2 class="font-bold">每日快照趋势</h2>
            <select
              v-if="trendMetricOptions.length > 0"
              v-model="trendMetric"
              class="cursor-pointer rounded-[10px] border border-hairline bg-white px-2 py-1.5 text-xs focus:border-brand focus:outline-none"
            >
              <option v-for="name in trendMetricOptions" :key="name" :value="name">
                {{ metricByName.get(name)?.label ?? name }}
              </option>
            </select>
          </div>
          <p v-if="trendCharts.length === 0" class="text-xs text-subtle">
            暂无每日快照（创作者尚未按日导入；缺日不补 0、不画假点）。
          </p>
          <div v-for="chart in trendCharts" :key="chart.platform" class="mb-3">
            <p class="mb-1 text-xs text-subtle">
              {{ chart.platform }} · {{ chart.count }} 个快照日 · [{{ sourceLabel(chart.source) }}]
            </p>
            <svg :viewBox="`0 0 560 160`" class="h-[160px] w-full rounded-lg border border-hairline bg-white">
              <polyline :points="chart.geo.line" fill="none" stroke="var(--color-brand, #6d5dfc)" stroke-width="2" />
              <circle
                v-for="d in chart.geo.dots"
                :key="d.date"
                :cx="d.cx"
                :cy="d.cy"
                r="3.5"
                fill="var(--color-brand, #6d5dfc)"
              >
                <title>{{ d.date }} · {{ d.value }}</title>
              </circle>
            </svg>
          </div>
        </section>

        <section class="rounded-2xl border border-hairline bg-panel p-4">
          <h2 class="mb-1 font-bold">同类 Benchmark（账号自身分组）</h2>
          <p v-if="!benchmark || benchmark.emptyReason" class="text-xs text-subtle">
            {{ emptyReasonLabel(benchmark?.emptyReason ?? "no_publish_record") || "暂无同类样本" }}
          </p>
          <template v-else>
            <p class="mb-2 text-xs text-subtle">
              分组：{{ benchmark.subject.group.template }}
              <template v-if="benchmark.subject.group.durationBand"> · 时长带 {{ benchmark.subject.group.durationBand }}s</template>
              <template v-if="benchmark.subject.group.scene"> · 场景 {{ benchmark.subject.group.scene }}</template>
              <template v-if="benchmark.subject.group.contentFormat"> · 形态 {{ benchmark.subject.group.contentFormat }}</template>
              · 组内样本 <b :class="benchmark.lowSample ? 'text-amber-600' : 'text-ink'">{{ benchmark.sampleCount }}</b> 条
            </p>
            <p
              v-if="benchmark.lowSample"
              class="mb-2 rounded-lg border border-[#f8df9c] bg-[#fff8e8] px-3 py-2 text-xs"
            >
              样本不足（&lt;8 条）：以下对比仅供参考，不构成结论依据（需求 §十一 页面 D 同源纪律）。
            </p>
            <table class="w-full border-collapse text-left text-[13px]">
              <thead class="text-xs text-subtle">
                <tr>
                  <th class="border-b border-hairline py-1.5 pr-2 font-semibold">指标</th>
                  <th class="border-b border-hairline py-1.5 pr-2 text-right font-semibold">本条</th>
                  <th class="border-b border-hairline py-1.5 pr-2 text-right font-semibold">组中位</th>
                  <th class="border-b border-hairline py-1.5 pr-2 text-right font-semibold">组均值</th>
                  <th class="border-b border-hairline py-1.5 text-right font-semibold">差值</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(entry, name) in benchmark.metrics" :key="name">
                  <td class="border-b border-hairline py-1.5 pr-2">{{ BENCH_LABEL[name] ?? name }}</td>
                  <td class="border-b border-hairline py-1.5 pr-2 text-right tabular-nums">
                    <template v-if="entry.self">
                      {{ entry.self.value.toFixed(entry.self.value < 2 ? 3 : 0) }}
                      <span v-if="entry.self.isEstimated" class="text-amber-600" title="估算">≈</span>
                    </template>
                    <span v-else class="text-subtle">暂无</span>
                  </td>
                  <td class="border-b border-hairline py-1.5 pr-2 text-right tabular-nums text-subtle">
                    {{ entry.groupMedian === null ? "—" : entry.groupMedian.toFixed(entry.groupMedian < 2 ? 3 : 0) }}
                  </td>
                  <td class="border-b border-hairline py-1.5 pr-2 text-right tabular-nums text-subtle">
                    {{ entry.groupMean === null ? "—" : entry.groupMean.toFixed(entry.groupMean < 2 ? 3 : 0) }}
                  </td>
                  <td class="border-b border-hairline py-1.5 text-right tabular-nums" :class="(entry.diff ?? 0) >= 0 ? 'text-ok' : 'text-bad'">
                    {{ formatDiff(entry.diff, /rate|ratio/.test(name) ? "rate" : "count") }}
                    <span class="ml-1 text-[10px] text-subtle">n={{ entry.sampleCount }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </template>
        </section>

        <section class="rounded-2xl border border-hairline bg-panel p-4">
          <div class="mb-2 flex items-center justify-between gap-3">
            <h2 class="font-bold">内容时间轴（生产口径派生）</h2>
            <div class="flex items-center gap-2">
              <button
                v-if="timeline.length > 0"
                class="cursor-pointer rounded-[10px] border border-brand bg-brand px-3 py-1.5 text-xs text-white hover:opacity-90"
                title="提取结构序列与时长占比，携预填进入新建流程（§十七）"
                @click="reuseStructure"
              >
                复用此视频结构
              </button>
              <button
                v-if="timelineEmptyReason === 'not_derived'"
                class="cursor-pointer rounded-[10px] border border-brand bg-brand px-3 py-1.5 text-xs text-white disabled:opacity-50"
                :disabled="timelineSyncing"
                @click="syncTimeline"
              >
                {{ timelineSyncing ? "重建中…" : "按生产数据重建" }}
              </button>
            </div>
          </div>
          <p v-if="timeline.length === 0" class="text-xs text-subtle">
            {{ emptyReasonLabel(timelineEmptyReason ?? "") || "尚未派生" }}：需已有成片/配音时长；段落时长按字符权重分配（非逐帧实测）。
          </p>
          <ol v-else class="space-y-1.5">
            <li v-for="seg in timeline" :key="seg.idx" class="flex items-baseline gap-3 text-[13px]">
              <span class="w-[92px] shrink-0 tabular-nums text-subtle">
                {{ seg.startTime.toFixed(1) }}~{{ seg.endTime.toFixed(1) }}s
              </span>
              <span class="w-[64px] shrink-0">
                <span class="rounded bg-gray-100 px-1.5 py-0.5 text-[10px]">{{ SEGMENT_TYPE_LABEL[seg.segmentType] ?? seg.segmentType }}</span>
              </span>
              <span class="min-w-0 flex-1 truncate" :title="seg.dialogue ?? ''">{{ seg.dialogue || "—" }}</span>
              <span v-if="seg.knowledgePoint" class="max-w-[160px] shrink-0 truncate text-xs text-brand" :title="seg.knowledgePoint">{{ seg.knowledgePoint }}</span>
            </li>
          </ol>
        </section>

        <section class="rounded-2xl border border-hairline bg-panel p-4 text-xs text-subtle leading-relaxed">
          <h2 class="mb-1 text-sm font-bold text-ink">秒级留存曲线为何不显示？</h2>
          平台数据通道（含创作者导出）均无逐秒留存数据（需求 §二十二：没有秒级留存不得绘制假曲线）。
          当前以 2秒/5秒/完播三个离散点位呈现留存；未来若获得真实逐秒数据，将在此区域展示衰减曲线。
          <span v-if="publishMeta.length === 0" class="mt-1 block text-amber-700">
            提示：尚未创建发布记录（页面右/左数据依赖 platform_video_id 绑定）。
          </span>
        </section>
      </div>
    </div>
  </main>
</template>
