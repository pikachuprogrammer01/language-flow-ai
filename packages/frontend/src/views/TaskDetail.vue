<script setup lang="ts">
/**
 * 任务详情页 — 生成记录详情 + 视频播放（完整链路产物回溯）
 * 数据源：GET /api/tasks/:id（ContentDTO 全量）
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { toast } from "vue-sonner";
import {
  type RenderVideoInput,
  type UploadMark,
  deleteTask,
  getTask,
  listFiles,
  listUploadMarks,
  listVoices,
  renderVideo,
  synthesizeFromContent,
  updateTask,
} from "../api/client";
import ConfirmDialog from "../components/ui/confirm-dialog.vue";
// biome-ignore lint/style/useImportType: 组件在 Vue 模板中使用（biome 不感知模板标签）
import UploadMarkManager from "../components/upload-mark-manager.vue";

const route = useRoute();
const router = useRouter();
const base = (import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080").replace(/\/$/, "");

const task = ref<Record<string, unknown> | null>(null);
const loading = ref(true);
const errorMsg = ref("");
const notFound = ref(false);
/** 重新配音（PRD §10.1.1）：选音色 → 重合成 → 重渲染 → 回写 */
const voice = ref("zh-CN-XiaoxiaoNeural");
/** 语速倍率（MVP 需求 #5） */
const rate = ref(1);
const RATE_OPTIONS = [
  { value: 0.8, label: "慢" },
  { value: 1, label: "正常" },
  { value: 1.2, label: "快" },
];
const voices = ref<{ id: string; name: string; gender: string }[]>([]);
const revoicing = ref(false);
/** 审核修改（PRD §10.1.3）：编辑标题/正文 → 保存 → 重新配音渲染 */
const editing = ref(false);
const editTitle = ref("");
const editTexts = ref<string[]>([]);
/** word_card 编辑态：每卡字段 */
const editCards = ref<
  { word: string; pos: string; meaning: string; text: string; exampleMeaning: string }[]
>([]);
/** quiz 编辑态：每题目字段（options 固定 4 项编辑） */
const editQuestions = ref<
  { stem: string; options: string[]; correctIndex: number; explanation: string }[]
>([]);
const saving = ref(false);
/** 重新组装：BGM 选择（来自文件管理 bgm 素材，组装新视频时混音） */
const bgmFiles = ref<{ filename: string }[]>([]);
const bgm = ref("");
/** 确认对话框状态（重新配音确认 + 删除确认） */
const revoiceOpen = ref(false);
const revoiceConfirmTip = ref("");
const confirmOpen = ref(false);

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

/** 进入编辑模式：按模板载入编辑态（scene_word 正文 / word_card 卡片 / quiz 题目） */
function startEdit(): void {
  editTitle.value = String(task.value?.title ?? "");
  editTexts.value = segments.value.map((s) => s.text);
  editCards.value = wordCards.value.map((c) => ({
    word: c.word,
    pos: c.pos,
    meaning: c.meaning,
    text: c.text,
    exampleMeaning: c.exampleMeaning ?? "",
  }));
  editQuestions.value = quizQuestions.value.map((q) => ({
    stem: q.stem,
    options: [...q.options],
    correctIndex: q.correctIndex,
    explanation: q.explanation,
  }));
  editing.value = true;
}

function cancelEdit(): void {
  editing.value = false;
  editTitle.value = "";
  editTexts.value = [];
  editCards.value = [];
  editQuestions.value = [];
}

