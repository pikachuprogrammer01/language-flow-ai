<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  type VideoAnalytics,
  getTask,
  getVideoAnalytics,
  getVideoAnalyticsBatch,
  listAllTasks,
  listFiles,
  type listTasks,
  listVoices,
  updateVideoAnalytics,
} from "../api/client";
import { buildCopyLines } from "../lib/analytics-copy";
import {
  type AnalyticsCustomField,
  type AnalyticsMeta,
  SAVE_STATE_LABEL,
  type SaveState,
  mergeServerAnalyticsMeta,
  pendingSaveIds,
  publishTitleOf,
  reconcileSelectedId,
  safeWriteStorage,
  scheduleDebouncedSave,
  shouldApplyServer,
  updateAnalyticsMeta,
} from "../lib/analytics-state";

type Task = Awaited<ReturnType<typeof listTasks>>["tasks"][number];

const STORAGE_KEY = "language-flow-video-analytics-v2";
const loading = ref(true);
const detailLoading = ref(false);
const errorMsg = ref("");
const tasks = ref<Task[]>([]);
/** 服务端总行数：KPI 用它而非已加载条数，否则列表被截断时数字仍然「看起来正常」 */
const serverTotal = ref(0);
const selectedId = ref("");
const metadata = ref<Record<string, AnalyticsMeta>>({});
const hydratedIds = ref(new Set<string>());
const draftField = ref({ label: "", type: "text" as "text" | "image", value: "" });
const requestVersion = ref(0);
const loadVersion = ref(0);
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const saveVersions = new Map<string, number>();
/** 每条记录持久化状态（DS1：保存中/已保存/失败可见） */
const saveStates = ref<Record<string, SaveState>>({});
/** 音色/BGM 下拉选项（DS3：复用规范目录端点，不再自由文本） */
const voiceOptions = ref<{ id: string; name: string }[]>([]);
const bgmOptions = ref<string[]>([]);

function localDateTime(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 16);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function defaultMeta(task: Task): AnalyticsMeta {
  return {
    /** 空 = 未覆盖，标题跟随生成后的 contents.title（见 titleOf） */
    storyTopic: "",
    cover: "",
    voice: "",
    bgm: "",
    publishAt: localDateTime(task.createdAt),
    allowSave: false,
    customFields: [],
  };
}

/** 发布标题：显式覆盖优先，否则跟随生成标题（规则在 lib/analytics-state 与单测共用） */
function titleOf(task: Task): string {
  return publishTitleOf(task, metaFor(task).storyTopic);
}

function metaFor(task: Task): AnalyticsMeta {
  const fallback = defaultMeta(task);
  const existing = metadata.value[task.id];
  if (!existing) return fallback;
  return {
    ...fallback,
    ...existing,
    customFields: Array.isArray(existing.customFields) ? existing.customFields : [],
  };
}

function persist(): void {
  safeWriteStorage(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(metadata.value)));
}

function setSaveState(id: string, state: SaveState): void {
  saveStates.value = { ...saveStates.value, [id]: state };
}

function readStored(): void {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object") return;
    metadata.value = parsed as Record<string, AnalyticsMeta>;
  } catch {
    metadata.value = {};
  }
}

function updateMeta(task: Task, patch: Partial<AnalyticsMeta>): void {
  metadata.value = updateAnalyticsMeta(metadata.value, task.id, defaultMeta(task), patch);
  saveVersions.set(task.id, (saveVersions.get(task.id) ?? 0) + 1);
  setSaveState(task.id, "dirty");
  persist();
  scheduleSave(task);
}

async function saveServer(task: Task): Promise<void> {
  const meta = metaFor(task);
  const version = saveVersions.get(task.id) ?? 0;
  setSaveState(task.id, "saving");
  try {
    const saved = await updateVideoAnalytics(task.id, {
      storyTopic: meta.storyTopic || null,
      coverUrl: meta.cover || null,
      publishAt: meta.publishAt ? new Date(meta.publishAt).toISOString() : null,
      allowSave: meta.allowSave,
      voice: meta.voice || undefined,
      bgm: meta.bgm || null,
      customParams: meta.customFields,
    });
    if (saveVersions.get(task.id) === version) {
      applyServer(task, saved, true);
      setSaveState(task.id, "saved");
    }
  } catch {
    // 失败可见：本地草稿保留（DS1），状态置 failed（面板显式提示可重试）
    setSaveState(task.id, "failed");
  }
}

