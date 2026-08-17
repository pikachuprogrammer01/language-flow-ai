<script setup lang="ts">
/**
 * 文件管理页 — 分类管理（视频=成片 / 配音=生成的音频 / BGM=背景音乐素材）
 * 数据源：GET /api/files（分类 + inUse 标记）+ DELETE /api/files/:filename?type=
 */
import { computed, onMounted, ref } from "vue";
import { batchDeleteFiles, deleteFile, listFiles } from "../api/client";

const base = (import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080").replace(/\/$/, "");
const files = ref<
  {
    filename: string;
    type: "audio" | "video" | "bgm";
    size: number;
    mtime: string;
    inUse: boolean;
  }[]
>([]);
const filter = ref<"all" | "video" | "audio" | "bgm">("all");
const loading = ref(true);
const errorMsg = ref("");
/** 批量选择（key = type/filename） */
const selected = ref<Set<string>>(new Set());

const TYPE_LABEL: Record<string, string> = {
  video: "视频（成片）",
  audio: "音频（配音）",
  bgm: "BGM（背景音乐）",
};

const filtered = computed(() =>
  filter.value === "all" ? files.value : files.value.filter((f) => f.type === filter.value),
);

const totalSize = computed(() => files.value.reduce((n, f) => n + f.size, 0));

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function load(): Promise<void> {
  loading.value = true;
  errorMsg.value = "";
  try {
    const data = await listFiles();
    files.value = data.files;
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function remove(f: {
  filename: string;
  type: "audio" | "video" | "bgm";
  inUse: boolean;
}): Promise<void> {
  const tip = f.inUse
    ? "该文件被生成记录引用，删除后记录中的视频/音频将无法播放，确定删除？"
    : "确定删除该文件？";
  if (!window.confirm(tip)) return;
  try {
    await deleteFile(f.filename, f.type);
    await load();
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  }
}

function keyOf(f: { filename: string; type: string }): string {
  return `${f.type}/${f.filename}`;
}

const allFilteredSelected = computed<boolean>({
  get: () => filtered.value.length > 0 && filtered.value.every((f) => selected.value.has(keyOf(f))),
  set: (checked: boolean) => {
    // 全选 = 当前 Tab 可见的全部；取消 = 仅移除当前 Tab 的（跨 Tab 残留选中保留）
    const next = new Set(selected.value);
    for (const f of filtered.value) {
      if (checked) next.add(keyOf(f));
      else next.delete(keyOf(f));
    }
    selected.value = next;
  },
});

function switchFilter(next: "all" | "video" | "audio" | "bgm"): void {
  // 切换分类时清空选中：全选语义 = 当前 Tab 可见文件，避免跨 Tab 残留导致误删
  filter.value = next;
  selected.value = new Set();
}

function toggle(f: { filename: string; type: "audio" | "video" | "bgm" }): void {
  const k = keyOf(f);
  const next = new Set(selected.value);
  if (next.has(k)) next.delete(k);
  else next.add(k);
  selected.value = next;
}

async function batchRemove(): Promise<void> {
  if (selected.value.size === 0) return;
  const hasReferenced = [...selected.value]
    .map((k) => files.value.find((f) => keyOf(f) === k))
    .some((f) => f?.inUse);
  // 按分类统计，让用户看清删除范围（selected 可能跨分类）
  const byType = { video: 0, audio: 0, bgm: 0 };
  for (const k of selected.value) {
    const [type] = k.split("/");
    if (type === "video" || type === "audio" || type === "bgm") byType[type] += 1;
  }
  const scope = `视频 ${byType.video} 个、配音 ${byType.audio} 个、BGM ${byType.bgm} 个`;
  const tip = hasReferenced
    ? `选中的 ${selected.value.size} 个文件（${scope}）中包含被记录引用的文件，删除后对应记录中的视频/音频将无法播放，确定删除？`
    : `确定删除选中的 ${selected.value.size} 个文件（${scope}）？`;
  if (!window.confirm(tip)) return;
  try {
    const items = [...selected.value].map((k) => {
      const [type, filename] = k.split("/");
      return { type, filename } as { type: "audio" | "video" | "bgm"; filename: string };
    });
    const result = await batchDeleteFiles(items);
    selected.value = new Set();
    await load();
    if (result.errors.length > 0) {
      errorMsg.value = `已删除 ${result.deleted} 个；${result.errors.length} 个失败（${result.errors.map((e) => e.filename).join("、")}）`;
    }
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  }
}

onMounted(load);
</script>

<template>
  <div class="mx-auto max-w-4xl px-6 py-10">
    <div class="mb-6 flex items-center justify-between">
      <h1 class="text-2xl font-bold">文件管理</h1>
      <button class="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-100" @click="load">刷新</button>
    </div>

    <p v-if="errorMsg" class="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-600">{{ errorMsg }}</p>
    <p v-if="loading" class="py-8 text-center text-gray-500">加载中…</p>

    <template v-else>
      <p class="mb-4 text-sm text-gray-500">
        共 {{ files.length }} 个文件，合计 {{ fmtSize(totalSize) }}；「未引用」= 未被任何生成记录使用，可安全清理
      </p>

      <!-- 分类 Tab：视频 / 配音 / BGM 分开管理 -->
      <div class="mb-4 flex flex-wrap items-center gap-2">
        <button
          v-for="f in (['all', 'video', 'audio', 'bgm'] as const)"
          :key="f"
          class="rounded-lg border px-3 py-1.5 text-sm"
          :class="filter === f ? 'bg-blue-600 text-white' : 'hover:bg-gray-100'"
          @click="switchFilter(f)"
        >
          {{ f === "all" ? `全部（${files.length}）` : `${TYPE_LABEL[f]}（${files.filter((x) => x.type === f).length}）` }}
        </button>
        <span class="ml-auto flex items-center gap-2">
          <label v-if="filtered.length > 0" class="flex items-center gap-1 text-sm text-gray-600">
            <input type="checkbox" v-model="allFilteredSelected" />
            全选本页
          </label>
          <button
            class="rounded-lg border px-3 py-1.5 text-sm text-red-500 hover:bg-red-50 disabled:opacity-40"
            :disabled="selected.size === 0"
            @click="batchRemove"
          >
            批量删除（{{ selected.size }}）
          </button>
        </span>
      </div>

      <ul class="space-y-3">
        <li v-for="f in filtered" :key="`${f.type}-${f.filename}`" class="rounded-xl border p-4">
          <div class="flex items-center justify-between gap-4">
            <div class="flex min-w-0 flex-1 items-center gap-3">
              <input
                type="checkbox"
                :checked="selected.has(`${f.type}/${f.filename}`)"
                @change="toggle(f)"
              />
              <div class="min-w-0 flex-1">
                <div class="truncate font-mono text-xs text-gray-700">{{ f.filename }}</div>
                <div class="mt-1 flex items-center gap-3 text-xs text-gray-500">
                  <span class="rounded bg-gray-100 px-1.5 py-0.5">{{ TYPE_LABEL[f.type] }}</span>
                  <span>{{ fmtSize(f.size) }}</span>
                  <span>{{ new Date(f.mtime).toLocaleString("zh-CN") }}</span>
                  <span v-if="f.inUse" class="text-blue-600">被记录引用</span>
                  <span v-else class="text-orange-500">未引用</span>
                </div>
              </div>
            </div>
            <button
              class="shrink-0 rounded-lg border px-3 py-1.5 text-xs text-red-500 hover:bg-red-50"
              @click="remove(f)"
            >
              删除
            </button>
          </div>
          <video v-if="f.type === 'video'" :src="`${base}/files/video/${f.filename}`" controls class="mt-3 max-h-64 w-full rounded-lg" />
          <audio v-else :src="`${base}/files/${f.type}/${f.filename}`" controls class="mt-3 w-full" />
        </li>
      </ul>
      <p v-if="filtered.length === 0" class="py-10 text-center text-gray-400">没有匹配的文件</p>
    </template>
  </div>
</template>