/** 按模板校验编辑态内容，返回 content 数组（scene_word 正文 / word_card 卡片 / quiz 题目） */
function buildEditedContent(t: Record<string, unknown>): Record<string, unknown>[] | null {
  if (t.template === "word_card") {
    for (const c of editCards.value) {
      if (!c.word.trim() || !c.text.trim()) {
        errorMsg.value = "卡片单词与例句不能为空";
        return null;
      }
    }
    return editCards.value.map((c) => ({
      word: c.word,
      pos: c.pos,
      meaning: c.meaning,
      example: c.text,
      exampleMeaning: c.exampleMeaning || undefined,
    }));
  }
  if (t.template === "quiz") {
    for (const q of editQuestions.value) {
      if (!q.stem.trim() || q.options.some((o) => !o.trim())) {
        errorMsg.value = "题干与选项不能为空";
        return null;
      }
      if (q.correctIndex < 0 || q.correctIndex >= q.options.length) {
        errorMsg.value = "正确答案索引超出选项范围";
        return null;
      }
    }
    const originals = Array.isArray(t.content) ? (t.content as { word?: unknown }[]) : [];
    return editQuestions.value.map((q, i) => {
      const origWord = originals[i]?.word;
      // render 校验要求 word 为 WordInfo 对象；取不到时从题干构造（renderer 不使用该字段内容）
      const word =
        origWord ??
        ({
          word: q.stem.split(" ")[0] ?? "word",
          meaning: "（未提供）",
          level: t.level ?? "CET4",
        } as Record<string, unknown>);
      return {
        stem: q.stem,
        options: q.options,
        correctIndex: q.correctIndex,
        explanation: q.explanation,
        word,
      };
    });
  }
  if (editTexts.value.some((x) => !x.trim())) {
    errorMsg.value = "正文不能有空段";
    return null;
  }
  return segments.value.map((seg, i) => ({
    ...seg,
    text: editTexts.value[i] ?? seg.text,
  }));
}

