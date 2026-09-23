<script setup lang="ts">
/**
 * 新建任务页 — 单页全流程：生成内容 → 配音 → 渲染视频 → 播放
 * 调用链：/api/content/generate → /api/tts/from-content → /api/video/render
 */
import { fitSceneWordFontSize } from "@ai-english/shared";
import {
  BookOpen,
  Brain,
  Check,
  Circle,
  CircleHelp,
  Pause,
  Pencil,
  Sparkles,
  TriangleAlert,
  Volume2,
} from "lucide-vue-next";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
  type GenerateInput,
  type RenderInput,
  type RenderVideoInput,
  generateContent,
  isAbortError,
  listFiles,
  listVoices,
  previewVoice as previewVoiceApi,
  renderVideo,
  suggestTopics,
  synthesizeFromContent,
  updateTask,
  updateVideoAnalytics,
} from "../api/client";
import CardEditor, { type WordCard } from "../components/editors/card-editor.vue";
import QuizEditor from "../components/editors/quiz-editor.vue";
import SegmentEditor from "../components/editors/segment-editor.vue";
import WordChips from "../components/editors/word-chips.vue";
import ConfirmDialog from "../components/ui/confirm-dialog.vue";
import Spinner from "../components/ui/spinner.vue";
import { useAudioPreview } from "../composables/use-audio-preview";
import {
  registerCreateSession,
  setCreatePhase,
  unregisterCreateSession,
} from "../lib/create-session";
import { toast } from "../lib/toast";

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
/** 预设主题库（PRD §10.1.2：分组展示，覆盖学习/职场/旅行/情感等场景） */
const TOPIC_GROUPS = [
  {
    label: "校园与成长",
    topics: ["校园生活", "图书馆备考", "社团招新", "毕业季离别", "宿舍夜谈", "选修课翻车"],
  },
  {
    label: "职场与创业",
    topics: ["职场故事", "科技创业", "面试求职", "远程办公日常", "创业融资路演", "加班夜归"],
  },
  {
    label: "美食与日常",
    topics: ["美食探店", "深夜便利店", "咖啡店偶遇", "家庭聚餐", "周末市集", "厨房初体验"],
  },
  {
    label: "旅行与户外",
    topics: ["旅行见闻", "森林探险", "海边度假", "城市夜跑", "博物馆一日游", "山间露营"],
  },
  {
    label: "生活切片",
    topics: ["地铁通勤", "健身房打卡", "宠物日常", "网购开箱", "医院就诊", "搬家折腾"],
  },
  {
    label: "情感与关系",
    topics: ["久别重逢", "邻里互助", "老友叙旧", "异地思念", "第一次约会"],
  },
  {
    label: "兴趣与文化",
    topics: ["音乐节现场", "书店半日闲", "摄影街拍", "话剧散场后", "夜市逛吃"],
  },
  {
    label: "社会与时事感",
    topics: ["环保行动日", "社区志愿", "旧物改造", "数字断舍离", "清晨菜市场"],
  },
] as const;
/** AI 推荐的主题候选（本地模型生成） */
const suggestedTopics = ref<{ title: string; description: string }[]>([]);
const suggesting = ref(false);
const level = ref<GenerateInput["level"]>("CET4");
/** 配音音色（PRD §10.1.1 配音可选；默认云健·男·浑厚） */
const voice = ref("zh-CN-YunjianNeural");
/** 语速倍率（MVP 需求 #5：0.8 慢 / 1 正常 / 1.2 快） */
const rate = ref(1);
/** BGM 选择（生成时可选；默认钢琴曲 free-04-piano-iix.mp3，重新渲染时混入，docs/13 素材清单） */
const bgm = ref("/files/bgm/free-04-piano-iix.mp3");
const bgmFiles = ref<{ filename: string }[]>([]);
/** scene_word 片头 Three.js 动效（默认开；约 1 秒静音占位） */
const introEffect = ref(true);
/** 观众保存策略（生成即可选；默认不保存——平台内容不主动开放下载，渲染后写 video_analytics） */
const allowSave = ref(false);
const RATE_OPTIONS = [
  { value: 0.8, label: "慢" },
  { value: 1, label: "正常" },
  { value: 1.2, label: "快" },
];
const voices = ref<{ id: string; name: string; gender: string }[]>([]);
/** 音色试听：固定试听文本 + 当前音色合成播放；播放中可暂停，切换音色自动停上一个（避免干扰） */
const previewing = ref(false);
const previewText = "你好，欢迎来到四级词汇情景记忆课堂，今天我们一起学习吧。";
/** 试听控制（音色 + BGM 共用单例状态机：同时只播一个，按钮状态跟随） */
const {
  playing: previewPlaying,
  play: playPreview,
  stop: stopPreview,
  toggle: togglePreview,
  isPlaying,
} = useAudioPreview();
const step = ref<Step>("idle");
const errorMsg = ref("");
const title = ref("");
/** 模板选择（MVP 需求 #1）：情景背词 / 单词卡片 */
const template = ref<"scene_word" | "word_card" | "quiz">("scene_word");
const TEMPLATE_OPTIONS: { id: "scene_word" | "word_card" | "quiz"; label: string; desc: string }[] =
  [
    { id: "scene_word", label: "情景背词", desc: "故事 + 重点词高亮" },
    { id: "word_card", label: "单词卡片", desc: "词义 + 例句卡片" },
    { id: "quiz", label: "选择题", desc: "题干 + 4 选项 + 解析" },
  ];
/** 模板缩略图标（lucide SVG，与按钮图标体系一致） */
const TEMPLATE_ICONS: Record<"scene_word" | "word_card" | "quiz", typeof BookOpen> = {
  scene_word: BookOpen,
  word_card: Brain,
  quiz: CircleHelp,
};
const segments = ref<{ text: string; words: { word: string; meaning: string }[] }[]>([]);
/** 卡片展示视图（编辑态/展示态字段统一为 example） */
const cardViews = computed(() => {
  const src = editMode.value ? editCards.value : cards.value;
  return src.map((c) => ({
    word: c.word,
    pos: c.pos,
    meaning: c.meaning,
    example: "example" in c ? c.example : c.text,
    exampleMeaning: c.exampleMeaning,
  }));
});

/** word_card 生成结果（只读展示；编辑能力后续迭代） */
const cards = ref<
  { word: string; pos: string; meaning: string; example: string; exampleMeaning?: string }[]
>([]);
/** quiz 生成结果（只读展示：题目/选项/答案/解析） */
const questions = ref<
  { word: string; stem: string; options: string[]; correctIndex: number; explanation: string }[]
