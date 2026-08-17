<script setup lang="ts">
/**
 * 新建任务页 — 单页全流程：生成内容 → 配音 → 渲染视频 → 播放
 * 调用链：/api/content/generate → /api/tts/from-content → /api/video/render
 */
import { ref } from "vue";
import {
  type GenerateInput,
  type RenderInput,
  type RenderVideoInput,
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
/** 音色试听：固定试听文本 + 当前音色合成播放；播放中可暂停，切换音色自动停上一个（避免干扰） */
const previewing = ref(false);
const previewPlaying = ref(false);
const previewText = "你好，欢迎来到四级词汇情景记忆课堂，今天我们一起学习吧。";
let previewAudio: HTMLAudioElement | null = null;
const step = ref<Step>("idle");
const errorMsg = ref("");
const title = ref("");
const segments = ref<{ text: string; words: { word: string; meaning: string }[] }[]>([]);
const videoUrl = ref("");
const audioDuration = ref(0);
/** 生成后原地编辑（PRD §10.1.3）：编辑标题/正文 → 保存 → 原地重渲染 */
const dtoId = ref("");
const editMode = ref(false);
const editTitle = ref("");
const editTexts = ref<string[]>([]);
const saving = ref(false);
/** 渲染入参快照（生成成功后存，编辑保存时复用；Record 基类型便于后续加 audio 重组） */
const dtoSnapshot = ref<Record<string, unknown> | null>(null);

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

/** 进入编辑模式：载入当前标题/正文 */
function startEdit(): void {
  editTitle.value = title.value;
  editTexts.value = segments.value.map((s) => s.text);
  editMode.value = true;
}

function cancelEdit(): void {
  editMode.value = false;
  editTitle.value = "";
  editTexts.value = [];
}

/** 保存修改并原地重新渲染（PATCH 记录 → 重合成 → 重渲染 → 更新播放） */
async function saveEdit(): Promise<void> {
  if (editTexts.value.some((t) => !t.trim())) {
    errorMsg.value = "正文不能有空段";
    return;
  }
  saving.value = true;
  errorMsg.value = "";
  try {
    const content = segments.value.map((seg, i) => ({
      ...seg,
      text: editTexts.value[i] ?? seg.text,
    }));
    title.value = editTitle.value;
    segments.value = content;
    editMode.value = false;
    // 更新记录内容
    await updateTask(dtoId.value, { title: title.value, content });
    // 重新配音 + 渲染（当前音色；BGM 暂用生成页默认无）
    step.value = "rendering";
    const audio = await synthesizeFromContent("scene_word", content, title.value, voice.value);
    audioDuration.value = audio.duration;
    if (!dtoSnapshot.value) throw new Error("缺少渲染数据");
    const dtoWithAudio: RenderVideoInput = { ...dtoSnapshot.value, template: "scene_word", audio };
    const video = await renderVideo(dtoWithAudio);
    const base = (import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080").replace(/\/$/, "");
    videoUrl.value = `${base}${video.url}`;
    await updateTask(dtoId.value, { audio, video, status: "completed" });
    step.value = "done";
  } catch (err) {
    step.value = "error";
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving.value = false;
  }
}

/** 停止当前试听播放（暂停并释放） */
function stopPreview(): void {
  if (previewAudio) {
    previewAudio.pause();
    previewAudio = null;
  }
  previewPlaying.value = false;
}

/** 试听当前音色（合成固定试听文本并播放；切换音色时先停掉上一个） */
async function previewVoice(): Promise<void> {
  stopPreview(); // 上一个音色立即停止，避免叠加干扰
  previewing.value = true;
  errorMsg.value = "";
  try {
    const audio = await previewVoiceApi(voice.value, previewText);
    const base = (import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080").replace(/\/$/, "");
    const el = new Audio(`${base}${audio.url}`);
    previewAudio = el;
    el.onended = () => {
      previewAudio = null;
      previewPlaying.value = false;
    };
    await el.play();
    previewPlaying.value = true;
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
    dtoId.value = dto.id;
    const snapshot: Record<string, unknown> = { ...dto, template: "scene_word" };
    dtoSnapshot.value = snapshot;
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
      <div class="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
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
          <label class="mb-1 block text-sm font-medium text-gray-700" for="voice">配音音色</label>
          <div class="mt-1 flex gap-2">
            <select id="voice" v-model="voice" class="w-full rounded-lg border px-3 py-2 text-sm">
              <option v-for="v in voices" :key="v.id" :value="v.id">{{ v.name }}</option>
            </select>
            <button
              type="button"
              class="shrink-0 rounded-lg bg-gray-100 px-3 py-2 text-sm hover:bg-gray-200 disabled:opacity-50"
              :disabled="previewing"
              @click="previewPlaying ? stopPreview() : previewVoice()"
            >
              {{ previewing ? "试听中…" : previewPlaying ? "⏸ 暂停" : "🔊 试听" }}
            </button>
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
      <!-- 审核修改（PRD §10.1.3）：生成后原地编辑，无需跳转 -->
      <div class="mb-3 flex items-center justify-between gap-3">
        <input
          v-if="editMode"
          v-model="editTitle"
          class="w-full rounded-lg border border-gray-300 px-3 py-2 text-lg font-semibold focus:border-blue-500 focus:outline-none"
          maxlength="255"
        />
        <h2 v-else class="text-lg font-semibold text-gray-900">《{{ title }}》</h2>
        <button
          v-if="step === 'done' && !editMode"
          class="shrink-0 rounded-lg border px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100"
          @click="startEdit"
        >
          ✏️ 编辑
        </button>
      </div>
      <div class="mb-4 space-y-3">
        <div v-for="(seg, i) in segments" :key="i">
          <textarea
            v-if="editMode"
            v-model="editTexts[i]"
            rows="3"
            class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            placeholder="正文段落"
          />
          <p v-else class="text-gray-700">{{ seg.text }}</p>
        </div>
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
      <!-- 编辑操作 -->
      <div v-if="editMode" class="mt-4 flex items-center gap-3">
        <button
          class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          :disabled="saving"
          @click="saveEdit"
        >
          {{ saving ? "保存并重新配音渲染中…" : "保存修改并重新渲染" }}
        </button>
        <button class="rounded-lg border px-4 py-2 text-sm hover:bg-gray-100" :disabled="saving" @click="cancelEdit">
          取消
        </button>
        <span class="text-xs text-gray-500">保存后原地重新配音（当前音色）并重渲染视频</span>
      </div>
    </div>

    <!-- 视频播放 -->
    <div v-if="step === 'done' && videoUrl" class="rounded-xl bg-white p-6 shadow-sm">
      <video :src="videoUrl" controls class="mx-auto max-h-[70vh] rounded-lg" />
      <p class="mt-3 break-all text-center text-xs text-gray-500">{{ videoUrl }}</p>
    </div>
  </div>
</template>
