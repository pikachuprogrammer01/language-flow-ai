<script setup lang="ts">
/**
 * 任务详情页 — 生成记录详情 + 视频播放（完整链路产物回溯）
 * 数据源：GET /api/tasks/:id（ContentDTO 全量）
 */
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { deleteTask, getTask } from "../api/client";

const route = useRoute();
const router = useRouter();
const base = (import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080").replace(/\/$/, "");

const task = ref<Record<string, unknown> | null>(null);
const loading = ref(true);
const errorMsg = ref("");

interface WordInfo {
  word: string;
  meaning: string;
  level: string;
}

interface SegmentInfo {
  text: string;
}

interface VideoInfo {
  url: string;
  duration: number;
}

function isWordInfo(v: unknown): v is WordInfo {
  return typeof v === "object" && v !== null && "word" in v && "meaning" in v;
}

function isSegmentInfo(v: unknown): v is SegmentInfo {
  return typeof v === "object" && v !== null && "text" in v;
}

function isVideoInfo(v: unknown): v is VideoInfo {
  return typeof v === "object" && v !== null && "url" in v && "duration" in v;
}

const video = computed<VideoInfo | null>(() => {
  const v = task.value?.video;
  return isVideoInfo(v) ? v : null;
});

const words = computed<WordInfo[]>(() => {
  const w = task.value?.words;
  return Array.isArray(w) ? w.filter(isWordInfo) : [];
});

const segments = computed<SegmentInfo[]>(() => {
  const c = task.value?.content;
  return Array.isArray(c) ? c.filter(isSegmentInfo) : [];
});

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

async function load(): Promise<void> {
  loading.value = true;
  errorMsg.value = "";
  try {
    task.value = await getTask(String(route.params.id));
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function remove(): Promise<void> {
  if (!window.confirm("确定删除这条生成记录吗？")) return;
  try {
    await deleteTask(String(route.params.id));
    router.push("/tasks");
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  }
}

onMounted(load);
</script>

<template>
  <div class="mx-auto max-w-4xl px-6 py-10">
    <div class="mb-6 flex items-center justify-between">
      <button class="rounded-lg border px-4 py-2 text-sm hover:bg-gray-100" @click="router.push('/tasks')">
        ← 返回列表
      </button>
      <button class="rounded-lg border px-4 py-2 text-sm text-red-500 hover:bg-red-50" @click="remove">
        删除记录
      </button>
    </div>

    <p v-if="errorMsg" class="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-600">{{ errorMsg }}</p>
    <p v-if="loading" class="py-8 text-center text-gray-500">加载中…</p>

    <template v-else-if="task">
      <h1 class="text-2xl font-bold">{{ String(task.title) }}</h1>
      <div class="mt-2 flex items-center gap-3 text-sm text-gray-500">
        <span class="rounded bg-gray-100 px-2 py-0.5">{{ String(task.level) }}</span>
        <span>{{ STATUS_LABEL[String(task.status)] ?? String(task.status) }}</span>
        <span>创建：{{ new Date(String(task.createdAt)).toLocaleString("zh-CN") }}</span>
        <span v-if="task.updatedAt">更新：{{ new Date(String(task.updatedAt)).toLocaleString("zh-CN") }}</span>
      </div>

      <!-- 视频播放 -->
      <div v-if="video" class="mt-6">
        <video :src="base + video.url" controls class="mx-auto max-h-[70vh] rounded-xl border" />
        <p class="mt-2 text-center text-xs text-gray-500">
          时长 {{ video.duration.toFixed(1) }}s
        </p>
      </div>
      <p v-else class="mt-6 rounded-lg bg-gray-50 p-4 text-center text-sm text-gray-400">该记录尚未生成视频</p>

      <!-- 词汇 -->
      <h2 class="mt-8 text-lg font-semibold">词汇（{{ words.length }}）</h2>
      <ul class="mt-2 flex flex-wrap gap-2">
        <li v-for="w in words" :key="w.word" class="rounded-lg bg-yellow-100 px-3 py-1.5 text-sm">
          <span class="font-medium">{{ w.word }}</span>
          <span class="ml-2 text-gray-600">{{ w.meaning }}</span>
        </li>
      </ul>

      <!-- 正文 -->
      <h2 class="mt-8 text-lg font-semibold">正文</h2>
      <div class="mt-2 space-y-3">
        <p v-for="(seg, i) in segments" :key="i" class="rounded-lg bg-gray-50 p-4 text-sm leading-relaxed">
          {{ seg.text }}
        </p>
      </div>
    </template>
  </div>
</template>
