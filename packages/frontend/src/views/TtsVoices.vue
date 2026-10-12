<script setup lang="ts">
/**
 * 配音音色管理页（docs/24）— 不写代码就能上下架音色、并用实测结论判断该不该上架
 * 数据：GET /api/tts/voices（voices=当前环境可选，all=全量目录含下架与实测状态）
 *      PATCH /api/tts/voices/{id}、POST /api/tts/voices/{id}/probe
 */
import { computed, onMounted, ref } from "vue";
import { type ManagedVoice, listVoices, probeVoice, setVoiceEnabled } from "../api/client";
import DataTable from "../components/ui/data-table.vue";
import type { DataTableColumn } from "../lib/data-table";
import { toast } from "../lib/toast";

const loading = ref(true);
const errorMsg = ref("");
const voices = ref<ManagedVoice[]>([]);
/** 当前环境真正可选的音色 id（用于区分「被下架」和「本环境用不了」） */
const selectableIds = ref<string[]>([]);
/** 正在实测 / 正在改状态的行 id：按钮禁用并就地显示进度，避免重复点 */
const probing = ref<string>("");
const switching = ref<string>("");

const COLUMNS: DataTableColumn[] = [
  { key: "voice", label: "音色", cellClass: "min-w-[200px]" },
  { key: "engine", label: "引擎" },
  { key: "status", label: "状态" },
  { key: "check", label: "最近实测", cellClass: "min-w-[240px]" },
  { key: "actions", label: "操作", cellClass: "text-right" },
];

const CHECK_LABEL: Record<string, string> = {
  error: "失败",
  handshake_failed: "连接失败",
  no_audio: "端点不提供该音色",
  ok: "可出音频",
  rate_limited: "被限流",
};

function checkTone(status: string | null): string {
  if (status === "ok") return "text-green-600";
  if (status === "rate_limited") return "text-amber-600";
  if (status === null) return "text-gray-400";
  return "text-red-600";
}

/** 下架 ≠ 本环境不可用：本地音色在容器里永远选不了，说清楚免得白折腾上下架 */
function unavailableReason(v: ManagedVoice): string {
  if (selectableIds.value.includes(v.id)) return "";
  if (!v.enabled) return "已下架";
  return v.engine === "local" ? "本环境无本地语音引擎（容器内没有 say）" : "本环境不可用";
}

function checkedText(v: ManagedVoice): string {
  if (!v.checkedAt) return "从未实测";
  const at = new Date(v.checkedAt).toLocaleString("zh-CN", { hour12: false });
  return `${at} · ${CHECK_LABEL[v.checkStatus ?? ""] ?? v.checkStatus ?? "未知"}`;
}

const rows = computed(() => voices.value);

async function load(): Promise<void> {
  loading.value = true;
  errorMsg.value = "";
  try {
    const data = await listVoices();
    selectableIds.value = data.voices.map((v) => v.id);
    voices.value = (data.all ?? []) as ManagedVoice[];
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function onProbe(v: ManagedVoice): Promise<void> {
  probing.value = v.id;
  errorMsg.value = "";
  try {
    const r = await probeVoice(v.id);
    await load();
    if (r.status === "ok") toast.success(`${v.name}：${r.detail}`);
    else toast.error(`${v.name} 实测不通过：${r.detail}`);
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    probing.value = "";
  }
}

async function onToggle(v: ManagedVoice): Promise<void> {
  switching.value = v.id;
  errorMsg.value = "";
  try {
    await setVoiceEnabled(v.id, !v.enabled);
    await load();
    toast.success(v.enabled ? `${v.name} 已下架（新任务不再可选）` : `${v.name} 已上架`);
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    switching.value = "";
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="px-7 pt-[26px] pb-12">
    <section class="mb-[22px]">
      <h1 class="mb-1.5 text-[26px] font-bold">配音音色</h1>
      <p class="text-subtle">
        上下架只影响之后的配音，已生成的内容不受影响。拿不准某个音色能不能用就先「测一次」，
        结论会记在表里。
      </p>
    </section>

    <p v-if="errorMsg" class="mb-3.5 rounded-xl bg-red-50 p-3 text-sm text-red-600">
      {{ errorMsg }}
    </p>
    <p v-if="loading && voices.length === 0" class="mt-6 text-center text-sm text-gray-400">
      加载中…
    </p>

    <DataTable
      v-else
      :columns="COLUMNS"
      :rows="rows"
      :row-key="(v: ManagedVoice) => v.id"
      :page="1"
      :page-size="50"
    >
      <template #cell-voice="{ row }">
        <p class="font-medium" :class="row.enabled ? '' : 'text-gray-400'">{{ row.name }}</p>
        <p class="break-all font-mono text-[11px] text-gray-400">{{ row.id }}</p>
      </template>
      <template #cell-engine="{ row }">
        <span class="text-xs">{{ row.engine === "local" ? "本地语音" : "微软 Edge" }}</span>
      </template>
      <template #cell-status="{ row }">
        <span
          class="rounded-full px-2 py-0.5 text-xs"
          :class="
            selectableIds.includes(row.id)
              ? 'bg-green-50 text-green-700'
              : 'bg-gray-100 text-gray-500'
          "
        >
          {{ selectableIds.includes(row.id) ? "可选" : unavailableReason(row) }}
        </span>
      </template>
      <template #cell-check="{ row }">
        <p class="text-xs" :class="checkTone(row.checkStatus)">{{ checkedText(row) }}</p>
        <p v-if="row.checkDetail" class="mt-0.5 break-all text-[11px] text-gray-400">
          {{ row.checkDetail }}
        </p>
      </template>
      <template #cell-actions="{ row }">
        <div class="flex justify-end gap-2">
          <button
            class="cursor-pointer rounded-[10px] border border-hairline bg-white px-3 py-[7px] text-xs text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            :disabled="probing === row.id"
            @click="onProbe(row)"
          >
            {{ probing === row.id ? "实测中…" : "测一次" }}
          </button>
          <button
            class="cursor-pointer rounded-[10px] border px-3 py-[7px] text-xs transition disabled:cursor-not-allowed disabled:opacity-50"
            :class="
              row.enabled
                ? 'border-red-200 bg-white text-red-600 hover:bg-red-50'
                : 'border-brand bg-brand text-white hover:opacity-90'
            "
            :disabled="switching === row.id"
            @click="onToggle(row)"
          >
            {{ switching === row.id ? "处理中…" : row.enabled ? "下架" : "上架" }}
          </button>
        </div>
      </template>
    </DataTable>
  </div>
</template>
