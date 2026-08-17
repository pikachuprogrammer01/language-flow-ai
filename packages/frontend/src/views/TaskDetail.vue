<script setup lang="ts">
/**
 * 任务详情页 — 生成记录详情 + 视频播放（完整链路产物回溯）
 * 数据源：GET /api/tasks/:id（ContentDTO 全量）
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  type RenderVideoInput,
  deleteTask,
  getTask,
  listVoices,
  renderVideo,
  synthesizeFromContent,
  updateTask,
} from "../api/client";

const route = useRoute();
const router = useRouter();
const base = (import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080").replace(/\/$/, "");

const task = ref<Record<string, unknown> | null>(null);
const loading = ref(true);
const errorMsg = ref("");
const notFound = ref(false);
/** 重新配音（PRD §10.1.1）：选音色 → 重合成 → 重渲染 → 回写 */
const voice = ref("zh-CN-XiaoxiaoNeural");
const voices = ref<{ id: string; name: string; gender: string }[]>([]);
const revoicing = ref(false);

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

/** 记录 → 渲染入参守卫（关键字段齐全即可，后端 zod 兜底校验） */
function isRenderInput(v: unknown): v is RenderVideoInput {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.template === "string" &&
    typeof o.title === "string" &&
    typeof o.level === "string" &&
    Array.isArray(o.content) &&
    Array.isArray(o.words) &&
    isVideoInfo(o.audio)
  );
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
  notFound.value = false;
  try {
    task.value = await getTask(String(route.params.id));
  } catch (err) {
    if (err instanceof Error && err.message.includes("404")) {
      notFound.value = true; // 记录不存在或已删除（例如旧记录未落库）
    } else {
      errorMsg.value = err instanceof Error ? err.message : String(err);
    }
  } finally {
    loading.value = false;
  }
}

// 同组件内路由参数变化（详情 A → 详情 B）或刷新/直链时重新加载
watch(() => route.params.id, load);

/** 重新配音：用记录正文 + 新音色重合成音频 → 重渲染视频 → 回写记录 */
async function revoice(): Promise<void> {
  if (!task.value) return;
  if (
    !window.confirm(
      `用「${voices.value.find((v) => v.id === voice.value)?.name ?? voice.value}」重新配音并重新渲染视频？`,
    )
  )
    return;
  revoicing.value = true;
  errorMsg.value = "";
  try {
    const t = task.value;
    const content = Array.isArray(t.content) ? t.content : [];
    const audio = await synthesizeFromContent(
      "scene_word",
      content,
      String(t.title ?? ""),
      voice.value,
    );
    // render 需要完整 ContentDTO（audio 必填）；守卫后传宽松 Record（后端 zod 兜底）
    const dto: RenderVideoInput = { ...t, template: "scene_word", audio };
    if (!isRenderInput(dto)) throw new Error("记录缺少渲染所需字段");
    const video = await renderVideo(dto);
    await updateTask(String(route.params.id), { audio, video, status: "completed" });
    await load();
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    revoicing.value = false;
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

// 加载配音列表（失败静默，默认音色兜底）
listVoices()
  .then((data) => {
    voices.value = data.voices;
  })
  .catch(() => {});
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
    <div v-else-if="notFound" class="py-12 text-center">
      <p class="text-gray-500">该记录不存在或已被删除</p>
      <button class="mt-4 rounded-lg border px-4 py-2 text-sm hover:bg-gray-100" @click="router.push('/tasks')">
        返回生成记录
      </button>
    </div>
    <p v-else-if="loading" class="py-8 text-center text-gray-500">加载中…</p>

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

      <!-- 重新配音（PRD §10.1.1） -->
      <div class="mt-4 flex flex-wrap items-center gap-3 rounded-xl border p-4">
        <select v-model="voice" class="rounded-lg border px-3 py-2 text-sm" :disabled="revoicing">
          <option v-for="v in voices" :key="v.id" :value="v.id">{{ v.name }}</option>
        </select>
        <button
          class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          :disabled="revoicing"
          @click="revoice"
        >
          {{ revoicing ? "重新配音渲染中…" : "重新配音并渲染" }}
        </button>
        <span class="text-xs text-gray-500">用新音色重新合成配音并重渲染视频</span>
      </div>

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