>([]);
const videoUrl = ref("");
/** 本次渲染片头结果（scene_word）：驱动完成页徽章（DS4/D5） */
const introStatus = ref<"" | "rendered" | "failed" | "disabled" | "unknown">("");
const INTRO_BADGE: Record<string, { label: string; cls: string }> = {
  rendered: { label: "片头已生成", cls: "border-emerald-200 bg-emerald-50 text-emerald-700" },
  failed: { label: "片头生成失败·已跳过", cls: "border-amber-200 bg-amber-50 text-amber-700" },
  disabled: { label: "片头已关闭", cls: "border-gray-200 bg-gray-50 text-gray-500" },
};
const audioDuration = ref(0);
/** 配音成果（分步执行保留：渲染/重试直接复用，失败不重来） */
const audioMeta = ref<{ url: string; duration: number; format: string } | null>(null);
/** 当前配音产物所用的音色/语速：选择变更而未重配音时用于 stale 判定（防“选女声出男声”） */
const audioSettings = ref<{ voice: string; rate: number } | null>(null);
const audioStale = computed(
  () =>
    !!audioMeta.value &&
    !!audioSettings.value &&
    (audioSettings.value.voice !== voice.value || audioSettings.value.rate !== rate.value),
);
/** 音色展示名（stale 提示与配音完成文案用） */
function voiceName(id: string | undefined): string {
  if (!id) return "—";
  return voices.value.find((v) => v.id === id)?.name ?? id;
}

/* ── 停止支持：生成中可二次确认后中断在飞请求（AbortController → 步骤函数按 AbortError 区分停/失败） ── */
const stepAbort = ref<AbortController | null>(null);
const stopOpen = ref(false);
/** 并发起步守卫：同一时刻只允许一个在飞长请求（停止按钮只中断它） */
function beginAbort(): { signal: AbortSignal } {
  const ctl = new AbortController();
  stepAbort.value = ctl;
  return { signal: ctl.signal };
}
function endAbort(): void {
  stepAbort.value = null;
}
function confirmStop(): void {
  stepAbort.value?.abort();
}
/** 重置回全新创建（保留模板/主题/配音等表单设置，清空全部产物与步骤进度） */
function resetForNewVideo(): void {
  endAbort();
  step.value = "idle";
  activeStep.value = 0;
  errorMsg.value = "";
  title.value = "";
  segments.value = [];
  cards.value = [];
  questions.value = [];
  dtoId.value = "";
  dtoSnapshot.value = null;
  audioMeta.value = null;
  audioSettings.value = null;
  audioDuration.value = 0;
  videoUrl.value = "";
  introStatus.value = "";
  cancelEdit();
}
// 创建阶段同步到会话单例：供全站「新建视频」入口判断 busy（放弃确认）/ done（重新创建）
watch(
  step,
  (s) => {
    if (s === "generating" || s === "tts" || s === "rendering") setCreatePhase("busy");
    else if (s === "done") setCreatePhase("done");
    else setCreatePhase("idle");
  },
  { immediate: true },
);
onMounted(() => {
  registerCreateSession({ abort: () => stepAbort.value?.abort(), reset: resetForNewVideo });
});
onUnmounted(unregisterCreateSession);
/** 停止后的磁盘回收引导：服务端可能已落盘音频/视频产物 → 文件管理「清理无引用文件」一键回收 */
function stoppedToast(label: string): void {
  toast.info(label, {
    description:
      "服务端可能已产生未引用的音频/视频文件，可在「文件管理 → 清理无引用文件」一键回收磁盘",
    duration: 8000,
  });
}
/** 生成后原地编辑（PRD §10.1.3）：编辑标题/正文 → 保存 → 原地重渲染 */
const dtoId = ref("");
const editMode = ref(false);
const editTitle = ref("");
const editTexts = ref<string[]>([]);
/** word_card 编辑态 */
const editCards = ref<
  { word: string; pos: string; meaning: string; text: string; exampleMeaning: string }[]
>([]);
/** quiz 编辑态 */
const editQuestions = ref<
  { stem: string; options: string[]; correctIndex: number; explanation: string }[]
>([]);
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

/* ── 手机预览（原型 .preview-phone：实时展示生成结果） ── */
/** 原型 4 步步进器（向导式）：当前阶段由 step 状态映射为 done/current/todo 三态 */
const STEPS = ["内容设置", "AI 生成", "配音设置", "渲染确认"] as const;
type StepState = "done" | "current" | "todo";

/** 失败态按已有产物回退定位卡在哪一步（成果保留，不假装全部完成） */
function errorStates(): StepState[] {
  if (!dtoId.value) return ["done", "current", "todo", "todo"];
  if (!audioMeta.value) return ["done", "done", "current", "todo"];
  if (!videoUrl.value) return ["done", "done", "done", "current"];
  return ["done", "done", "done", "done"];
}

/** 步进器三态：已完成✓ / 进行中(当前待办) / 待办，与下方内容阶段一致 */
const stepStates = computed<StepState[]>(() => {
  switch (step.value) {
    case "generating":
      return ["done", "current", "todo", "todo"];
    case "generated":
    case "tts":
      return ["done", "done", "current", "todo"];
    case "audioReady":
    case "rendering":
      return ["done", "done", "done", "current"];
    case "done":
      return ["done", "done", "done", "done"];
    case "error":
      return errorStates();
    default:
      return ["current", "todo", "todo", "todo"];
  }
});
const stepStateClass: Record<StepState, string> = {
  done: "border-ok/40 bg-emerald-50 text-emerald-700",
  current: "border-brand bg-brand-soft text-brand",
  todo: "border-hairline bg-panel text-subtle",
};
/** 向导面板索引（用户点击导航）；流水线自动推进时跟随切换 */
const activeStep = ref(0);

/** 前进跳转前置校验（纯函数）：所需前序产物齐备返回 null，否则返回拦截原因 */
function stepBlocked(target: number): string | null {
  if (target <= 0) return null;
  if (!topic.value.trim()) return "请先填写/选择视频主题";
  if (target >= 2 && !dtoId.value) return "请先在 02 AI 生成 步骤生成内容";
  if (target >= 3 && !audioMeta.value) return "请先在 03 配音设置 完成配音";
  if (target >= 3 && audioStale.value) return "音色/语速已修改，请先重新配音再进入渲染";
  return null;
}

/** 步进器点击跳转：任何时候可回看；前进须过前置校验（缺失项 toast 播报） */
function goStep(i: number): void {
  const blocked = stepBlocked(i);
  if (blocked) {
    toast.warning(blocked);
    return;
  }
  activeStep.value = i;
}

/** 面板内「下一步」按钮 */
function nextStep(): void {
  goStep(activeStep.value + 1);
}

interface PreviewPiece {
  text: string;
  hl: boolean;
}

/** 正文按重点词切分（不区分大小写，长词优先避免短词截断） */
function highlightText(text: string, words: string[]): PreviewPiece[] {
  const unique = [...new Set(words.filter(Boolean))].sort((a, b) => b.length - a.length);
  if (unique.length === 0) return [{ text, hl: false }];
  const pattern = unique.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const parts = text.split(new RegExp(`(${pattern})`, "gi")).filter(Boolean);
  return parts.map((part) => ({
    text: part,
    hl: unique.some((w) => w.toLowerCase() === part.toLowerCase()),
  }));
}

