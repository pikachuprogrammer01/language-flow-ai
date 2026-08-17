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
  renderVideo,
  synthesizeFromContent,
  updateTask,
} from "../api/client";

type Step = "idle" | "generating" | "generated" | "tts" | "rendering" | "done" | "error";

const topic = ref("森林探险");
const level = ref<GenerateInput["level"]>("CET4");
const wordCount = ref(8);
const targetDuration = ref(60);
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

async function run(): Promise<void> {
  step.value = "generating";
  errorMsg.value = "";
  try {
    const dto = await generateContent({
      topic: topic.value,
      level: level.value,
      wordCount: wordCount.value,
      targetDuration: targetDuration.value,
    });
    title.value = dto.title;
    segments.value = dto.content;
    step.value = "generated";

    step.value = "tts";
    const audio = await synthesizeFromContent("scene_word", dto.content, dto.title);
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
        <input
          id="topic"
          v-model="topic"
          class="w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none"
          placeholder="如：森林探险、美食探店"
          maxlength="50"
        />
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
        <div>
          <label class="mb-1 block text-sm font-medium text-gray-700" for="word-count">词汇数量（{{ wordCount }}）</label>
          <input id="word-count" v-model.number="wordCount" type="range" min="3" max="15" class="mt-3 w-full" />
        </div>
        <div>
          <label class="mb-1 block text-sm font-medium text-gray-700" for="duration">视频时长（{{ targetDuration }}s）</label>
          <input id="duration" v-model.number="targetDuration" type="range" min="15" max="300" step="15" class="mt-3 w-full" />
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
