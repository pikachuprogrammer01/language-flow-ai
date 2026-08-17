<script setup lang="ts">
/**
 * 文件管理页 — uploads 下音频/视频文件（列表 / 预览 / 删除）
 * 数据源：GET /api/files（inUse 标记）+ DELETE /api/files/:filename
 */
import { computed, onMounted, ref } from "vue";
import { deleteFile, listFiles } from "../api/client";

const base = (import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080").replace(/\/$/, "");
const files = ref<
  { filename: string; type: "audio" | "video"; size: number; mtime: string; inUse: boolean }[]
>([]);
const filter = ref<"all" | "audio" | "video">("all");
const loading = ref(true);
const errorMsg = ref("");

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

async function remove(f: { filename: string; inUse: boolean }): Promise<void> {
  const tip = f.inUse
    ? "该文件被生成记录引用，删除后记录中的视频/音频将无法播放，确定删除？"
    : "确定删除该文件？";
  if (!window.confirm(tip)) return;
  try {
    await deleteFile(f.filename);
    await load();
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
      <div class="flex items-center gap-2">
        <button
          v-for="f in (['all', 'audio', 'video'] as const)"
          :key="f"
          class="rounded-lg border px-3 py-1.5 text-sm"
          :class="filter === f ? 'bg-blue-600 text-white' : 'hover:bg-gray-100'"
          @click="filter = f"
        >
          {{ f === "all" ? `全部（${files.length}）` : f === "audio" ? `音频` : `视频` }}
        </button>
        <button class="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-100" @click="load">刷新</button>
      </div>
    </div>

    <p v-if="errorMsg" class="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-600">{{ errorMsg }}</p>
    <p v-if="loading" class="py-8 text-center text-gray-500">加载中…</p>

    <template v-else>
      <p class="mb-4 text-sm text-gray-500">
        共 {{ files.length }} 个文件，合计 {{ fmtSize(totalSize) }}；「未引用」= 未被任何生成记录使用，可安全清理
      </p>

      <ul class="space-y-3">
        <li
          v-for="f in filtered"
          :key="f.filename"
          class="rounded-xl border p-4"
        >
          <div class="flex items-center justify-between gap-4">
            <div class="min-w-0">
              <div class="truncate font-mono text-xs text-gray-700">{{ f.filename }}</div>
              <div class="mt-1 flex items-center gap-3 text-xs text-gray-500">
                <span class="rounded bg-gray-100 px-1.5 py-0.5">{{ f.type }}</span>
                <span>{{ fmtSize(f.size) }}</span>
                <span>{{ new Date(f.mtime).toLocaleString("zh-CN") }}</span>
                <span v-if="f.inUse" class="text-blue-600">被记录引用</span>
                <span v-else class="text-orange-500">未引用</span>
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
          <audio v-else :src="`${base}/files/audio/${f.filename}`" controls class="mt-3 w-full" />
        </li>
      </ul>
      <p v-if="filtered.length === 0" class="py-10 text-center text-gray-400">没有匹配的文件</p>
    </template>
  </div>
</template>
