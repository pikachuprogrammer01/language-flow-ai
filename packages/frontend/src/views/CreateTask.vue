<script setup lang="ts">
/**
 * 新建任务页 — 单页全流程：生成内容 → 配音 → 渲染视频 → 播放
 * 调用链：/api/content/generate → /api/tts/from-content → /api/video/render
 */
import { onMounted, ref } from "vue";
import {
  type GenerateInput,
  type RenderInput,
  type RenderVideoInput,
  generateContent,
  listFiles,
  listVoices,
  previewVoice as previewVoiceApi,
  renderVideo,
  suggestTopics,
  synthesizeFromContent,
  updateTask,
} from "../api/client";

type Step =
  | "idle"
  | "generating"
  | "generated"
  | "tts"
  | "audioReady"
  | "rendering"
  | "done"
  | "error";

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
/** 语速倍率（MVP 需求 #5：0.8 慢 / 1 正常 / 1.2 快） */
const rate = ref(1);
/** BGM 选择（生成时可选；重新渲染时混入，docs/13 素材清单） */
const bgm = ref("");
const bgmFiles = ref<{ filename: string }[]>([]);
const RATE_OPTIONS = [
  { value: 0.8, label: "慢" },
  { value: 1, label: "正常" },
  { value: 1.2, label: "快" },
];
const voices = ref<{ id: string; name: string; gender: string }[]>([]);
/** 音色试听：固定试听文本 + 当前音色合成播放；播放中可暂停，切换音色自动停上一个（避免干扰） */
const previewing = ref(false);
const previewPlaying = ref(false);
const previewText = "你好，欢迎来到四级词汇情景记忆课堂，今天我们一起学习吧。";
let previewAudio: HTMLAudioElement | null = null;
const step = ref<Step>("idle");
const errorMsg = ref("");
const title = ref("");
/** 模板选择（MVP 需求 #1）：情景背词 / 单词卡片 */
const template = ref<"scene_word" | "word_card" | "quiz">("scene_word");
const TEMPLATE_OPTIONS: { id: "scene_word" | "word_card" | "quiz"; label: string; desc: string }[] =
  [
    { id: "scene_word", label: "情景背词", desc: "故事场景 + 词汇高亮" },
    { id: "word_card", label: "单词卡片", desc: "单词 + 词性 + 例句" },
    { id: "quiz", label: "选择题", desc: "单词选择题 + 解析" },
  ];
const segments = ref<{ text: string; words: { word: string; meaning: string }[] }[]>([]);
/** word_card 生成结果（只读展示；编辑能力后续迭代） */
const cards = ref<
  { word: string; pos: string; meaning: string; example: string; exampleMeaning?: string }[]
>([]);
/** quiz 生成结果（只读展示：题目/选项/答案/解析） */
const questions = ref<
  { word: string; stem: string; options: string[]; correctIndex: number; explanation: string }[]
>([]);
const videoUrl = ref("");
const audioDuration = ref(0);
/** 配音成果（分步执行保留：渲染/重试直接复用，失败不重来） */
const audioMeta = ref<{ url: string; duration: number; format: string } | null>(null);
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
  audioReady: "配音完成，可渲染视频",
  rendering: "③ 渲染视频（Playwright + FFmpeg）…",
  done: "✅ 完成",
  error: "❌ 失败",
};

const allWords = () => [
  ...new Map(segments.value.flatMap((s) => s.words.map((w) => [w.word, w]))).values(),
];

// 加载 BGM 素材（重新渲染混音用；失败静默）
listFiles({ type: "bgm" })
  .then((data) => {
    bgmFiles.value = data.files;
  })
  .catch(() => {});

