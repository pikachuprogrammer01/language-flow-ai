<script setup lang="ts">
/**
 * 新建任务页 — 单页全流程：生成内容 → 配音 → 渲染视频 → 播放
 * 调用链：/api/content/generate → /api/tts/from-content → /api/video/render
 */
import { ref } from "vue";
import {
  type GenerateInput,
  type RenderInput,
  generateContent,
  listVoices,
  previewVoice as previewVoiceApi,
  renderVideo,
  suggestTopics,
  synthesizeFromContent,
  updateTask,
} from "../api/client";

type Step = "idle" | "generating" | "generated" | "tts" | "rendering" | "done" | "error";

const topic = ref("森林探险");
/** 预设主题库（PRD §10.1.2 主题选择） */
const PRESET_TOPICS = [
  "森林探险",
  "科技创业",
  "美食探店",
  "校园生活",
  "旅行见闻",
  "职场故事",
] as const;
/** AI 推荐的主题候选（本地模型生成） */
const suggestedTopics = ref<{ title: string; description: string }[]>([]);
const suggesting = ref(false);
const level = ref<GenerateInput["level"]>("CET4");
/** 配音音色（PRD §10.1.1 配音可选） */
const voice = ref("zh-CN-XiaoxiaoNeural");
const voices = ref<{ id: string; name: string; gender: string }[]>([]);
/** 音色试听（固定试听文本 + 当前音色合成播放） */
const previewing = ref(false);
const previewText = "你好，欢迎来到四级词汇情景记忆课堂，今天我们一起学习吧。";
const step = ref<Step>("idle");
const errorMsg = ref("");
const title = ref("");
const segments = ref<{ text: string; words: { word: string; meaning: string }[] }[]>([]);
const videoUrl = ref("");
const audioDuration = ref(0);

const stepLabel: Record<Step, string> = {
  idle: "",
  generating: "① 生成内容（LLM 本地生成故事 + 词库校验）…",
  generated: "② 内容已生成",
  tts: "② 配音（Edge TTS）…",
  rendering: "③ 渲染视频（Playwright + FFmpeg）…",
  done: "✅ 完成",
  error: "❌ 失败",
};

const allWords = () => [
  ...new Map(segments.value.flatMap((s) => s.words.map((w) => [w.word, w]))).values(),
];

// 加载配音列表（失败静默，默认音色兜底）
listVoices()
  .then((data) => {
    voices.value = data.voices;
  })
  .catch(() => {});

/** AI 推荐主题（本地模型生成候选，用户点击选用；PRD §10.1.2） */
async function suggest(): Promise<void> {
  suggesting.value = true;
  errorMsg.value = "";
  try {
    const data = await suggestTopics({ hint: topic.value });
    suggestedTopics.value = data.topics;
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    suggesting.value = false;
  }
}

function pickTopic(t: string): void {
  topic.value = t;
}

