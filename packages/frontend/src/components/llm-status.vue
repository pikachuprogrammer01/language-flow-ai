<script setup lang="ts">
import { CircleCheck, Power } from "lucide-vue-next";
/**
 * LLM 引擎状态位（顶栏）— SSE 事件流驱动（替代全部定时轮询），带显式过渡态
 * · starting「启动中…」/ stopping「关闭中…」：紫点脉冲 + tooltip 实时进度文案；
 * · idle 按就绪度着色：绿就绪 / 黄待机（已装未加载）/ 红不可达、安装缺失或操作失败 / 灰未收到状态；
 * · 失败(error)红 toast / 降级(notice)黄 toast / 成功绿 toast，结果由服务端推流即时可见；
 * · 不支持 EventSource 的环境才回退 30s 低频探测兼容。
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { toast } from "../lib/toast";
import Spinner from "./ui/spinner.vue";

interface LlmStatus {
  connected: boolean;
  model: string;
  installed?: boolean;
  loaded?: boolean;
  reason?: string;
}
/** 与后端 services/llm-engine.ts EngineSnapshot 对齐的事件负载 */
interface EngineSnapshot {
  phase: "idle" | "starting" | "stopping";
  progress?: string;
  status: LlmStatus;
  error?: string;
  notice?: string;
}

/** 就绪度分级（仅 idle 时用于着色/文案） */
type LlmLevel = "ready" | "standby" | "down" | "unknown";

