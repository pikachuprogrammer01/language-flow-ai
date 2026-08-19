<script setup lang="ts">
/** 生成记录行 — TaskList 列表行（勾选/徽章/打开/标记/复制名称/详情/删除） */
import { computed } from "vue";

const props = defineProps<{
  t: {
    id: string;
    title: string;
    textPreview?: string;
    level: string;
    status: string;
    createdAt: string;
    video?: unknown;
  };
  /** 上传标记数量（父组件索引） */
  marksCount: number;
  /** 按钮内联反馈文案（父组件维护） */
  openFeedback?: string;
  copyFeedback?: string;
  selected: boolean;
}>();

const emit = defineEmits<{
  toggleSelect: [];
  openFinder: [];
  openMarks: [];
  copyName: [];
  detail: [];
  remove: [];
}>();

/** 从记录中提取视频 URL（video 为可选的 VideoInfo，结构收窄避免 any） */
function videoUrl(t: { video?: unknown }): string | null {
  if (t.video && typeof t.video === "object" && "url" in t.video) {
    return typeof t.video.url === "string" ? t.video.url : null;
  }
  return null;
}

/** 从视频 URL 提取文件名（/files/video/xxx.mp4 → xxx.mp4） */
function videoName(t: { video?: unknown }): string | null {
  const url = videoUrl(t);
  if (!url) return null;
  return url.split("/").pop() ?? null;
}

const STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  ai_generating: "生成中",
  content_ready: "内容就绪",
  tts_processing: "配音中",
  audio_ready: "配音完成",
  video_rendering: "渲染中",
  completed: "已完成",
  failed: "失败",
};

const hasVideo = computed(() => videoUrl(props.t) !== null);
const fileName = computed(() => videoName(props.t));
</script>

<template>
  <li class="flex items-center justify-between rounded-xl border p-4 hover:shadow-sm">
    <input
      type="checkbox"
      class="mr-3 shrink-0"
      :checked="selected"
      @change="emit('toggleSelect')"
    />
    <div class="min-w-0 cursor-pointer flex-1" @click="emit('detail')">
      <div class="truncate font-medium">{{ t.title }}</div>
      <p v-if="t.textPreview" class="mt-1 truncate text-sm text-gray-600">{{ t.textPreview }}</p>
      <div class="mt-1 flex items-center gap-3 text-xs text-gray-500">
        <span class="rounded bg-gray-100 px-1.5 py-0.5">{{ t.level }}</span>
        <span>{{ STATUS_LABEL[t.status] ?? t.status }}</span>
        <span>{{ new Date(t.createdAt).toLocaleString("zh-CN") }}</span>
        <span v-if="t.video" class="text-green-600">▶ 有视频</span>
        <span v-else class="text-gray-400">暂无视频</span>
        <span
          v-if="marksCount > 0"
          class="rounded bg-green-50 px-1.5 py-0.5 text-green-700"
          title="已标记平台"
        >
          已标记 ×{{ marksCount }}
        </span>
      </div>
    </div>
    <div class="ml-4 flex shrink-0 gap-2">
      <button
        v-if="hasVideo"
        class="rounded-lg border px-3 py-1.5 text-xs text-blue-600 hover:bg-blue-50"
        :class="openFeedback ? 'border-blue-500 bg-blue-50 text-blue-700' : ''"
        :title="openFeedback ? undefined : '在 Finder 中打开视频所在目录'"
        @click="emit('openFinder')"
      >
        {{ openFeedback ?? "📂 打开" }}
      </button>
      <button
        v-if="hasVideo"
        class="rounded-lg border px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100"
        title="管理上传平台标记"
        @click="emit('openMarks')"
      >
        🏷 标记
      </button>
      <button
        v-if="fileName"
        class="rounded-lg border px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100"
        :class="copyFeedback ? 'border-green-500 bg-green-50 text-green-700' : ''"
        :title="copyFeedback ? undefined : '复制视频文件名'"
        @click="emit('copyName')"
      >
        {{ copyFeedback ?? "📋 复制名称" }}
      </button>
      <button class="rounded-lg border px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100" @click="emit('detail')">
        详情
      </button>
      <button class="rounded-lg border px-3 py-1.5 text-xs text-red-500 hover:bg-red-50" @click="emit('remove')">
        删除
      </button>
    </div>
  </li>
</template>