// 加载配音列表（失败静默，默认音色兜底）
listVoices()
  .then((data) => {
    voices.value = data.voices;
    // 当前音色不在列表（引擎切换后旧 id 失效）时切到默认
    if (!voices.value.some((v) => v.id === voice.value)) {
      voice.value = data.default ?? voices.value[0]?.id ?? "";
    }
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
    // 重新配音 + 渲染（当前音色/语速/BGM）
    step.value = "rendering";
    const audio = await synthesizeFromContent(
      "scene_word",
      content,
      title.value,
      voice.value,
      rate.value,
    );
    audioDuration.value = audio.duration;
    if (!dtoSnapshot.value) throw new Error("缺少渲染数据");
    const dtoWithAudio: RenderVideoInput = {
      ...dtoSnapshot.value,
      template: "scene_word",
      audio,
      style: {
        ...((dtoSnapshot.value.style as Record<string, unknown> | undefined) ?? {}),
        bgm: bgm.value,
      },
    };
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

async function generateStep(): Promise<boolean> {
  step.value = "generating";
  errorMsg.value = "";
  try {
    const dto = await generateContent({
      topic: topic.value,
      level: level.value,
      template: template.value,
    });
    title.value = dto.title;
    if (template.value === "word_card") {
      cards.value = (dto.content as Record<string, unknown>[]).map((c) => ({
        word: String(c.word ?? ""),
        pos: String(c.pos ?? ""),
        meaning: String(c.meaning ?? ""),
        example: String(c.example ?? ""),
        exampleMeaning: c.exampleMeaning != null ? String(c.exampleMeaning) : undefined,
      }));
      segments.value = [];
      questions.value = [];
    } else if (template.value === "quiz") {
      questions.value = (dto.content as Record<string, unknown>[]).map((q) => ({
        word: String((q as { word?: { word?: unknown } }).word?.word ?? ""),
        stem: String(q.stem ?? ""),
        options: Array.isArray(q.options) ? q.options.map(String) : [],
        correctIndex: Number(q.correctIndex ?? -1),
        explanation: String(q.explanation ?? ""),
      }));
      segments.value = [];
      cards.value = [];
    } else {
      segments.value = dto.content as {
        text: string;
        words: { word: string; meaning: string }[];
      }[];
    }
    dtoId.value = dto.id;
    dtoSnapshot.value = { ...dto, template: template.value };
    audioMeta.value = null;
    videoUrl.value = "";
    step.value = "generated";
    return true;
  } catch (err) {
    step.value = "error";
    errorMsg.value = err instanceof Error ? err.message : String(err);
    return false;
  }
}

/** 生成配音（分步：内容已生成后独立执行；失败只重试本步，不重来） */
async function ttsStep(): Promise<boolean> {
  if (!dtoSnapshot.value) {
    errorMsg.value = "请先生成内容";
    return false;
  }
  step.value = "tts";
  errorMsg.value = "";
  try {
    const audio = await synthesizeFromContent(
      template.value,
      dtoSnapshot.value.content as Record<string, unknown>[],
      String(dtoSnapshot.value.title ?? ""),
      voice.value,
      rate.value,
    );
    audioMeta.value = audio;
    audioDuration.value = audio.duration;
    step.value = "audioReady";
    return true;
  } catch (err) {
    step.value = "generated"; // 停在内容已生成态，可单独重试配音
    errorMsg.value = err instanceof Error ? err.message : String(err);
    return false;
  }
}

/** 渲染视频（分步：配音完成后独立执行；失败只重试本步，配音成果保留） */
async function renderStep(): Promise<boolean> {
  if (!dtoSnapshot.value || !audioMeta.value) {
    errorMsg.value = "请先完成生成与配音";
    return false;
  }
  step.value = "rendering";
  errorMsg.value = "";
  try {
    // dtoSnapshot 为宽松 Record（生成响应快照），运行时有完整 ContentDTO 字段，类型按项目先例收窄
    const dtoWithAudio = {
      ...dtoSnapshot.value,
      template: template.value,
      audio: audioMeta.value,
      style: {
        ...((dtoSnapshot.value.style as Record<string, unknown> | undefined) ?? {}),
        bgm: bgm.value,
      },
    } as unknown as RenderInput;
    const video = await renderVideo(dtoWithAudio);
    const base = (import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080").replace(/\/$/, "");
    videoUrl.value = `${base}${video.url}`;
    step.value = "done";
    // 回写生成记录（generate 已自动落库）：配音 + 视频 + 完成状态；失败静默（不影响主流程）
    try {
      await updateTask(dtoId.value, { audio: audioMeta.value, video, status: "completed" });
    } catch {
      /* 静默：记录回写失败不影响视频产出 */
    }
    return true;
  } catch (err) {
    step.value = "audioReady"; // 停在配音完成态，可单独重试渲染
    errorMsg.value = err instanceof Error ? err.message : String(err);
    return false;
  }
}

/** 一键全流程（任一步失败停在当前可重试状态，成果保留） */
async function run(): Promise<void> {
  if (!(await generateStep())) return;
  if (!(await ttsStep())) return;
  await renderStep();
}
</script>

<template>
  <div class="mx-auto max-w-3xl px-6 py-10">
    <h1 class="mb-6 text-2xl font-bold text-gray-900">四级词汇情景记忆视频</h1>

    <!-- 表单 -->
    <form class="mb-8 rounded-xl bg-white p-6 shadow-sm" @submit.prevent="run">
      <div class="mb-4">
        <div class="mb-4">
          <label class="mb-1 block text-sm font-medium text-gray-700">视频模板</label>
          <div class="flex gap-2">
            <button
              v-for="t in TEMPLATE_OPTIONS"
              :key="t.id"
              type="button"
              class="rounded-lg border px-3 py-1.5 text-sm"
              :class="template === t.id ? 'border-blue-500 bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-100'"
              @click="template = t.id"
            >
              {{ t.label }}
              <span class="ml-1 text-xs text-gray-400">{{ t.desc }}</span>
            </button>
          </div>
        </div>
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
          <!-- 语速（MVP 需求 #5）+ BGM（生成时可选，重新渲染混音） -->
          <div class="mt-2 flex flex-wrap items-center gap-2">
            <span class="text-xs text-gray-500">语速</span>
            <button
              v-for="r in RATE_OPTIONS"
              :key="r.value"
              type="button"
              class="rounded-full border px-3 py-0.5 text-xs"
              :class="rate === r.value ? 'border-blue-500 bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-100'"
              @click="rate = r.value"
            >
              {{ r.label }}
            </button>
            <span class="ml-2 text-xs text-gray-500">BGM</span>
            <select
              v-model="bgm"
              class="rounded-lg border px-2 py-1 text-xs"
            >
              <option value="">无 BGM</option>
              <option v-for="b in bgmFiles" :key="b.filename" :value="`/files/bgm/${b.filename}`">
                {{ b.filename }}
              </option>
            </select>
            <span class="text-xs text-gray-400">生成后可改，重新配音/渲染时生效</span>
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
    <div
      v-if="step === 'generated' || step === 'tts' || step === 'audioReady' || step === 'rendering' || step === 'done'"
      class="mb-8 rounded-xl bg-white p-6 shadow-sm"
    >
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
          v-if="step === 'done' && !editMode && template === 'scene_word'"
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
      <!-- quiz 结果（只读：题目/选项/答案/解析） -->
      <div v-if="template === 'quiz'" class="mb-4 space-y-3">
        <div v-for="(q, qi) in questions" :key="qi" class="rounded-lg border border-gray-200 p-4">
          <p class="font-medium text-gray-900">{{ qi + 1 }}. {{ q.stem }}</p>
          <ul class="mt-2 space-y-1">
            <li
              v-for="(opt, oi) in q.options"
              :key="oi"
              class="text-sm"
              :class="oi === q.correctIndex ? 'font-medium text-green-700' : 'text-gray-600'"
            >
              {{ String.fromCharCode(65 + oi) }}. {{ opt }}{{ oi === q.correctIndex ? " ✓" : "" }}
            </li>
          </ul>
          <p class="mt-2 text-xs text-gray-500">解析：{{ q.explanation }}</p>
        </div>
      </div>
      <!-- word_card 结果（只读卡片） -->
      <div v-if="template === 'word_card'" class="mb-4 grid gap-3 sm:grid-cols-2">
        <div v-for="c in cards" :key="c.word" class="rounded-lg border border-gray-200 p-4">
          <div class="flex items-baseline gap-2">
            <b class="text-lg text-gray-900">{{ c.word }}</b>
            <span class="text-xs text-gray-400">{{ c.pos }}</span>
          </div>
          <p class="mt-1 text-sm text-gray-700">{{ c.meaning }}</p>
          <p class="mt-2 text-sm leading-relaxed text-gray-800">{{ c.example }}</p>
          <p v-if="c.exampleMeaning" class="mt-1 text-xs text-gray-500">{{ c.exampleMeaning }}</p>
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
      <p v-if="(step === 'done' || step === 'audioReady') && audioDuration" class="mt-3 text-xs text-gray-400">
        配音 {{ audioDuration.toFixed(1) }}s
      </p>
      <!-- 分步操作（生成 → 配音 → 渲染，任一步失败只重试本步） -->
      <div class="mt-4 flex items-center gap-3">
        <button
          v-if="step === 'generated' || step === 'tts'"
          class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          :disabled="step === 'tts'"
          @click="ttsStep"
        >
          {{ step === 'tts' ? "配音生成中…" : audioMeta ? "重新配音" : "生成配音" }}
        </button>
        <button
          v-if="step === 'audioReady' || step === 'rendering'"
          class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          :disabled="step === 'rendering'"
          @click="renderStep"
        >
          {{ step === 'rendering' ? "渲染中…" : videoUrl ? "重新渲染" : "渲染视频" }}
        </button>
        <span v-if="step === 'audioReady'" class="text-xs text-gray-500">配音完成，可渲染视频</span>
      </div>
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