const apiBase = (import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080").replace(/\/$/, "");
const snap = ref<EngineSnapshot | null>(null);
const sleepArmed = ref(false);
/** 本地乐观 loading：覆盖「点击 → SSE 首个过渡态到达」的空窗，避免按钮无反馈 */
const wakePending = ref(false);
const stopPending = ref(false);
let events: EventSource | undefined;
let fallbackTimer: ReturnType<typeof setInterval> | undefined;
let sleepArmTimer: ReturnType<typeof setTimeout> | undefined;

/** 单次探测（手动刷新/无 SSE 回退用）：只采信 status，phase 以 SSE 推流为准 */
async function probeOnce(): Promise<void> {
  try {
    const res = await fetch(`${apiBase}/api/llm/status`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return;
    const status = (await res.json()) as LlmStatus;
    snap.value = snap.value ? { ...snap.value, status } : { phase: "idle", status };
  } catch {
    // 探测失败不清已有状态：事件流会校准
  }
}

/** 订阅引擎事件流；断线由 EventSource 自带退避重连，期间保留最后已知状态 */
function connectEvents(): void {
  if (typeof EventSource === "undefined") {
    void probeOnce();
    fallbackTimer = setInterval(() => void probeOnce(), 30_000);
    return;
  }
  events = new EventSource(`${apiBase}/api/llm/stream`);
  events.addEventListener("status", (raw: Event) => {
    snap.value = JSON.parse((raw as MessageEvent<string>).data) as EngineSnapshot;
  });
}

const status = computed(() => snap.value?.status ?? null);
const phase = computed(() => snap.value?.phase ?? "idle");
/** 启动/关闭进行中（含本地乐观态）：禁用重复操作入口，点击只播报进度 */
const waking = computed(() => wakePending.value || phase.value === "starting");
const stopping = computed(() => stopPending.value || phase.value === "stopping");
const busy = computed(() => waking.value || stopping.value);

const level = computed<LlmLevel>(() => {
  const s = status.value;
  if (!s) return "unknown";
  if (!s.connected || s.installed === false) return "down";
  return s.loaded === false ? "standby" : "ready";
});
const dotClass = computed(() => {
  if (busy.value) return "bg-run animate-pulse";
  return { ready: "bg-ok", standby: "bg-idle", down: "bg-bad", unknown: "bg-idle" }[level.value];
});
/** 主按钮配色：就绪绿/不可达红；待命是**正常可用态**（调用自动冷加载），用中性色不告警 */
const buttonClass = computed(() => {
  return level.value === "ready"
    ? "border-ok/40 bg-white text-emerald-700 hover:bg-emerald-50"
    : level.value === "down"
      ? "border-bad/40 bg-white text-bad hover:bg-red-50"
      : level.value === "standby"
        ? "border-hairline bg-white text-gray-600 hover:bg-gray-50"
        : "border-warn/40 bg-[#fff8e8] text-amber-700 hover:bg-[#fdefc8]";
});
const label = computed(() => {
  const name = status.value?.model || "模型";
  if (waking.value) return `启动 ${name} 中…`;
  if (level.value === "unknown") return "检测中…";
  if (level.value === "down" && snap.value?.error) return "启动失败 · 点击重试";
  // 双要素明示：Ollama 服务层 + 模型内存层；待命≠不可用（调用会自动冷加载）
  if (level.value === "ready") return "Ollama ✓ · 模型已加载";
  if (level.value === "standby") return "Ollama ✓ · 待命中（可正常生成）";
  return "Ollama 未启动 · 点击启动";
});
const tip = computed(() => {
  if (busy.value) return snap.value?.progress ?? "处理中…";
  const s = status.value;
  if (!s) return "尚未收到后端引擎状态（事件流未连接）";
  const name = s.model || "未配置";
  if (snap.value?.error) return `${snap.value.error}｜当前：${name} ${s.reason ?? ""}`.trim();
  if (level.value === "ready")
    return `Ollama 服务运行中，模型 ${name} 已加载进内存（就绪）；点击可刷新状态，如需释放内存用右侧卸载按钮`;
  if (level.value === "standby")
    return `服务在线，模型 ${name} 未常驻内存——生成请求会自动冷加载（首次稍慢）；点击可预加载（保活 1h）`;
  return `Ollama 服务未运行：${s.reason ?? "不可达"}，点击启动服务并加载 ${name}`;
});

/** 主按钮：过渡态只播报进度；就绪=手动刷新；未就绪=一键启动（后续全由 SSE 推流转态） */
async function onActivate(): Promise<void> {
  if (busy.value) {
    if (snap.value?.progress) toast.info(snap.value.progress);
    return;
  }
  if (level.value === "ready" || level.value === "unknown") {
    await probeOnce();
    return;
  }
  wakePending.value = true;
  try {
    const res = await fetch(`${apiBase}/api/llm/wake`, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const s = (await res.json()) as LlmStatus;
    // 响应仅作兜底：SSE 已开始推过渡态时以推流为准
    if (snap.value && snap.value.phase === "idle") snap.value = { ...snap.value, status: s };
    if (s.connected && s.loaded !== false) toast.success(`启动成功：模型 ${s.model} 已就绪`);
  } catch (err) {
    toast.error(`启动请求失败：${err instanceof Error ? err.message : String(err)}`, {
      duration: 8000,
    });
  } finally {
    wakePending.value = false;
  }
}

/* ── 操作结果实时播报：转换事件（过渡态→idle）必定播报一次，不受文案去重吞掉；
   非转换事件（reconnect 回放/对账）才按文案去重防重复弹 ── */
let lastEvent = { phase: "", error: "", notice: "" };
watch(snap, (s) => {
  if (!s) return;
  const leaving = lastEvent.phase === "starting" || lastEvent.phase === "stopping";
  if (lastEvent.phase === "starting" && s.phase === "idle") {
    if (s.error) toast.error(s.error, { duration: 8000 });
    else if (s.status.loaded === true) toast.success(`模型 ${s.status.model} 已就绪`);
  } else if (lastEvent.phase === "stopping" && s.phase === "idle") {
    if (s.error) toast.error(s.error, { duration: 8000 });
    else if (!s.status.connected)
      // 服务真停了（宿主机回环环境 brew 生效）
      toast.success("Ollama 已停止");
    // 容器环境能力边界：卸载模型即本按钮全部职责，成功播报 + 宿主退出指引
    else
      toast.success(`模型 ${s.status.model} 已卸载`, {
        description: "Ollama 服务由宿主机运行，容器无法代停；彻底退出请在宿主机 Quit Ollama",
        duration: 6000,
      });
  } else if (s.error && s.error !== lastEvent.error) toast.error(s.error, { duration: 8000 });
  else if (s.notice && (leaving || s.notice !== lastEvent.notice))
    toast.warning(s.notice, { duration: 6000 });
  lastEvent = { phase: s.phase, error: s.error ?? "", notice: s.notice ?? "" };
});

onMounted(connectEvents);
onUnmounted(() => {
  events?.close();
  clearInterval(fallbackTimer);
  clearTimeout(sleepArmTimer);
});

/* ── 一键卸载（wake 的反向操作）：释放模型内存；过渡态/结果全由 SSE 播报 ── */
/** 只在真有可停之物（已加载）或卸载进行中露出；待命态无内存占用，不显示按钮防点了没反应 */
const sleepVisible = computed(() => !waking.value && (stopping.value || level.value === "ready"));
const sleepLabel = computed(() => {
  if (stopping.value) return "卸载中…";
  return sleepArmed.value ? "确认卸载？" : "卸载模型";
});
const sleepTip = computed(() => {
  const name = status.value?.model || "模型";
  if (stopping.value) return snap.value?.progress ?? "正在卸载…";
  return sleepArmed.value
    ? "再点一次执行；3s 无操作自动取消"
    : `从内存卸载 ${name} 释放资源；Ollama 服务跑在宿主机，容器无法代停（需彻底退出请在宿主机 Quit Ollama）`;
});

/** 两段式确认：首点击武装，3s 内再击才真关（防误触打断其他会话的生成） */
function onSleepClick(): void {
  if (!sleepArmed.value) {
    sleepArmed.value = true;
    clearTimeout(sleepArmTimer);
    sleepArmTimer = setTimeout(() => {
      sleepArmed.value = false;
    }, 3000);
    return;
  }
  clearTimeout(sleepArmTimer);
  sleepArmed.value = false;
  void sleepNow();
}

async function sleepNow(): Promise<void> {
  stopPending.value = true;
  try {
    const res = await fetch(`${apiBase}/api/llm/sleep`, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const s = (await res.json()) as LlmStatus;
    // 响应仅作兜底：SSE 已在推 stopping 过渡态时以推流为准
    if (snap.value && snap.value.phase === "idle") snap.value = { ...snap.value, status: s };
  } catch (err) {
    toast.error(`停止请求失败：${err instanceof Error ? err.message : String(err)}`, {
      duration: 8000,
    });
  } finally {
    stopPending.value = false;
  }
}
</script>

<template>
  <div class="flex items-center gap-1.5">
    <button
      class="flex cursor-pointer items-center gap-1.5 rounded-[10px] border px-3.5 py-[9px] text-sm transition-colors"
      :class="buttonClass"
      :title="tip"
      @click="onActivate"
    >
      <Spinner v-if="waking" size="sm" />
      <CircleCheck v-else-if="!busy && level === 'ready'" class="h-4 w-4 shrink-0" />
      <i v-else class="h-2 w-2 rounded-full" :class="dotClass" />
      {{ label }}
    </button>
    <button
      v-if="sleepVisible"
      class="flex cursor-pointer items-center gap-1 rounded-[10px] border px-2.5 py-[9px] text-sm transition-colors disabled:cursor-not-allowed"
      :class="
        stopping
          ? 'border-hairline bg-white text-subtle'
          : sleepArmed
            ? 'border-bad/50 bg-red-50 text-bad'
            : 'border-hairline bg-white text-bad hover:bg-red-50'
      "
      :disabled="stopping"
      :title="sleepTip"
      @click="onSleepClick"
    >
      <Spinner v-if="stopping" size="sm" />
      <Power v-else class="h-3.5 w-3.5 shrink-0" />
      {{ sleepLabel }}
    </button>
  </div>
</template>