/** 保存修改：PATCH title/content → 用新内容重新配音渲染 → 回写（PRD §10.1.3，三模板通用） */
async function saveEdit(): Promise<void> {
  if (!task.value) return;
  const t = task.value as Record<string, unknown>;
  const content = buildEditedContent(t);
  if (!content) return;
  const template = t.template === "word_card" || t.template === "quiz" ? t.template : "scene_word";
  saving.value = true;
  errorMsg.value = "";
  try {
    await updateTask(String(route.params.id), { title: editTitle.value, content });
    editing.value = false;
    // 用新内容重新配音 + 渲染（复用重新配音链路）
    const refreshed = await getTask(String(route.params.id));
    task.value = refreshed;
    revoicing.value = true;
    const audio = await synthesizeFromContent(
      template,
      content,
      editTitle.value,
      voice.value,
      rate.value,
    );
    const dto: RenderVideoInput = {
      ...refreshed,
      template,
      audio,
      style: { ...(refreshed.style ?? {}), bgm: bgm.value },
    };
    if (!isRenderInput(dto)) throw new Error("记录缺少渲染所需字段");
    const video = await renderVideo(dto);
    await updateTask(String(route.params.id), { audio, video, status: "completed" });
    await load();
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    saving.value = false;
    revoicing.value = false;
  }
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

/** 上传标记：文件名 + 列表（watch 视频变化时加载） */
const videoFilename = computed<string>(() => {
  const url = video.value?.url ?? "";
  return url.split("/").pop() ?? "";
});
const marks = ref<UploadMark[]>([]);
const markManager = ref<InstanceType<typeof UploadMarkManager> | null>(null);

async function loadMarks(): Promise<void> {
  if (!videoFilename.value) {
    marks.value = [];
    return;
  }
  try {
    marks.value = await listUploadMarks(videoFilename.value);
  } catch {
    marks.value = [];
  }
}

watch(videoFilename, () => {
  void loadMarks();
});

const words = computed<WordInfo[]>(() => {
  const w = task.value?.words;
  return Array.isArray(w) ? w.filter(isWordInfo) : [];
});

/** 审计档案（PRD 10.1.4）展示类型：与后端 GenerationAudit 对齐，宽松解析 */
interface AuditInfo {
  input?: { topic?: string; level?: string; wordCount?: number; targetDuration?: number };
  process?: {
    candidates?: { source?: string; word?: string }[];
    attempts?: { result?: string; reason?: string; injectedWords?: string[] }[];
  };
  modifications?: { at?: string; fields?: string[] }[];
}

/** 模板判定：word_card 记录（详情只读展示卡片，无逐段编辑） */
const isWordCardTask = computed<boolean>(() => task.value?.template === "word_card");

/** 模板判定：quiz 记录（详情只读展示题目，无逐段编辑） */
const isQuizTask = computed<boolean>(() => task.value?.template === "quiz");

/** quiz 题目（宽松解析） */
const quizQuestions = computed<
  { stem: string; options: string[]; correctIndex: number; explanation: string }[]
>(() => {
  const c = task.value?.content;
  if (!Array.isArray(c)) return [];
  return c.map((q) => ({
    stem: String((q as { stem?: unknown }).stem ?? ""),
    options: Array.isArray((q as { options?: unknown }).options)
      ? (q as { options: unknown[] }).options.map(String)
      : [],
    correctIndex: Number((q as { correctIndex?: unknown }).correctIndex ?? -1),
    explanation: String((q as { explanation?: unknown }).explanation ?? ""),
  }));
});

/** word_card 卡片（宽松解析：word/pos/meaning/example 来自卡片段） */
const wordCards = computed<
  { word: string; pos: string; meaning: string; text: string; exampleMeaning?: string }[]
>(() => {
  const c = task.value?.content;
  if (!Array.isArray(c)) return [];
  return c.map((seg) => ({
    word: String((seg as { word?: unknown }).word ?? ""),
    pos: String((seg as { pos?: unknown }).pos ?? ""),
    meaning: String((seg as { meaning?: unknown }).meaning ?? ""),
    text: String((seg as { text?: unknown }).text ?? ""),
    exampleMeaning:
      (seg as { exampleMeaning?: unknown }).exampleMeaning != null
        ? String((seg as { exampleMeaning?: unknown }).exampleMeaning)
        : undefined,
  }));
});

const audit = computed<AuditInfo | null>(() => {
  const a = task.value?.audit;
  return a && typeof a === "object" ? (a as AuditInfo) : null;
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
  // 确认对话框（模板中 ConfirmDialog）
  revoiceConfirmTip.value = `用「${voices.value.find((v) => v.id === voice.value)?.name ?? voice.value}」重新配音并重新渲染视频？`;
  revoiceOpen.value = true;
}

/** 执行重新配音渲染（确认后） */
async function doRevoice(): Promise<void> {
  if (!task.value) return;
  if (!isWordCardTask.value && editing.value && editTexts.value.some((x) => !x.trim())) {
    errorMsg.value = "正文不能有空段";
    return;
  }
  revoicing.value = true;
  errorMsg.value = "";
  try {
    const t = task.value;
    // 编辑态：用编辑中的文案并一并保存（否则修改只存在本地，刷新即丢失）
    const isCard = t.template === "word_card" || t.template === "quiz";
    // 编辑态（仅 scene_word）：用编辑中的文案并一并保存；word_card 用记录内容
    const content = isCard
      ? Array.isArray(t.content)
        ? t.content
        : []
      : editing.value
        ? segments.value.map((seg, i) => ({ ...seg, text: editTexts.value[i] ?? seg.text }))
        : Array.isArray(t.content)
          ? t.content
          : [];
    const title = editing.value ? editTitle.value : String(t.title ?? "");
    const audio = await synthesizeFromContent(
      t.template === "word_card" || t.template === "quiz" ? t.template : "scene_word",
      content,
      title,
      voice.value,
      rate.value,
    );
    // render 需要完整 ContentDTO（audio 必填）；守卫后传宽松 Record（后端 zod 兜底）
    const dto: RenderVideoInput = {
      ...t,
      template: t.template === "word_card" || t.template === "quiz" ? t.template : "scene_word",
      audio,
      style: { ...(t.style ?? {}), bgm: bgm.value },
    };
    if (!isRenderInput(dto)) throw new Error("记录缺少渲染所需字段");
    const video = await renderVideo(dto);
    await updateTask(String(route.params.id), {
      ...(editing.value ? { title, content } : {}),
      audio,
      video,
      status: "completed",
    });
    editing.value = false;
    await load();
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    revoicing.value = false;
  }
}

async function remove(): Promise<void> {
  // 确认对话框（模板中 ConfirmDialog）
  confirmOpen.value = true;
}

/** 执行删除（确认后） */
async function doRemove(): Promise<void> {
  try {
    await deleteTask(String(route.params.id));
    toast.success("记录已删除");
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
    // 当前音色不在列表（引擎切换后旧 id 失效）时切到默认
    if (!voices.value.some((v) => v.id === voice.value)) {
      voice.value = data.default ?? voices.value[0]?.id ?? "";
    }
  })
  .catch(() => {});

// 加载 BGM 素材列表（重新组装视频用；失败静默）
listFiles({ type: "bgm" })
  .then((data) => {
    bgmFiles.value = data.files;
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
      <div class="flex items-center justify-between gap-3">
        <h1 v-if="!editing" class="text-2xl font-bold">{{ String(task.title) }}</h1>
        <input
          v-else
          v-model="editTitle"
          class="w-full rounded-lg border border-gray-300 px-3 py-2 text-xl font-bold focus:border-blue-500 focus:outline-none"
          maxlength="255"
        />
        <button
          v-if="!editing"
          class="shrink-0 rounded-lg border px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100"
          @click="startEdit"
        >
          ✏️ 编辑
        </button>
      </div>
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

      <!-- 上传标记 -->
      <div v-if="videoFilename" class="mt-3 flex flex-wrap items-center gap-2">
        <span class="text-xs text-gray-500">上传平台：</span>
        <span
          v-for="m in marks"
          :key="m.id"
          class="rounded bg-green-50 px-2 py-0.5 text-xs text-green-700"
          :title="m.note ?? undefined"
        >
          {{ m.platform }}<a v-if="m.url" :href="m.url" target="_blank" rel="noopener noreferrer" class="ml-1 underline">链接</a>
        </span>
        <span v-if="marks.length === 0" class="text-xs text-gray-400">未标记</span>
        <button
          class="rounded-lg border px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-100"
          @click="markManager?.open()"
        >
          🏷 管理标记
        </button>
      </div>

      <!-- 重新配音 + 组装（PRD §10.1.1 + 文件引用组装） -->
      <div class="mt-4 flex flex-wrap items-center gap-3 rounded-xl border p-4">
        <select v-model="voice" class="rounded-lg border px-3 py-2 text-sm" :disabled="revoicing">
          <option v-for="v in voices" :key="v.id" :value="v.id">{{ v.name }}</option>
        </select>
        <div class="flex items-center gap-1.5" :class="revoicing ? 'opacity-50' : ''">
          <span class="text-xs text-gray-500">语速</span>
          <button
            v-for="r in RATE_OPTIONS"
            :key="r.value"
            type="button"
            class="rounded-full border px-2.5 py-0.5 text-xs"
            :class="rate === r.value ? 'border-blue-500 bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-100'"
            @click="rate = r.value"
          >
            {{ r.label }}
          </button>
        </div>
        <select v-model="bgm" class="rounded-lg border px-3 py-2 text-sm" :disabled="revoicing">
          <option value="">无 BGM</option>
          <option v-for="b in bgmFiles" :key="b.filename" :value="`/files/bgm/${b.filename}`">{{ b.filename }}</option>
        </select>
        <button
          class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          :disabled="revoicing"
          @click="revoice"
        >
          {{ revoicing ? "重新配音渲染中…" : "重新配音并渲染" }}
        </button>
        <span class="text-xs text-gray-500">选音色 + BGM（可无），重新组装新视频</span>
      </div>

      <!-- 词汇 -->
      <h2 class="mt-8 text-lg font-semibold">词汇（{{ words.length }}）</h2>
      <ul class="mt-2 flex flex-wrap gap-2">
        <li v-for="w in words" :key="w.word" class="rounded-lg bg-yellow-100 px-3 py-1.5 text-sm">
          <span class="font-medium">{{ w.word }}</span>
          <span class="ml-2 text-gray-600">{{ w.meaning }}</span>
        </li>
      </ul>

      <!-- quiz 题目展示/编辑 -->
      <template v-if="isQuizTask">
        <h2 class="mt-8 text-lg font-semibold">选择题（{{ quizQuestions.length }}）</h2>
        <div class="mt-2 space-y-3">
          <div
            v-for="(q, qi) in editing ? editQuestions : quizQuestions"
            :key="qi"
            class="rounded-lg border border-gray-200 p-4"
          >
            <template v-if="editing">
              <input
                v-model="editQuestions[qi].stem"
                class="w-full rounded-lg border border-gray-300 px-2 py-1 text-sm font-medium focus:border-blue-500 focus:outline-none"
                placeholder="题干"
              />
              <div class="mt-2 space-y-1">
                <div v-for="(opt, oi) in editQuestions[qi].options" :key="oi" class="flex items-center gap-2">
                  <input
                    type="radio"
                    :checked="editQuestions[qi].correctIndex === oi"
                    @change="editQuestions[qi].correctIndex = oi"
                  />
                  <span class="text-xs text-gray-400">{{ String.fromCharCode(65 + oi) }}.</span>
                  <input
                    v-model="editQuestions[qi].options[oi]"
                    class="w-full rounded-lg border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
                    :placeholder="`选项 ${String.fromCharCode(65 + oi)}`"
                  />
                </div>
              </div>
              <textarea
                v-model="editQuestions[qi].explanation"
                rows="2"
                class="mt-2 w-full rounded-lg border border-gray-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none"
                placeholder="解析"
              />
            </template>
            <template v-else>
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
            </template>
          </div>
        </div>
      </template>

      <!-- word_card 卡片展示/编辑 -->
      <template v-if="isWordCardTask">
        <h2 class="mt-8 text-lg font-semibold">单词卡片（{{ wordCards.length }}）</h2>
        <div class="mt-2 grid gap-3 sm:grid-cols-2">
          <div
            v-for="(c, i) in editing ? editCards : wordCards"
            :key="i"
            class="rounded-lg border border-gray-200 p-4"
          >
            <template v-if="editing">
              <div class="flex gap-2">
                <input
                  v-model="editCards[i].word"
                  class="w-1/2 rounded-lg border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
                  placeholder="单词"
                />
                <input
                  v-model="editCards[i].pos"
                  class="w-1/2 rounded-lg border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
                  placeholder="词性（如 v.）"
                />
              </div>
              <input
                v-model="editCards[i].meaning"
                class="mt-2 w-full rounded-lg border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
                placeholder="释义"
              />
              <input
                v-model="editCards[i].text"
                class="mt-2 w-full rounded-lg border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
                placeholder="例句"
              />
              <input
                v-model="editCards[i].exampleMeaning"
                class="mt-2 w-full rounded-lg border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
                placeholder="例句翻译"
              />
            </template>
            <template v-else>
              <div class="flex items-baseline gap-2">
                <b class="text-lg text-gray-900">{{ c.word }}</b>
                <span class="text-xs text-gray-400">{{ c.pos }}</span>
              </div>
              <p class="mt-1 text-sm text-gray-700">{{ c.meaning }}</p>
              <p class="mt-2 text-sm leading-relaxed text-gray-800">{{ c.text }}</p>
            </template>
          </div>
        </div>
      </template>

      <!-- 正文（scene_word） -->
      <template v-else-if="!isQuizTask && !isWordCardTask">
        <h2 class="mt-8 text-lg font-semibold">正文</h2>
        <div class="mt-2 space-y-3">
        <div v-for="(seg, i) in segments" :key="i" class="rounded-lg bg-gray-50 p-4 text-sm leading-relaxed">
          <textarea
            v-if="editing"
            v-model="editTexts[i]"
            rows="3"
            class="w-full rounded-lg border border-gray-300 px-3 py-2 focus:border-blue-500 focus:outline-none"
          />
          <p v-else>{{ seg.text }}</p>
        </div>
      </div>

      <!-- 编辑操作（PRD §10.1.3 审核修改） -->
      <div v-if="editing" class="mt-4 flex items-center gap-3">
        <button
          class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          :disabled="saving || revoicing"
          @click="saveEdit"
        >
          {{ saving || revoicing ? "保存并重新配音渲染中…" : "保存修改并重新渲染" }}
        </button>
        <button class="rounded-lg border px-4 py-2 text-sm hover:bg-gray-100" :disabled="saving" @click="cancelEdit">
          取消
        </button>
        <span class="text-xs text-gray-500">保存后会用新内容重新配音并重渲染视频</span>
      </div>
      </template>

      <!-- 生成档案（PRD 10.1.4 审计：输入/候选词/重试历史/修改日志） -->
      <details class="mt-8 rounded-lg border border-gray-200">
        <summary class="cursor-pointer px-4 py-3 text-sm font-medium text-gray-700">
          生成档案（输入 / 候选词 / 重试 / 修改日志）
          <span v-if="audit" class="ml-2 rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-600">有档案</span>
          <span v-else class="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-400">无档案</span>
        </summary>
        <div class="space-y-3 border-t px-4 py-3 text-xs leading-relaxed text-gray-600">
          <p v-if="!audit" class="text-gray-400">
            该记录生成于审计功能上线前，无过程档案；此后对它的修改会记录在下方修改日志中。
          </p>
          <div v-if="audit?.input">
            主题「{{ audit.input.topic }}」 · {{ audit.input.level }} · 词数
            {{ audit.input.wordCount ?? "自动" }} · 目标时长 {{ audit.input.targetDuration ?? 60 }}s
          </div>
          <div v-if="audit?.process?.candidates?.length">
            候选词（{{ audit.process.candidates.length }}）：
            <span
              v-for="c in audit.process.candidates"
              :key="c.word"
              class="mr-1.5 inline-block rounded bg-gray-100 px-1.5 py-0.5"
            >
              {{ c.word }}<span class="text-gray-400">（{{ c.source }}）</span>
            </span>
          </div>
          <div v-if="audit?.process?.attempts?.length">
            生成尝试（{{ audit.process.attempts.length }} 次）：
            <ul class="ml-4 list-disc">
              <li v-for="(a, i) in audit.process.attempts" :key="i">
                第 {{ i + 1 }} 次：{{ a.result === "accepted" ? "通过" : "拒绝" }}{{ a.reason ? `（${a.reason}）` : "" }}
                <span v-if="a.injectedWords?.length"> · 注入 {{ a.injectedWords.length }} 词</span>
              </li>
            </ul>
          </div>
          <div v-if="audit?.modifications?.length">
            修改日志：
            <ul class="ml-4 list-disc">
              <li v-for="(m, i) in audit.modifications" :key="i">
                {{ new Date(String(m.at)).toLocaleString("zh-CN") }} · {{ (m.fields ?? []).join("、") }}
              </li>
            </ul>
          </div>
        </div>
      </details>
    </template>
  </div>

  <!-- 确认对话框（shadcn-vue AlertDialog） -->
  <ConfirmDialog
    v-model:open="revoiceOpen"
    title="重新配音并渲染"
    :description="revoiceConfirmTip"
    confirm-text="开始渲染"
    @confirm="doRevoice"
  />
  <ConfirmDialog
    v-model:open="confirmOpen"
    title="删除生成记录"
    description="确定删除这条生成记录吗？"
    confirm-text="删除"
    destructive
    @confirm="doRemove"
  />

  <!-- 上传标记管理 -->
  <UploadMarkManager ref="markManager" :filename="videoFilename" @change="loadMarks" />
</template>