function scheduleSave(task: Task): void {
  scheduleDebouncedSave(saveTimers, task.id, () => {
    saveTimers.delete(task.id);
    void saveServer(task);
  });
}

async function flushSave(id: string): Promise<void> {
  const timer = saveTimers.get(id);
  if (!timer) return;
  clearTimeout(timer);
  saveTimers.delete(id);
  const task = tasks.value.find((item) => item.id === id);
  if (task) await saveServer(task);
}

function applyServer(task: Task, saved: VideoAnalytics, force = false): void {
  // 非强制回显且本地为未保存草稿 → 保留草稿不覆盖（E6）
  if (!force && !shouldApplyServer(saveStates.value[task.id])) {
    hydratedIds.value = new Set(hydratedIds.value).add(task.id);
    return;
  }
  const local = metadata.value[task.id] ?? defaultMeta(task);
  metadata.value = {
    ...metadata.value,
    [task.id]: mergeServerAnalyticsMeta(local, {
      ...saved,
      publishAt: localDateTime(saved.publishAt),
      customParams: saved.customParams ?? [],
    }),
  };
  hydratedIds.value = new Set(hydratedIds.value).add(task.id);
  persist();
}

async function loadServer(task: Task): Promise<void> {
  const version = ++requestVersion.value;
  detailLoading.value = true;
  try {
    const saved = await getVideoAnalytics(task.id);
    if (version === requestVersion.value) applyServer(task, saved);
  } catch {
    // 本地草稿/默认值仍可见可编辑（DS1：水合失败不锁死编辑器）
  } finally {
    if (version === requestVersion.value) detailLoading.value = false;
  }
}

/** 卸载/切页前 flush 全部待发任务（E7：原仅 flush 选中项，其余 timer 丢失） */
function flushAllPending(): void {
  for (const id of pendingSaveIds(saveTimers, (x) => saveStates.value[x])) {
    const timer = saveTimers.get(id);
    if (timer) clearTimeout(timer);
    saveTimers.delete(id);
    const task = tasks.value.find((item) => item.id === id);
    if (task) void saveServer(task);
  }
}

function addField(): void {
  const task = selectedTask.value;
  const label = draftField.value.label.trim();
  if (!task || !label) return;
  const field: AnalyticsCustomField = {
    key: crypto.randomUUID(),
    label,
    type: draftField.value.type,
    value: draftField.value.value,
  };
  updateMeta(task, { customFields: [...metaFor(task).customFields, field] });
  draftField.value = { label: "", type: "text", value: "" };
}

function removeField(key: string): void {
  const task = selectedTask.value;
  if (!task) return;
  updateMeta(task, {
    customFields: metaFor(task).customFields.filter((field) => field.key !== key),
  });
}

function durationOf(task: Task): number {
  const value = task.video ?? task.audio;
  if (!value || typeof value !== "object" || !("duration" in value)) return 0;
  return Number((value as { duration?: unknown }).duration ?? 0);
}

const selectedTask = computed(
  () => tasks.value.find((task) => task.id === selectedId.value) ?? tasks.value[0],
);
const selectedMeta = computed(() => (selectedTask.value ? metaFor(selectedTask.value) : null));

/* ── 视频文案（选中行懒加载完整 DTO，缓存不重复拉） ── */
const copies = ref<Record<string, string[]>>({});
const copyLoading = ref(false);

async function loadCopy(id: string): Promise<void> {
  if (!id || copies.value[id]) return;
  copyLoading.value = true;
  try {
    const dto = await getTask(id);
    copies.value = { ...copies.value, [id]: buildCopyLines(String(dto.template), dto.content) };
  } catch {
    copies.value = { ...copies.value, [id]: [] }; // 失败可见：面板展示无文案占位
  } finally {
    copyLoading.value = false;
  }
}

const selectedCopy = computed<string[] | null>(() => {
  const id = selectedTask.value?.id;
  return id ? (copies.value[id] ?? null) : null;
});
const totalDuration = computed(() => tasks.value.reduce((sum, task) => sum + durationOf(task), 0));
const completedCount = computed(
  () => tasks.value.filter((task) => task.status === "completed").length,
);

