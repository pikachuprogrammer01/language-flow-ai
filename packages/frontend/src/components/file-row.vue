<script setup lang="ts">
/** 文件管理行 — Files 列表行（勾选/元信息/引用/上传标记/删除 + 行内播放器） */
import { useRouter } from "vue-router";
import type { UploadMark } from "../api/client";

export interface FileItem {
  filename: string;
  type: "audio" | "video" | "bgm";
  size: number;
  mtime: string;
  inUse: boolean;
  referencedBy: { id: string; title: string }[];
}

defineProps<{
  f: FileItem;
  marks: UploadMark[];
  selected: boolean;
}>();

const emit = defineEmits<{
  toggleSelect: [];
  openMarks: [];
  remove: [];
}>();

const router = useRouter();

const TYPE_LABEL: Record<FileItem["type"], string> = {
  video: "视频（成片）",
  audio: "音频（配音）",
  bgm: "BGM（背景音乐）",
};

const base = (import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080").replace(/\/$/, "");

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
</script>

<template>
  <li class="rounded-xl border p-4">
    <div class="flex items-center justify-between gap-4">
      <div class="flex min-w-0 flex-1 items-center gap-3">
        <input type="checkbox" :checked="selected" @change="emit('toggleSelect')" />
        <div class="min-w-0 flex-1">
          <div class="truncate font-mono text-xs text-gray-700">{{ f.filename }}</div>
          <div class="mt-1 flex items-center gap-3 text-xs text-gray-500">
            <span class="rounded bg-gray-100 px-1.5 py-0.5">{{ TYPE_LABEL[f.type] }}</span>
            <span>{{ fmtSize(f.size) }}</span>
            <span>{{ new Date(f.mtime).toLocaleString("zh-CN") }}</span>
            <!-- 引用详情：被哪些生成记录使用（点击跳转） -->
            <span v-if="f.referencedBy.length > 0" class="flex flex-wrap items-center gap-1">
              <span class="text-blue-600">被引用：</span>
              <button
                v-for="r in f.referencedBy.slice(0, 2)"
                :key="r.id"
                class="max-w-[160px] truncate rounded bg-blue-50 px-1.5 py-0.5 text-blue-700 hover:bg-blue-100"
                :title="r.title"
                @click="router.push(`/tasks/${r.id}`)"
              >
                {{ r.title }}
              </button>
              <span v-if="f.referencedBy.length > 2" class="text-gray-400">等 {{ f.referencedBy.length }} 条</span>
            </span>
            <span v-else class="text-orange-500">未引用</span>
            <!-- 上传标记：video 分类显示平台徽章 -->
            <span v-if="f.type === 'video' && marks.length > 0" class="flex flex-wrap items-center gap-1">
              <span class="text-green-600">已标记：</span>
              <span
                v-for="m in marks.slice(0, 3)"
                :key="m.id"
                class="rounded bg-green-50 px-1.5 py-0.5 text-green-700"
                :title="m.note ?? undefined"
              >
                {{ m.platform }}
              </span>
              <span v-if="marks.length > 3" class="text-gray-400">等 {{ marks.length }} 个平台</span>
            </span>
          </div>
        </div>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <button
          v-if="f.type === 'video'"
          class="shrink-0 rounded-lg border px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100"
          @click="emit('openMarks')"
        >
          🏷 标记
        </button>
        <button
          class="shrink-0 rounded-lg border px-3 py-1.5 text-xs text-red-500 hover:bg-red-50"
          @click="emit('remove')"
        >
          删除
        </button>
      </div>
    </div>
    <video v-if="f.type === 'video'" :src="`${base}/files/video/${f.filename}`" controls class="mt-3 max-h-64 w-full rounded-lg" />
    <audio v-else :src="`${base}/files/${f.type}/${f.filename}`" controls class="mt-3 w-full" />
  </li>
</template>