/** 预览正文全量段落（与成片一致：scene_word 单画面展示全部段落 + 重点词高亮） */
const previewStory = computed(() =>
  segments.value.map((s) =>
    highlightText(
      s.text,
      s.words.map((w) => w.word),
    ),
  ),
);
/** 正文字号档位同源：镜像 renderer 口径（高亮词包 <mark></mark> 共 13 字符，段间空行 2 字符） */
const previewStoryHtmlLen = computed(() =>
  previewStory.value.reduce(
    (n, para, i) =>
      n + (i > 0 ? 2 : 0) + para.reduce((m, p) => m + p.text.length + (p.hl ? 13 : 0), 0),
    0,
  ),
);
const previewFontSize = computed(() => fitSceneWordFontSize(previewStoryHtmlLen.value));
/** 预览底部词汇汇总（成片展示全部重点词，不再截取前 3） */
const previewVocab = computed(() => allWords());

/** 展示用段落文本（只读模式） */
const segmentTexts = computed(() => segments.value.map((s) => s.text));

/** 卡片编辑器适配：编辑态 text 字段 ↔ 组件 example 字段（编辑态统一结构） */
const editCardsForEditor = computed<WordCard[]>({
  get: () =>
    editCards.value.map((c) => ({
      word: c.word,
      pos: c.pos,
      meaning: c.meaning,
      example: c.text,
      exampleMeaning: c.exampleMeaning,
    })),
  set: (v) => {
    editCards.value = v.map((c) => ({
      word: c.word,
      pos: c.pos,
      meaning: c.meaning,
      text: c.example,
      exampleMeaning: c.exampleMeaning ?? "",
    }));
  },
});

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
    toast.error(`主题推荐失败：${errorMsg.value}`);
  } finally {
    suggesting.value = false;
  }
}

function pickTopic(t: string): void {
  topic.value = t;
}

/** 进入编辑模式：按模板载入（scene_word 正文 / word_card 卡片 / quiz 题目） */
function startEdit(): void {
  editTitle.value = title.value;
  editTexts.value = segments.value.map((s) => s.text);
  editCards.value = cards.value.map((c) => ({
    word: c.word,
    pos: c.pos,
    meaning: c.meaning,
    text: c.example,
    exampleMeaning: c.exampleMeaning ?? "",
  }));
  editQuestions.value = questions.value.map((q) => ({
    stem: q.stem,
    options: [...q.options],
    correctIndex: q.correctIndex,
    explanation: q.explanation,
  }));
  editMode.value = true;
}

function cancelEdit(): void {
  editMode.value = false;
  editTitle.value = "";
  editTexts.value = [];
  editCards.value = [];
  editQuestions.value = [];
}