/** 试听当前音色（合成固定试听文本并播放；PRD §10.1.1） */
async function previewVoice(): Promise<void> {
  previewing.value = true;
  errorMsg.value = "";
  try {
    const audio = await previewVoiceApi(voice.value, previewText);
    const base = (import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080").replace(/\/$/, "");
    new Audio(`${base}${audio.url}`).play();
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    previewing.value = false;
  }
}

async function run(): Promise<void> {
  step.value = "generating";
  errorMsg.value = "";
  try {
    const dto = await generateContent({
      topic: topic.value,
      level: level.value,
    });
    title.value = dto.title;
    segments.value = dto.content;
    step.value = "generated";

    step.value = "tts";
    const audio = await synthesizeFromContent("scene_word", dto.content, dto.title, voice.value);
    audioDuration.value = audio.duration;
    // audio 挂回 DTO 供渲染（render 的 audio 字段为必填；generate 固定返回 scene_word）
    const dtoWithAudio: RenderInput = { ...dto, template: "scene_word", audio };

    step.value = "rendering";
    const video = await renderVideo(dtoWithAudio);
    const base = (import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080").replace(/\/$/, "");
    videoUrl.value = `${base}${video.url}`;
    step.value = "done";
    // 回写生成记录（generate 已自动落库）：配音 + 视频 + 完成状态；失败静默（不影响主流程）
    try {
      await updateTask(dto.id, { audio, video, status: "completed" });
    } catch {
      /* 静默：记录回写失败不影响视频产出 */
    }
  } catch (err) {
    step.value = "error";
    errorMsg.value = err instanceof Error ? err.message : String(err);
  }
}
</script>

<template>
  <div class="mx-auto max-w-3xl px-6 py-10">
    <h1 class="mb-6 text-2xl font-bold text-gray-900">四级词汇情景记忆视频</h1>

    <!-- 表单 -->
    <form class="mb-8 rounded-xl bg-white p-6 shadow-sm" @submit.prevent="run">
      <div class="mb-4">
        <label class="mb-1 block text-sm font-medium text-gray-700" for="topic">故事主题</label>
        <!-- 预设主题库（点击即选） -->
        <div class="mb-2 flex flex-wrap gap-2">
          <button
            v-for="p in PRESET_TOPICS"
            :key="p"
            type="button"
            class="rounded-full border px-3 py-1 text-xs"
            :class="topic === p ? 'border-blue-500 bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-100'"
            @click="pickTopic(p)"
          >
            {{ p }}
          </button>
        </div>
        <div class="flex gap-2">
          <input
            id="topic"
            v-model="topic"
            class="w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none"
            placeholder="如：森林探险、美食探店，或点下方 AI 推荐"
            maxlength="50"
          />
          <button
            type="button"
            class="shrink-0 rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-700 disabled:opacity-50"
            :disabled="suggesting"
            @click="suggest"
          >
            {{ suggesting ? "推荐中…" : "✨ AI 推荐" }}
          </button>
        </div>
        <!-- AI 推荐候选（本地模型生成，点击选用） -->
        <div v-if="suggestedTopics.length > 0" class="mt-2 space-y-1">
          <button
            v-for="t in suggestedTopics"
            :key="t.title"
            type="button"
            class="flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm hover:bg-gray-50"
            @click="pickTopic(t.title)"
          >
            <span class="font-medium">{{ t.title }}</span>
            <span class="ml-3 truncate text-xs text-gray-500">{{ t.description }}</span>
          </button>
        </div>
      </div>
      <div class="mb-4 grid grid-cols-3 gap-4">
        <div>
          <label class="mb-1 block text-sm font-medium text-gray-700">等级</label>
          <select
            v-model="level"
            class="w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none"
          >
            <option value="CET4">CET4</option>
            <option value="CET6">CET6</option>
          </select>
        </div>
        <div class="grid gap-4 sm:grid-cols-2">
          <div>
            <label class="mb-1 block text-sm font-medium text-gray-700" for="voice">配音音色</label>
            <div class="mt-1 flex gap-2">
              <select id="voice" v-model="voice" class="w-full rounded-lg border px-3 py-2 text-sm">
                <option v-for="v in voices" :key="v.id" :value="v.id">{{ v.name }}</option>
              </select>
              <button
                type="button"
                class="shrink-0 rounded-lg bg-gray-100 px-3 py-2 text-sm hover:bg-gray-200 disabled:opacity-50"
                :disabled="previewing"
                @click="previewVoice"
              >
                {{ previewing ? "试听中…" : "🔊 试听" }}
              </button>
            </div>
          </div>
        </div>
      </div>
      <button
        type="submit"
        :disabled="step === 'generating' || step === 'tts' || step === 'rendering'"
        class="rounded-lg bg-blue-600 px-6 py-2.5 font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
      >
        {{ step === "idle" || step === "done" || step === "error" ? "生成视频" : "处理中…" }}
      </button>
      <span v-if="step !== 'idle'" class="ml-4 text-sm text-gray-500">{{ stepLabel[step] }}</span>
    </form>

    <!-- 错误 -->
    <div v-if="step === 'error'" class="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
      {{ errorMsg }}
    </div>

    <!-- 生成结果 -->
    <div v-if="step === 'generated' || step === 'tts' || step === 'rendering' || step === 'done'" class="mb-8 rounded-xl bg-white p-6 shadow-sm">
      <h2 class="mb-3 text-lg font-semibold text-gray-900">《{{ title }}》</h2>
      <div class="mb-4 space-y-3">
        <p v-for="(seg, i) in segments" :key="i" class="text-gray-700">{{ seg.text }}</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <span
          v-for="w in allWords()"
          :key="w.word"
          class="rounded-full bg-amber-100 px-3 py-1 text-sm text-gray-800"
        >
          <b class="text-gray-900">{{ w.word }}</b> {{ w.meaning }}
        </span>
      </div>
      <p v-if="step === 'done' && audioDuration" class="mt-3 text-xs text-gray-400">配音 {{ audioDuration.toFixed(1) }}s</p>
    </div>

    <!-- 视频播放 -->
    <div v-if="step === 'done' && videoUrl" class="rounded-xl bg-white p-6 shadow-sm">
      <video :src="videoUrl" controls class="mx-auto max-h-[70vh] rounded-lg" />
      <p class="mt-3 break-all text-center text-xs text-gray-500">{{ videoUrl }}</p>
    </div>
  </div>
</template>