async function load(): Promise<void> {
  const version = ++loadVersion.value;
  if (selectedId.value) await flushSave(selectedId.value);
  loading.value = true;
  errorMsg.value = "";
  try {
    const result = await listAllTasks();
    if (version !== loadVersion.value) return;
    tasks.value = result.tasks;
    serverTotal.value = result.total;
    hydratedIds.value = new Set();
    selectedId.value = reconcileSelectedId(
      tasks.value.map((task) => task.id),
      selectedId.value,
    );
    if (tasks.value.length === 0) {
      detailLoading.value = false;
      return;
    }

    detailLoading.value = true;
    const saved = await getVideoAnalyticsBatch(tasks.value.map((task) => task.id));
    if (version !== loadVersion.value) return;
    const taskById = new Map(tasks.value.map((task) => [task.id, task]));
    for (const item of saved) {
      const task = taskById.get(item.contentId);
      if (task) applyServer(task, item);
    }
    detailLoading.value = false;
  } catch (error) {
    if (version === loadVersion.value) {
      errorMsg.value = error instanceof Error ? error.message : String(error);
      detailLoading.value = true;
    }
  } finally {
    if (version === loadVersion.value) loading.value = false;
  }
}

onMounted(() => {
  readStored();
  void load();
  // 音色/BGM 下拉选项（失败静默，降级为空列表仍可保存现有值）
  listVoices()
    .then((data) => {
      voiceOptions.value = data.voices.map((v) => ({ id: v.id, name: v.name }));
    })
    .catch(() => {});
  listFiles({ type: "bgm" })
    .then((data) => {
      bgmOptions.value = data.files.map((f) => `/files/bgm/${f.filename}`);
    })
    .catch(() => {});
});

onBeforeUnmount(flushAllPending);

watch(selectedId, (nextId, previousId) => {
  if (previousId) void flushSave(previousId);
  const task = tasks.value.find((item) => item.id === nextId);
  if (task) {
    void loadServer(task);
    void loadCopy(nextId);
  }
});
</script>