/** 按模板构建编辑后 content（scene_word / word_card / quiz） */
function buildEditedContent(): Record<string, unknown>[] | null {
  if (template.value === "word_card") {
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
  if (template.value === "quiz") {
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
    const originals = dtoSnapshot.value?.content;
    return editQuestions.value.map((q, i) => {
      const origWord = Array.isArray(originals)
        ? (originals[i] as { word?: unknown })?.word
        : undefined;
      // render 校验要求 word 为 WordInfo 对象；取不到原对象时从题干构造（renderer 不使用该字段内容）
      const word =
        origWord ??
        ({
          word: q.stem.split(" ")[0] ?? "word",
          meaning: "（未提供）",
          level: dtoSnapshot.value?.level ?? "CET4",
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
  if (editTexts.value.some((t) => !t.trim())) {
    errorMsg.value = "正文不能有空段";
    return null;
  }
  return segments.value.map((seg, i) => ({
    ...seg,
    text: editTexts.value[i] ?? seg.text,
  }));
}

/** 保存修改并原地重新渲染（PATCH 记录 → 重合成 → 重渲染 → 更新播放，三模板通用） */
async function saveEdit(): Promise<void> {
  const content = buildEditedContent();
  if (!content) return;
  saving.value = true;
  errorMsg.value = "";
  try {
    title.value = editTitle.value;
    if (template.value === "word_card") {
      cards.value = editCards.value.map((c) => ({
        word: c.word,
        pos: c.pos,
        meaning: c.meaning,
        example: c.text,
        exampleMeaning: c.exampleMeaning || undefined,
      }));
    } else if (template.value === "quiz") {
      questions.value = editQuestions.value.map((q) => ({ ...q, word: "" }));
    } else {
      segments.value = content as { text: string; words: { word: string; meaning: string }[] }[];
    }
    editMode.value = false;
    // 更新记录内容
    await updateTask(dtoId.value, { title: title.value, content });
    // 关键：同步快照，后续「重新配音/渲染视频」用新文案而非生成时的旧快照
    dtoSnapshot.value = { ...dtoSnapshot.value, title: title.value, content };
    // 重新配音 + 渲染（当前音色/语速/BGM，按模板）
    activeStep.value = 3;
    step.value = "rendering";
    const opts = beginAbort();
    const audio = await synthesizeFromContent(
      template.value,
      content,
      title.value,
      voice.value,
      rate.value,
      opts,
    );
    audioDuration.value = audio.duration;
    audioMeta.value = audio;
    audioSettings.value = { voice: voice.value, rate: rate.value };
    if (!dtoSnapshot.value) throw new Error("缺少渲染数据");
    const dtoWithAudio: RenderVideoInput = {
      ...dtoSnapshot.value,
      template: template.value,
      // 关键：渲染用编辑后的 content 覆盖快照旧值（否则画面仍是旧文案）
      content,
      audio,
      style: {
        ...((dtoSnapshot.value.style as Record<string, unknown> | undefined) ?? {}),
        bgm: bgm.value,
        introEffect: introEffect.value,
        introTopic: topic.value,
      },
    };
    const video = await renderVideo(dtoWithAudio, opts);
    const base = (import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080").replace(/\/$/, "");
    videoUrl.value = `${base}${video.url}`;
    introStatus.value = video.introStatus ?? "";
    await updateTask(dtoId.value, { audio, video, status: "completed" });
    step.value = "done";
    // 编辑重渲染同步保存策略（以当前表单选择为准）
    await persistAllowSave();
  } catch (err) {
    if (isAbortError(err)) {
      step.value = "done";
      stoppedToast("已停止保存重渲染，原成片与记录保持不变");
      return;
    }
    step.value = "error";
    errorMsg.value = err instanceof Error ? err.message : String(err);
    toast.error(`保存并重渲染失败：${errorMsg.value}`);
  } finally {
    endAbort();
    saving.value = false;
  }
}

/** 试听当前音色（合成固定试听文本并播放；切换音色时先停掉上一个） */
async function previewVoice(): Promise<void> {
  stopPreview(); // 上一个音色立即停止，避免叠加干扰
  previewing.value = true;
  errorMsg.value = "";
  try {
    const audio = await previewVoiceApi(voice.value, previewText);
    const base = (import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080").replace(/\/$/, "");
    playPreview("voice", `${base}${audio.url}`);
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
    toast.error(`试听失败：${errorMsg.value}`);
  } finally {
    previewing.value = false;
  }
}

/** 试听当前 BGM（本地素材直接播放；与音色试听共用单例，互斥播放） */
function previewBgm(): void {
  if (!bgm.value) return;
  const base = (import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080").replace(/\/$/, "");
  togglePreview("bgm", base + bgm.value);
}

/** 保存观众保存策略（失败不阻断主流程，可在发布管理补改） */
async function persistAllowSave(): Promise<void> {
  if (!dtoId.value) return;
  try {
    await updateVideoAnalytics(dtoId.value, { allowSave: allowSave.value });
  } catch (err) {
    toast.warning(
      `观众保存策略保存失败（${err instanceof Error ? err.message : "未知错误"}），可到发布管理修改`,
    );
  }
}

/** 结果卡内切换保存策略：未渲染仅改表单值（渲染时统一落库），已成片则即时回写 */
function onAllowSaveToggle(): void {
  if (step.value === "done") void persistAllowSave();
}

async function generateStep(): Promise<boolean> {
  activeStep.value = 1;
  step.value = "generating";
  errorMsg.value = "";
  const opts = beginAbort();
  try {
    const dto = await generateContent(
      {
        topic: topic.value,
        level: level.value,
        template: template.value,
      },
      opts,
    );
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
    audioSettings.value = null;
    videoUrl.value = "";
    step.value = "generated";
    return true;
  } catch (err) {
    if (isAbortError(err)) {
      step.value = "idle";
      stoppedToast("已停止生成，可重新发起");
      return false;
    }
    step.value = "error";
    errorMsg.value = err instanceof Error ? err.message : String(err);
    toast.error(`内容生成失败：${errorMsg.value}`);
    return false;
  } finally {
    endAbort();
  }
}

/** 生成配音（分步：内容已生成后独立执行；失败只重试本步，不重来） */
async function ttsStep(): Promise<boolean> {
  if (!dtoSnapshot.value) {
    errorMsg.value = "请先生成内容";
    return false;
  }
  activeStep.value = 2;
  step.value = "tts";
  errorMsg.value = "";
  const opts = beginAbort();
  try {
    const audio = await synthesizeFromContent(
      template.value,
      dtoSnapshot.value.content as Record<string, unknown>[],
      String(dtoSnapshot.value.title ?? ""),
      voice.value,
      rate.value,
      opts,
    );
    audioMeta.value = audio;
    audioSettings.value = { voice: voice.value, rate: rate.value };
    audioDuration.value = audio.duration;
    step.value = "audioReady";
    return true;
  } catch (err) {
    if (isAbortError(err)) {
      step.value = "generated";
      stoppedToast("已停止配音，可重新发起");
      return false;
    }
    step.value = "generated"; // 停在内容已生成态，可单独重试配音
    errorMsg.value = err instanceof Error ? err.message : String(err);
    toast.error(`配音生成失败：${errorMsg.value}`);
    return false;
  } finally {
    endAbort();
  }
}

/** 渲染视频（分步：配音完成后独立执行；失败只重试本步，配音成果保留） */
async function renderStep(): Promise<boolean> {
  if (!dtoSnapshot.value || !audioMeta.value) {
    errorMsg.value = "请先完成生成与配音";
    return false;
  }
  // 防“选女声出男声”：音色/语速改过但未重配音时禁止渲染旧音频，强制先回到配音步骤
  if (audioStale.value) {
    errorMsg.value = `当前配音仍是「${voiceName(audioSettings.value?.voice)}」的旧产物，与所选设置不一致，请先重新配音`;
    toast.warning(errorMsg.value);
    activeStep.value = 2;
    return false;
  }
  activeStep.value = 3;
  step.value = "rendering";
  errorMsg.value = "";
  const opts = beginAbort();
  try {
    // dtoSnapshot 为宽松 Record（生成响应快照），运行时有完整 ContentDTO 字段，类型按项目先例收窄
    const dtoWithAudio = {
      ...dtoSnapshot.value,
      template: template.value,
      audio: audioMeta.value,
      style: {
        ...((dtoSnapshot.value.style as Record<string, unknown> | undefined) ?? {}),
        bgm: bgm.value,
        introEffect: introEffect.value,
        introTopic: topic.value,
      },
    } as unknown as RenderInput;
    const video = await renderVideo(dtoWithAudio, opts);
    const base = (import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080").replace(/\/$/, "");
    videoUrl.value = `${base}${video.url}`;
    introStatus.value = video.introStatus ?? "";
    step.value = "done";
    // 回写生成记录（generate 已自动落库）：配音 + 视频 + 完成状态；失败可见（E2：不再静默假成功）
    try {
      await updateTask(dtoId.value, { audio: audioMeta.value, video, status: "completed" });
    } catch (err) {
      toast.error(
        `视频已生成，但记录回写失败（${err instanceof Error ? err.message : "未知错误"}），可到列表重试渲染`,
      );
    }
    // 回写观众保存策略（生成时选择 → video_analytics 落库，与发布管理/标记同源）
    await persistAllowSave();
    return true;
  } catch (err) {
    if (isAbortError(err)) {
      step.value = "audioReady";
      stoppedToast("已停止渲染，配音成果保留，可重新发起");
      return false;
    }
    step.value = "audioReady"; // 停在配音完成态，可单独重试渲染
    errorMsg.value = err instanceof Error ? err.message : String(err);
    toast.error(`视频渲染失败：${errorMsg.value}`);
    return false;
  } finally {
    endAbort();
  }
}
</script>

<template>
  <div class="px-7 pt-[26px] pb-12">
    <!-- Hero（原型 #create） -->
    <section class="mb-[22px]">
      <h1 class="mb-1.5 text-[26px] font-bold">新建视频</h1>
      <p class="text-subtle">从主题开始，让 AI 完成内容、配音与视频渲染。</p>
    </section>

    <!-- 步进器（向导：点击跳转+前置校验；完成/进行中/待办三态） -->
    <div class="mb-[18px] flex gap-2">
      <button
        v-for="(s, i) in STEPS"
        :key="s"
        type="button"
        class="flex-1 cursor-pointer rounded-xl border px-3 py-3 text-left transition-colors"
        :class="[stepStateClass[stepStates[i]], i === activeStep ? 'ring-2 ring-brand/35' : '']"
        :title="`点击跳转到「${s}」`"
        @click="goStep(i)"
      >
        <span v-if="stepStates[i] === 'done'" class="inline-flex items-center gap-1 text-[11px] font-semibold tracking-wide">
          <Check class="h-3.5 w-3.5" aria-hidden="true" /> 已完成
        </span>
        <span v-else-if="stepStates[i] === 'current'" class="inline-flex items-center gap-1 text-[11px] font-semibold tracking-wide">
          <i class="h-1.5 w-1.5 rounded-full bg-brand" aria-hidden="true" /> 进行中
        </span>
        <small v-else>0{{ i + 1 }}</small>
        <b class="mt-1 block text-[13px]">{{ s }}</b>
      </button>
    </div>

    <div class="grid grid-cols-[1.1fr_0.9fr] gap-[18px] max-xl:grid-cols-1">
      <!-- 左：向导面板（按步切换；步进器点击可跳转+前置校验） -->
      <div class="rounded-2xl border border-hairline bg-panel p-[18px]">
        <!-- 01 内容设置：模板 / 主题 / 等级 -->
        <div v-show="activeStep === 0">
        <h3 class="mb-3.5 font-bold">选择模板</h3>
        <div class="grid grid-cols-3 gap-2.5">
          <button
            v-for="t in TEMPLATE_OPTIONS"
            :key="t.id"
            type="button"
            class="cursor-pointer rounded-[13px] border p-3 text-left"
            :class="
              template === t.id
                ? 'border-brand bg-brand-soft shadow-[inset_0_0_0_2px_#ece9ff]'
                : 'border-hairline bg-white hover:bg-gray-50'
            "
            @click="template = t.id"
          >
            <span
              class="mb-2.5 grid h-[100px] place-items-center rounded-[10px] bg-gradient-to-br from-[#f2f0ff] to-[#eef2ff] text-brand"
              ><component :is="TEMPLATE_ICONS[t.id]" class="h-8 w-8" aria-hidden="true"
            /></span>
            <b class="block text-sm">{{ t.label }}</b>
            <span class="mt-1 block text-xs text-subtle">{{ t.desc }}</span>
          </button>
        </div>

        <!-- 视频主题：分组预设 + AI 推荐（按钮入主题框，与候选/预设同区零位移）+ 自定义输入 -->
        <div class="mb-4 mt-[18px]">
          <label class="mb-[7px] block text-[13px] font-bold" for="topic">视频主题</label>
          <div class="mb-3 space-y-2.5 rounded-xl border border-hairline bg-shell/70 p-3">
            <div class="flex items-center justify-between gap-2">
              <span class="text-[11px] font-medium tracking-wide text-subtle">预设主题 / AI 推荐</span>
              <button
                type="button"
                class="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-[10px] border border-brand/40 bg-brand-soft px-3 py-1.5 text-xs font-medium text-brand hover:bg-[#ece9ff] disabled:opacity-50"
                :disabled="suggesting"
                @click="suggest"
              >
                <span v-if="suggesting" class="inline-flex items-center gap-1.5">
                  <Spinner size="sm" /> 推荐中…
                </span>
                <span v-else class="inline-flex items-center gap-1.5">
                  <Sparkles class="h-3.5 w-3.5" aria-hidden="true" /> AI 推荐
                </span>
              </button>
            </div>
            <!-- AI 推荐候选就地展开（紧贴按钮下方，预设主题上方） -->
            <div
              v-if="suggesting || suggestedTopics.length > 0"
              class="rounded-lg border border-brand/30 bg-white p-2.5"
            >
              <p class="mb-1.5 text-[11px] font-medium tracking-wide text-brand">
                {{ suggesting ? "AI 推荐中，请稍候…" : "AI 推荐候选（点击选用）" }}
              </p>
              <div v-if="!suggesting" class="flex flex-wrap gap-1.5">
                <button
                  v-for="t in suggestedTopics"
                  :key="t.title"
                  type="button"
                  class="cursor-pointer rounded-full border px-2.5 py-1 text-xs"
                  :class="
                    topic === t.title
                      ? 'border-brand bg-brand-soft text-brand font-medium'
                      : 'border-hairline bg-white text-gray-600 hover:bg-gray-50'
                  "
                  :title="t.description"
                  @click="pickTopic(t.title)"
                >
                  {{ t.title }}
                </button>
              </div>
            </div>
            <div v-for="g in TOPIC_GROUPS" :key="g.label">
              <p class="mb-1.5 text-[11px] font-medium tracking-wide text-subtle">{{ g.label }}</p>
              <div class="flex flex-wrap gap-1.5">
                <button
                  v-for="p in g.topics"
                  :key="p"
                  type="button"
                  class="cursor-pointer rounded-full border px-2.5 py-1 text-xs"
                  :class="
                    topic === p
                      ? 'border-brand bg-brand-soft text-brand'
                      : 'border-hairline bg-white text-gray-600 hover:bg-gray-50'
                  "
                  @click="pickTopic(p)"
                >
                  {{ p }}
                </button>
              </div>
            </div>
          </div>
          <input
            id="topic"
            v-model="topic"
            class="w-full rounded-[10px] border border-hairline bg-white px-[11px] py-2.5 focus:border-brand focus:outline-none"
            placeholder="点选上方主题，或自定义输入，也可点 AI 推荐"
            maxlength="50"
          />
        </div>

        <!-- 词汇等级（目标时长选项已移除：生成链路无时长收敛机制，无法保证误差 ≤5s，2026-09-21 评审决策） -->
        <div class="mb-4">
          <label class="mb-[7px] block text-[13px] font-bold">词汇等级</label>
          <select
            v-model="level"
            class="w-full cursor-pointer rounded-[10px] border border-hairline bg-white px-[11px] py-2.5 focus:border-brand focus:outline-none"
          >
            <option value="CET4">CET4 四级</option>
            <option value="CET6">CET6 六级</option>
          </select>
        </div>
        <div class="flex items-center justify-between">
          <span class="text-xs text-subtle">模板、主题与等级在此设置</span>
          <button
            type="button"
            class="cursor-pointer rounded-[10px] border border-brand bg-brand px-4 py-2 text-sm font-medium text-white hover:opacity-90"
            @click="nextStep"
          >
            下一步：AI 生成 →
          </button>
        </div>
        </div>

        <!-- 02 AI 生成：触发/进度（正文与编辑在下方「生成结果」区） -->
        <div v-show="activeStep === 1">
          <div class="flex flex-wrap items-center gap-3">
            <button
              type="button"
              class="inline-flex cursor-pointer items-center gap-1.5 rounded-[10px] border border-brand bg-brand px-4 py-2.5 font-medium text-white transition hover:opacity-90 disabled:opacity-50"
              :disabled="step === 'generating'"
              @click="generateStep"
            >
              <Spinner v-if="step === 'generating'" size="sm" />
              <Sparkles v-else class="h-4 w-4" aria-hidden="true" />
              {{ step === "generating" ? "生成中…" : dtoId ? "重新生成内容" : "AI 生成内容" }}
            </button>
            <button
              v-if="step === 'generating'"
              type="button"
              class="cursor-pointer rounded-[10px] border border-red-200 bg-white px-4 py-2.5 font-medium text-bad transition hover:bg-red-50"
              @click="stopOpen = true"
            >
              ■ 停止
            </button>
            <span v-if="step !== 'idle'" class="text-sm text-subtle">{{ stepLabel[step] }}</span>
          </div>
          <p class="mt-3 text-xs text-subtle">
            本地模型生成故事正文并过词库验收；LLM 未就绪时可点顶栏「启动」唤醒。
          </p>
          <div class="mt-4 flex items-center justify-between">
            <button
              type="button"
              class="cursor-pointer rounded-[10px] border border-hairline bg-white px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
              @click="goStep(0)"
            >
              ← 返回内容设置
            </button>
            <button
              type="button"
              class="cursor-pointer rounded-[10px] border border-brand bg-brand px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
              :disabled="!dtoId"
              @click="nextStep"
            >
              下一步：配音设置 →
            </button>
          </div>
        </div>

        <!-- 03 配音设置：音色/语速/BGM/片头 + 配音动作 -->
        <div v-show="activeStep === 2">
        <!-- 音色 / 背景音乐（含试听） -->
        <div class="grid grid-cols-2 gap-3">
          <div class="mb-4">
            <label class="mb-[7px] block text-[13px] font-bold" for="voice">音色</label>
            <div class="flex gap-2">
              <select
                id="voice"
                v-model="voice"
                class="w-full cursor-pointer rounded-[10px] border border-hairline bg-white px-[11px] py-2.5 focus:border-brand focus:outline-none"
              >
                <option v-for="v in voices" :key="v.id" :value="v.id">{{ v.name }}</option>
              </select>
              <button
                type="button"
                class="shrink-0 cursor-pointer rounded-[10px] border border-hairline bg-white px-3 text-sm hover:bg-gray-50 disabled:opacity-50"
                :disabled="previewing"
                @click="isPlaying('voice') ? stopPreview() : previewVoice()"
              >
                <span class="inline-flex items-center gap-1.5">
                  <Pause v-if="isPlaying('voice')" class="h-3.5 w-3.5" aria-hidden="true" />
                  <Volume2 v-else class="h-3.5 w-3.5" aria-hidden="true" />
                  {{ previewing ? "试听中…" : isPlaying("voice") ? "暂停" : "试听" }}
                </span>
              </button>
            </div>
            <div class="mt-2 flex flex-wrap items-center gap-2">
              <span class="text-xs text-subtle">语速</span>
              <button
                v-for="r in RATE_OPTIONS"
                :key="r.value"
                type="button"
                class="cursor-pointer rounded-full border px-3 py-0.5 text-xs"
                :class="
                  rate === r.value
                    ? 'border-brand bg-brand-soft text-brand'
                    : 'border-hairline text-gray-600 hover:bg-gray-50'
                "
                @click="rate = r.value"
              >
                {{ r.label }}
              </button>
            </div>
          </div>
          <div class="mb-4">
            <label class="mb-[7px] block text-[13px] font-bold">背景音乐</label>
            <div class="flex gap-2">
              <select
                v-model="bgm"
                class="w-full cursor-pointer rounded-[10px] border border-hairline bg-white px-[11px] py-2.5 focus:border-brand focus:outline-none"
              >
                <option value="">无 BGM</option>
                <option v-for="b in bgmFiles" :key="b.filename" :value="`/files/bgm/${b.filename}`">
                  {{ b.filename }}
                </option>
              </select>
              <button
                type="button"
                class="shrink-0 cursor-pointer rounded-[10px] border border-hairline bg-white px-3 text-sm hover:bg-gray-50 disabled:opacity-50"
                :disabled="!bgm"
                @click="previewBgm"
              >
                <span class="inline-flex items-center gap-1.5">
                  <Pause v-if="isPlaying('bgm')" class="h-3.5 w-3.5" aria-hidden="true" />
                  <Volume2 v-else class="h-3.5 w-3.5" aria-hidden="true" />
                  {{ isPlaying("bgm") ? "暂停" : "试听" }}
                </span>
              </button>
            </div>
            <label class="mt-2 block cursor-pointer items-center gap-1.5 text-xs text-gray-600">
              <input v-model="allowSave" type="checkbox" class="mr-1.5 rounded border-gray-300" />
              允许观众保存视频（渲染后生效，可在发布管理修改）
            </label>
          </div>
        </div>
        <p class="mb-3 text-xs text-subtle">生成后可改，重新配音/渲染时生效</p>
        <div class="flex flex-wrap items-center gap-3">
          <button
            type="button"
            class="inline-flex cursor-pointer items-center gap-1.5 rounded-[10px] border border-brand bg-brand px-4 py-2.5 font-medium text-white transition hover:opacity-90 disabled:opacity-50"
            :disabled="step === 'tts' || !dtoId"
            @click="ttsStep"
          >
            <Spinner v-if="step === 'tts'" size="sm" />
            {{ step === "tts" ? "配音生成中…" : audioStale ? "重新配音（设置已改）" : audioMeta ? "重新配音" : "生成配音" }}
          </button>
          <button
            v-if="step === 'tts'"
            type="button"
            class="cursor-pointer rounded-[10px] border border-red-200 bg-white px-4 py-2.5 font-medium text-bad transition hover:bg-red-50"
            @click="stopOpen = true"
          >
            ■ 停止
          </button>
          <span v-if="audioMeta" class="text-sm text-subtle">
            配音完成 · {{ audioDuration.toFixed(1) }}s（{{ voiceName(audioSettings?.voice) }}）
          </span>
        </div>
        <!-- 音色/语速改过未重配音：明确告知旧产物归属，渲染前必须重新配音 -->
        <p v-if="audioStale" class="mt-2 text-xs text-amber-700">
          音色/语速已改为「{{ voiceName(voice) }}」，现有配音仍是「{{
            voiceName(audioSettings?.voice)
          }}」的旧产物，请重新配音后再进入渲染。
        </p>
        <div class="mt-4 flex items-center justify-between">
          <button
            type="button"
            class="cursor-pointer rounded-[10px] border border-hairline bg-white px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
            @click="goStep(1)"
          >
            ← 返回 AI 生成
          </button>
          <button
            type="button"
            class="cursor-pointer rounded-[10px] border border-brand bg-brand px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
            :disabled="!audioMeta"
            @click="nextStep"
          >
            下一步：渲染确认 →
          </button>
        </div>
        </div>

        <!-- 04 渲染确认：渲染动作 + 保存策略 + 成片播放 -->
        <div v-show="activeStep === 3">
          <div class="flex flex-wrap items-center gap-3">
            <button
              type="button"
              class="inline-flex cursor-pointer items-center gap-1.5 rounded-[10px] border border-brand bg-brand px-4 py-2.5 font-medium text-white transition hover:opacity-90 disabled:opacity-50"
              :disabled="step === 'rendering' || !audioMeta || audioStale"
              @click="renderStep"
            >
              <Spinner v-if="step === 'rendering'" size="sm" />
              {{ step === "rendering" ? "渲染中…" : videoUrl ? "重新渲染" : "渲染视频" }}
            </button>
            <button
              v-if="step === 'rendering'"
              type="button"
              class="cursor-pointer rounded-[10px] border border-red-200 bg-white px-4 py-2.5 font-medium text-bad transition hover:bg-red-50"
              @click="stopOpen = true"
            >
              ■ 停止
            </button>
            <span v-if="step === 'rendering'" class="text-sm text-subtle">Playwright + FFmpeg 合成中…</span>
          </div>
          <p v-if="audioStale" class="mt-2 text-xs text-amber-700">
            音色/语速与现有配音不一致，请先返回上一步重新配音（防成片用错声音）。
          </p>
          <!-- Three.js 片头开关：渲染类选项，归位在渲染确认面板（仅 scene_word） -->
          <label
            v-if="template === 'scene_word'"
            class="mt-3 flex w-fit cursor-pointer items-center gap-1.5 text-xs text-gray-600"
          >
            <input v-model="introEffect" type="checkbox" class="rounded border-gray-300" />
            Three.js 主题片头（约 1 秒，暂无声，渲染时生效）
          </label>
          <!-- 保存策略回显：成片后切换即时回写（与发布管理/标记同源） -->
          <label class="mt-3 inline-flex cursor-pointer items-center gap-1 text-xs text-gray-600">
            <input
              v-model="allowSave"
              type="checkbox"
              class="mr-1.5 rounded border-gray-300"
              @change="onAllowSaveToggle"
            />
            观众保存策略：
            <b :class="allowSave ? 'text-emerald-700' : 'text-gray-500'">{{
              allowSave ? "允许保存" : "禁止保存"
            }}</b>
            <span class="ml-1 text-subtle">{{ step === "done" ? "已生效 · 修改即时保存" : "渲染后生效" }}</span>
          </label>
          <p v-if="!audioMeta" class="mt-3 rounded-lg bg-gray-50 p-3 text-center text-sm text-gray-400">
            配音尚未完成，请先在 03 配音设置 生成配音
          </p>
          <div class="mt-4 flex items-center justify-between">
            <button
              type="button"
              class="cursor-pointer rounded-[10px] border border-hairline bg-white px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
              @click="goStep(2)"
            >
              ← 返回配音设置
            </button>
            <span v-if="videoUrl" class="text-xs text-subtle">成片已生成，下方可播放确认</span>
          </div>
        </div>
      </div>

      <!-- 右：手机预览（原型 .preview-phone 9:16） -->
      <div class="self-start rounded-2xl border border-hairline bg-panel p-[18px]">
        <div class="mb-3 flex items-center justify-between">
          <h2 class="text-[17px] font-bold">视频预览</h2>
          <span class="text-xs text-subtle">成片帧等比缩放 · 1080×1920</span>
        </div>
        <!-- 真实渲染帧 1080×1920 画布按 290/1080 等比缩小：布局/字号/高亮与 renderer 模板同源，所见即所得 -->
        <div class="mx-auto w-[310px] rounded-[30px] bg-[#0f1117] p-2.5 shadow-[0_20px_60px_rgba(20,20,40,0.18)]">
          <div class="h-[515.6px] w-[290px] overflow-hidden rounded-[22px] bg-white">
            <div class="pv-canvas">
              <!-- scene_word：复刻 renderer/templates/scene-word.html -->
              <div v-if="template === 'scene_word'" class="pv-sw">
                <div class="pv-sw-title">{{ title || topic || "视频标题" }}</div>
                <div class="pv-sw-story" :style="{ fontSize: `${previewFontSize}px` }">
                  <p v-for="(para, i) in previewStory" :key="i">
                    <span v-for="(piece, j) in para" :key="j" :class="piece.hl ? 'pv-sw-mark' : ''">{{
                      piece.text
                    }}</span>
                  </p>
                  <p v-if="previewStory.length === 0" class="pv-placeholder">
                    生成后这里会展示故事正文与重点词高亮。
                  </p>
                </div>
                <div v-if="previewVocab.length > 0" class="pv-sw-summary">
                  <div class="pv-sw-summary-title">本期词汇</div>
                  <div class="pv-sw-summary-words">
                    <span v-for="w in previewVocab" :key="w.word" class="pv-sw-item">
                      <b class="pv-sw-item-word">{{ w.word }}</b>
                      <span>{{ w.meaning }}</span>
                    </span>
                  </div>
                </div>
              </div>
              <!-- word_card：复刻 renderer/templates/word-card.html（首帧：第一张卡） -->
              <div v-else-if="template === 'word_card'" class="pv-wc">
                <div v-if="cardViews.length > 0" class="pv-wc-card">
                  <div class="pv-wc-word">{{ cardViews[0]?.word }}</div>
                  <div v-if="cardViews[0]?.pos" class="pv-wc-pos">{{ cardViews[0]?.pos }}</div>
                  <div class="pv-wc-meaning">{{ cardViews[0]?.meaning }}</div>
                  <div v-if="cardViews[0]?.example" class="pv-wc-example">
                    {{ cardViews[0]?.example }}
                  </div>
                  <div v-if="cardViews[0]?.exampleMeaning" class="pv-wc-example-meaning">
                    {{ cardViews[0]?.exampleMeaning }}
                  </div>
                </div>
                <p v-else class="pv-placeholder">生成后这里会展示单词卡片。</p>
              </div>
              <!-- quiz：复刻 renderer/templates/quiz.html（首帧：第一题） -->
              <div v-else class="pv-qz">
                <template v-if="questions.length > 0">
                  <div class="pv-qz-stem">{{ questions[0]?.stem }}</div>
                  <div class="pv-qz-options">
                    <div
                      v-for="(o, i) in questions[0]?.options ?? []"
                      :key="i"
                      class="pv-qz-option"
                      :class="i === questions[0]?.correctIndex ? 'pv-qz-option--correct' : ''"
                    >
                      {{ String.fromCharCode(65 + i) }}. {{ o }}
                    </div>
                  </div>
                  <div v-if="questions[0]?.explanation" class="pv-qz-expl">
                    {{ questions[0]?.explanation }}
                  </div>
                </template>
                <p v-else class="pv-placeholder">生成后这里会展示题干与选项。</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 错误（常驻回显：不绑 step 状态，配音/渲染失败回退中间态时也能看到；即时播报走 toast） -->
    <div v-if="errorMsg" class="mb-6 mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
      {{ errorMsg }}
    </div>

    <!-- 停止二次确认（防误触打断在飞任务；确认后中断请求并回退到可重试态） -->
    <ConfirmDialog
      v-model:open="stopOpen"
      title="停止当前生成？"
      description="中断后本页进度保留，可重新发起；服务端已产生的音频/视频文件不自动回收，可到「文件管理 → 清理无引用文件」删除以释放磁盘。"
      confirm-text="停止"
      destructive
      @confirm="confirmStop"
    />

    <!-- 生成结果（向导 02 面板的内容区：正文展示 + 原地编辑） -->
    <div
      v-if="activeStep === 1 && (step === 'generated' || step === 'tts' || step === 'audioReady' || step === 'rendering' || step === 'done')"
      class="mb-6 mt-4 rounded-2xl border border-hairline bg-panel p-6"
    >
      <!-- 审核修改（PRD §10.1.3）：生成后原地编辑，无需跳转 -->
      <div class="mb-3 flex items-center justify-between gap-3">
        <div class="flex min-w-0 flex-col gap-1.5">
          <input
            v-if="editMode"
            v-model="editTitle"
            class="w-full rounded-[10px] border border-hairline bg-white px-3 py-2 text-lg font-semibold focus:border-brand focus:outline-none"
            maxlength="255"
          />
          <h2 v-else class="text-lg font-semibold">《{{ title }}》</h2>
        </div>
        <button
          v-if="step === 'done' && !editMode"
          class="shrink-0 cursor-pointer rounded-[10px] border border-hairline bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
          @click="startEdit"
        >
          <span class="inline-flex items-center gap-1"><Pencil class="h-3.5 w-3.5" aria-hidden="true" /> 编辑</span>
        </button>
      </div>
      <div class="mb-4 space-y-3">
        <SegmentEditor
          :texts="editMode ? editTexts : segmentTexts"
          :edit-mode="editMode"
          @update:texts="editTexts = $event"
        />
      </div>
      <!-- quiz 结果（编辑态输入） -->
      <QuizEditor
        v-if="template === 'quiz'"
        :questions="editMode ? editQuestions : questions"
        :edit-mode="editMode"
        @update:questions="editQuestions = $event"
      />
      <!-- word_card 结果（编辑态输入） -->
      <CardEditor
        v-if="template === 'word_card'"
        :cards="editMode ? editCardsForEditor : cardViews"
        :edit-mode="editMode"
        @update:cards="editCardsForEditor = $event"
      />
      <WordChips :words="allWords()" />
      <p v-if="(step === 'done' || step === 'audioReady') && audioDuration" class="mt-3 text-xs text-gray-400">
        配音 {{ audioDuration.toFixed(1) }}s
      </p>
      <!-- 编辑操作 -->
      <div v-if="editMode" class="mt-4 flex items-center gap-3">
        <button
          class="inline-flex cursor-pointer items-center gap-1.5 rounded-[10px] border border-brand bg-brand px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          :disabled="saving"
          @click="saveEdit"
        >
          <Spinner v-if="saving" size="sm" />
          {{ saving ? "保存并重新配音渲染中…" : "保存修改并重新渲染" }}
        </button>
        <button class="cursor-pointer rounded-[10px] border border-hairline bg-white px-4 py-2 text-sm hover:bg-gray-50" :disabled="saving" @click="cancelEdit">
          取消
        </button>
        <span class="text-xs text-subtle">保存后原地重新配音（当前音色）并重渲染视频</span>
      </div>
    </div>

    <!-- 视频播放（向导 04 渲染确认的内容区；手机端收窄居中） -->
    <div v-if="activeStep === 3 && videoUrl" class="rounded-2xl border border-hairline bg-panel px-8 py-6 sm:px-12">
      <div class="flex justify-center">
        <video
          :src="videoUrl"
          controls
          class="max-h-[70vh] w-full max-w-[240px] rounded-xl bg-black sm:max-w-[280px]"
        />
      </div>
      <p class="mt-3 break-all text-center text-xs text-gray-500">{{ videoUrl }}</p>
      <div v-if="introStatus && INTRO_BADGE[introStatus]" class="mt-3 flex justify-center">
        <span
          role="status"
          class="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs"
          :class="INTRO_BADGE[introStatus]?.cls"
        >
          <component
            :is="introStatus === 'rendered' ? Check : introStatus === 'failed' ? TriangleAlert : Circle"
            class="h-3.5 w-3.5"
            aria-hidden="true"
          />{{ INTRO_BADGE[introStatus]?.label }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 手机预览 = 成片帧等比缩小：画布固定 1080×1920（渲染器视口），按 290/1080 缩放到预览屏。
   下方数值与 packages/backend/src/renderer/templates/*.html 逐值对齐，改模板必须同步这里。 */
.pv-canvas {
  width: 1080px;
  height: 1920px;
  transform: scale(0.26852);
  transform-origin: top left;
  background: #ffffff;
  font-family: "PingFang SC", "Microsoft YaHei", sans-serif;
}
.pv-placeholder {
  font-size: 34px;
  color: #9ca3af;
}

/* scene-word.html：正文单画面全量展示，字号随文本量自适应（fitSceneWordFontSize） */
.pv-sw {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  padding: 110px 160px 120px;
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
}
.pv-sw-title {
  font-size: 34px;
  font-weight: 700;
  color: #1f2937;
  margin-bottom: 48px;
}
.pv-sw-story {
  line-height: 1.8;
  color: #111827;
  word-break: break-word;
  letter-spacing: 0.5px;
  margin-bottom: 44px;
  flex: 1 1 auto;
  overflow: hidden;
}
.pv-sw-story p {
  margin-bottom: 0.6em;
}
.pv-sw-story p:last-child {
  margin-bottom: 0;
}
.pv-sw-mark {
  background: #fbbf24;
  font-weight: 700;
  color: #111827;
  padding: 0 8px;
  border-radius: 8px;
}
.pv-sw-summary {
  background: #f3f4f6;
  border-radius: 20px;
  padding: 32px 40px;
}
.pv-sw-summary-title {
  font-size: 28px;
  font-weight: 700;
  color: #374151;
  margin-bottom: 24px;
}
.pv-sw-summary-words {
  display: flex;
  flex-wrap: wrap;
  gap: 20px 48px;
}
.pv-sw-item {
  font-size: 30px;
  color: #111827;
  line-height: 1.5;
}
.pv-sw-item-word {
  font-weight: 700;
  margin-right: 12px;
}

/* word-card.html：居中单卡（预览展示首张，成片逐卡成帧） */
.pv-wc {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  padding: 120px 160px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.pv-wc-card {
  width: 100%;
  background: #ffffff;
  border: 2px solid #e5e7eb;
  border-radius: 32px;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.08);
  padding: 120px 100px;
  box-sizing: border-box;
}
.pv-wc-word {
  font-size: 84px;
  font-weight: 800;
  color: #111827;
  text-align: center;
}
.pv-wc-pos {
  font-size: 32px;
  color: #6b7280;
  text-align: center;
  margin-top: 24px;
}
.pv-wc-meaning {
  font-size: 44px;
  color: #374151;
  text-align: center;
  margin-top: 56px;
  line-height: 1.6;
}
.pv-wc-example {
  font-size: 38px;
  color: #111827;
  margin-top: 80px;
  line-height: 1.6;
}
.pv-wc-example-meaning {
  font-size: 32px;
  color: #6b7280;
  margin-top: 16px;
  line-height: 1.6;
}

/* quiz.html：题干 + 选项（正确项高亮）+ 解析（预览展示首题） */
.pv-qz {
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  padding: 120px 160px;
  display: flex;
  flex-direction: column;
  justify-content: center;
}
.pv-qz-stem {
  font-size: 46px;
  font-weight: 700;
  color: #111827;
  line-height: 1.5;
  margin-bottom: 80px;
}
.pv-qz-options {
  display: flex;
  flex-direction: column;
  gap: 32px;
}
.pv-qz-option {
  font-size: 38px;
  color: #374151;
  line-height: 1.5;
  padding: 28px 36px;
  border: 2px solid #e5e7eb;
  border-radius: 16px;
}
.pv-qz-option--correct {
  border-color: #16a34a;
  background: #f0fdf4;
  color: #15803d;
  font-weight: 700;
}
.pv-qz-expl {
  margin-top: 80px;
  font-size: 32px;
  color: #6b7280;
  line-height: 1.6;
}
</style>