<template>
  <main class="px-7 pt-[26px] pb-12">
    <!-- Hero（原型 #publish） -->
    <section class="mb-[22px] flex items-end justify-between gap-5">
      <div>
        <h1 class="mb-1.5 text-[26px] font-bold">发布管理</h1>
        <p class="text-subtle">维护平台发布信息与运营标记，不执行自动发布。</p>
      </div>
      <button
        class="cursor-pointer rounded-[10px] border border-hairline bg-white px-3.5 py-[9px] hover:bg-gray-50"
        @click="load"
      >
        刷新数据
      </button>
    </section>

    <!-- 版本提示条（原型 .notice） -->
    <div class="mb-3.5 rounded-xl border border-[#f8df9c] bg-[#fff8e8] px-3.5 py-3 text-[13px]">
      当前版本仅记录发布元数据，不回采抖音/快手/视频号播放数据。
    </div>

    <div v-if="errorMsg" role="alert" class="mb-4 flex items-center justify-between gap-3 rounded-xl bg-red-50 p-3 text-sm text-red-600"><span>{{ errorMsg }}</span><button class="cursor-pointer rounded border border-red-300 px-2 py-1 text-xs hover:bg-red-100" @click="load">重试</button></div>

    <!-- KPI 指标卡（原型 .metric） -->
    <div class="mb-[22px] grid grid-cols-3 gap-3.5">
      <div class="rounded-2xl border border-hairline bg-panel p-[18px]">
        <p class="text-[13px] text-subtle">视频总数</p>
        <p class="mt-2 text-[30px] leading-none font-extrabold">{{ loading ? "—" : serverTotal }}</p>
        <p v-if="!loading && serverTotal !== tasks.length" class="mt-1 text-xs text-red-600">
          仅装载 {{ tasks.length }} 条，列表不完整
        </p>
      </div>
      <div class="rounded-2xl border border-hairline bg-panel p-[18px]">
        <p class="text-[13px] text-subtle">总时长</p>
        <p class="mt-2 text-[30px] leading-none font-extrabold">{{ totalDuration.toFixed(1) }}s</p>
      </div>
      <div class="rounded-2xl border border-hairline bg-panel p-[18px]">
        <p class="text-[13px] text-subtle">已完成</p>
        <p class="mt-2 text-[30px] leading-none font-extrabold">{{ completedCount }}</p>
      </div>
    </div>

    <div class="grid grid-cols-[1fr_340px] gap-[18px] max-lg:grid-cols-1">
      <!-- 发布列表（原型 .table-card） -->
      <section class="order-2 overflow-hidden rounded-2xl border border-hairline bg-panel lg:order-1">
        <p v-if="loading" class="p-8 text-center text-sm text-subtle">加载中...</p>
        <p v-else-if="tasks.length === 0" class="p-8 text-center text-sm text-subtle">暂无生成记录</p>
        <div v-else class="overflow-x-auto"><table class="w-full border-collapse text-left text-[13px]"><thead class="bg-[#fafbfc] text-subtle"><tr><th class="border-b border-hairline px-3.5 py-[13px] font-semibold">故事主题</th><th class="border-b border-hairline px-3.5 py-[13px] font-semibold">时长</th><th class="border-b border-hairline px-3.5 py-[13px] font-semibold">视频模板</th><th class="border-b border-hairline px-3.5 py-[13px] font-semibold">发布时间</th><th class="border-b border-hairline px-3.5 py-[13px] font-semibold">可保存</th></tr></thead><tbody><tr v-for="task in tasks" :key="task.id" class="cursor-pointer border-b border-hairline last:border-b-0 hover:bg-brand-soft/60" :class="selectedTask?.id === task.id ? 'border-l-[3px] border-l-brand bg-brand-soft font-medium' : ''" :aria-current="selectedTask?.id === task.id ? 'true' : undefined" @click="selectedId = task.id"><td class="max-w-[220px] px-3.5 py-[13px] font-medium"><button type="button" class="cursor-pointer rounded text-left hover:underline focus:outline-none focus:ring-2 focus:ring-brand" @click.stop="selectedId = task.id">{{ titleOf(task) }}</button></td><td class="px-3.5 py-[13px]">{{ durationOf(task).toFixed(1) }}s</td><td class="px-3.5 py-[13px]">{{ task.template }}</td><td class="px-3.5 py-[13px]">{{ hydratedIds.has(task.id) ? (metaFor(task).publishAt || "—") : "—" }}</td><td class="px-3.5 py-[13px]">{{ hydratedIds.has(task.id) ? (metaFor(task).allowSave ? "是" : "否") : "—" }}</td></tr></tbody></table></div>
      </section>
      <aside v-if="selectedTask && selectedMeta" class="order-1 space-y-4 lg:order-2">
        <section class="rounded-2xl border border-hairline bg-panel p-4"><h2 class="flex items-center justify-between gap-2 font-semibold">视频详情<span class="truncate text-xs font-normal text-subtle">{{ selectedTask ? titleOf(selectedTask) : "" }}</span><span class="inline-flex items-center gap-2 text-xs font-normal"><span role="status" aria-live="polite" :class="saveStates[selectedTask!.id] === 'failed' ? 'text-red-600' : 'text-gray-500'">{{ SAVE_STATE_LABEL[saveStates[selectedTask!.id] ?? 'idle'] }}</span><button v-if="saveStates[selectedTask!.id] === 'failed'" class="rounded border border-red-300 px-2 py-0.5 text-red-600 hover:bg-red-50" @click="saveServer(selectedTask!)">重试保存</button></span></h2><div class="mt-3 space-y-3 text-sm">
          <label class="block">故事主题<input :value="selectedMeta.storyTopic" :disabled="detailLoading" :placeholder="selectedTask.title" class="mt-1 w-full rounded-[10px] border border-hairline bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none disabled:opacity-60" @input="updateMeta(selectedTask!, { storyTopic: ($event.target as HTMLInputElement).value })" /><span class="mt-1 block text-xs text-subtle">留空则跟随生成标题「{{ selectedTask.title }}」</span></label>
          <label class="block">封面图 URL<input :value="selectedMeta.cover" :disabled="detailLoading" class="mt-1 w-full rounded-[10px] border border-hairline bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none disabled:opacity-60" @input="updateMeta(selectedTask!, { cover: ($event.target as HTMLInputElement).value })" /></label>
          <label class="block">音色<select :value="selectedMeta.voice" :disabled="detailLoading" class="mt-1 w-full rounded-[10px] border border-hairline bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none disabled:opacity-60" @change="updateMeta(selectedTask!, { voice: ($event.target as HTMLSelectElement).value })"><option value="">未指定</option><option v-for="v in voiceOptions" :key="v.id" :value="v.id">{{ v.name }}</option><option v-if="selectedMeta!.voice && !voiceOptions.some((v) => v.id === selectedMeta!.voice)" :value="selectedMeta!.voice" disabled>{{ selectedMeta!.voice }}（当前值不可选）</option></select></label>
          <label class="block">背景音乐<select :value="selectedMeta.bgm" :disabled="detailLoading" class="mt-1 w-full rounded-[10px] border border-hairline bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none disabled:opacity-60" @change="updateMeta(selectedTask!, { bgm: ($event.target as HTMLSelectElement).value })"><option value="">无 BGM</option><option v-for="src in bgmOptions" :key="src" :value="src">{{ src.split('/').pop() }}</option><option v-if="selectedMeta!.bgm && !bgmOptions.includes(selectedMeta!.bgm)" :value="selectedMeta!.bgm" disabled>{{ selectedMeta!.bgm.split('/').pop() }}（当前值不可选）</option></select></label>
          <label class="block">发布时间<input :value="selectedMeta.publishAt" :disabled="detailLoading" type="datetime-local" class="mt-1 w-full rounded-[10px] border border-hairline bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none disabled:opacity-60" @input="updateMeta(selectedTask!, { publishAt: ($event.target as HTMLInputElement).value })" /></label>
          <label class="flex items-center gap-2"><input :checked="selectedMeta.allowSave" :disabled="detailLoading" type="checkbox" @change="updateMeta(selectedTask!, { allowSave: ($event.target as HTMLInputElement).checked })" />允许观众保存视频</label>
        </div></section>
        <!-- 视频文案（选中行实时切换；懒加载完整内容） -->
        <section class="rounded-2xl border border-hairline bg-panel p-4">
          <h2 class="font-semibold">视频文案</h2>
          <p v-if="copyLoading && selectedCopy === null" class="mt-2 text-xs text-gray-400">文案加载中…</p>
          <div v-else-if="selectedCopy && selectedCopy.length > 0" class="mt-2 max-h-72 space-y-2 overflow-y-auto text-xs leading-relaxed text-gray-600">
            <p v-for="(line, i) in selectedCopy" :key="i" class="rounded-[10px] bg-shell px-3 py-2">{{ line }}</p>
          </div>
          <p v-else class="mt-2 text-xs text-gray-400">暂无文案（记录加载失败或内容为空）</p>
        </section>
        <section class="rounded-2xl border border-hairline bg-panel p-4"><h2 class="font-semibold">自定义参数</h2><div class="mt-3 space-y-2"><input v-model="draftField.label" :disabled="detailLoading" class="w-full rounded border px-2 py-1.5 text-sm" placeholder="参数名称，如发布文案" /><div class="flex gap-2"><select v-model="draftField.type" :disabled="detailLoading" class="rounded border px-2 py-1.5 text-sm"><option value="text">文本</option><option value="image">图像 URL</option></select><input v-model="draftField.value" :disabled="detailLoading" class="min-w-0 flex-1 rounded border px-2 py-1.5 text-sm" placeholder="参数值" /><button :disabled="detailLoading" class="cursor-pointer rounded-[10px] border border-brand bg-brand px-3 py-1.5 text-sm text-white disabled:opacity-50" @click="addField">添加</button></div></div><div v-for="field in selectedMeta.customFields" :key="field.key" class="mt-3 rounded-lg bg-gray-50 p-2 text-sm"><div class="flex items-center justify-between"><span class="font-medium">{{ field.label }} <span class="text-xs text-gray-400">({{ field.type === 'image' ? '图像' : '文本' }})</span></span><button :disabled="detailLoading" class="text-xs text-red-500" @click="removeField(field.key)">删除</button></div><img v-if="field.type === 'image' && field.value" :src="field.value" class="mt-2 max-h-24 rounded object-cover" alt="自定义图像" /><p v-else class="mt-1 break-all text-gray-600">{{ field.value || "—" }}</p></div></section>
      </aside>
    </div>
  </main>
</template>
