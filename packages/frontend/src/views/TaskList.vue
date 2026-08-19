<script setup lang="ts">
/**
 * 任务列表页 — 生成记录管理（列表 / 查看详情 / 删除 / 新建入口）
 * 数据源：GET /api/tasks（status 过滤 + 分页）
 */
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { toast } from "vue-sonner";
import { batchDeleteTasks, deleteTask, listTasks, revealVideoInFinder } from "../api/client";
import TaskRow from "../components/task-row.vue";
import ConfirmDialog from "../components/ui/confirm-dialog.vue";
// biome-ignore lint/style/useImportType: 组件在 Vue 模板中使用（biome 不感知模板标签）
import UploadMarkManager from "../components/upload-mark-manager.vue";
import { useUploadMarks } from "../composables/use-upload-marks";

const router = useRouter();
/** 删除确认对话框状态 */
const confirmOpen = ref(false);
const pendingDeleteId = ref("");
/** 批量选择 */
const selected = ref<Set<string>>(new Set());
const batchOpen = ref(false);
/** 模板分类 tab（全部 / 三模板） */
const templateFilter = ref<"all" | "scene_word" | "word_card" | "quiz">("all");
const TEMPLATE_TABS: { id: "all" | "scene_word" | "word_card" | "quiz"; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "scene_word", label: "情景背词" },
  { id: "word_card", label: "单词卡片" },
  { id: "quiz", label: "选择题" },
];
/** 全选（当前分类下） */
const allChecked = computed(
  () => visibleTasks.value.length > 0 && selected.value.size === visibleTasks.value.length,
);

/** 按模板分类 + 上传状态过滤后的列表 */
const visibleTasks = computed(() =>
  tasks.value.filter((t) => {
    if (templateFilter.value !== "all" && t.template !== templateFilter.value) return false;
    if (uploadFilter.value === "uploaded" && marksCount(t) === 0) return false;
    if (uploadFilter.value === "not-uploaded" && marksCount(t) > 0) return false;
    return true;
  }),
);

/** 标记状态过滤（全部 / 已标记 / 未标记） */
const uploadFilter = ref<"all" | "uploaded" | "not-uploaded">("all");
const UPLOAD_TABS: { id: "all" | "uploaded" | "not-uploaded"; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "uploaded", label: "已标记" },
  { id: "not-uploaded", label: "未标记" },
];

function toggleAll(): void {
  selected.value = allChecked.value ? new Set() : new Set(visibleTasks.value.map((t) => t.id));
}
const tasks = ref<
  {
    id: string;
    title: string;
    template: string;
    level: string;
    status: string;
    createdAt: string;
    wordsCount?: number;
    textPreview?: string;
    video?: unknown;
  }[]
>([]);
const total = ref(0);
const loading = ref(true);
const errorMsg = ref("");

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

/** 上传标记索引（useUploadMarks：一次全量拉取，四页面共用） */
const { loadMarks, marksOfTask } = useUploadMarks();

function marksCount(t: { id: string; video?: unknown }): number {
  return marksOfTask(t).length;
}

/** 上传标记弹窗：当前操作的视频文件名 */
const markManager = ref<InstanceType<typeof UploadMarkManager> | null>(null);
const markFilename = ref("");

function openMarkManager(t: { video?: unknown }): void {
  const name = videoName(t);
  if (!name) return;
  markFilename.value = name;
  markManager.value?.open();
}

/** 按钮内联反馈：taskId+动作 → 短暂显示「✓ 已复制/已打开」后还原（不弹 toast） */
const inlineFeedback = ref<Record<string, string>>({});

function flashFeedback(key: string, text: string): void {
  inlineFeedback.value = { ...inlineFeedback.value, [key]: text };
  window.setTimeout(() => {
    const next = { ...inlineFeedback.value };
    delete next[key];
    inlineFeedback.value = next;
  }, 1500);
}

/** 在 Finder 中显示视频（宿主机 launchd 桥，见 scripts/reveal-watcher.sh） */
async function openInFinder(t: { video?: unknown; id: string }): Promise<void> {
  const url = videoUrl(t);
  if (!url) return;
  try {
    await revealVideoInFinder(url);
    flashFeedback(`${t.id}-open`, "✓ 已打开");
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  }
}

/** 复制视频文件名（上传平台时便于对照查找） */
async function copyVideoName(t: { video?: unknown; id: string }): Promise<void> {
  const name = videoName(t);
  if (!name) return;
  try {
    await navigator.clipboard.writeText(name);
    flashFeedback(`${t.id}-copy`, "✓ 已复制");
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  }
}

async function load(): Promise<void> {
  loading.value = true;
  errorMsg.value = "";
  try {
    const data = await listTasks({ pageSize: 100 });
    tasks.value = data.tasks;
    total.value = data.total;
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

async function remove(id: string): Promise<void> {
  // 确认对话框（状态在模板中管理）
  pendingDeleteId.value = id;
  confirmOpen.value = true;
}

/** 批量删除（确认后） */
async function doBatchRemove(): Promise<void> {
  try {
    const ids = [...selected.value];
    const result = await batchDeleteTasks(ids);
    toast.success(
      `已删除 ${result.deleted} 条${result.notFound.length > 0 ? `，${result.notFound.length} 条不存在` : ""}`,
    );
    selected.value = new Set();
    await load();
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  }
}

/** 执行删除（ConfirmDialog 确认后） */
async function doRemove(): Promise<void> {
  try {
    await deleteTask(pendingDeleteId.value);
    await load();
    toast.success("记录已删除");
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    pendingDeleteId.value = "";
  }
}

onMounted(() => {
  void load();
  void loadMarks();
});
</script>

<template>
  <div class="mx-auto max-w-4xl px-6 py-10">
    <div class="mb-6 flex items-center justify-between">
      <h1 class="text-2xl font-bold">生成记录</h1>
      <div class="flex gap-3">
        <button
          class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          @click="router.push('/')"
        >
          ＋ 新建视频
        </button>
        <button class="rounded-lg border px-4 py-2 text-sm hover:bg-gray-100" @click="load">刷新</button>
        <button
          v-if="selected.size > 0"
          class="rounded-lg border px-4 py-2 text-sm text-red-500 hover:bg-red-50"
          @click="batchOpen = true"
        >
          删除选中（{{ selected.size }}）
        </button>
      </div>
    </div>

    <p v-if="errorMsg" class="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-600">{{ errorMsg }}</p>
    <!-- 模板分类 tab + 上传状态过滤 + 全选 -->
    <div v-if="tasks.length > 0" class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div class="flex gap-2">
        <button
          v-for="tab in TEMPLATE_TABS"
          :key="tab.id"
          class="rounded-full border px-3 py-1 text-xs"
          :class="templateFilter === tab.id ? 'border-blue-500 bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-100'"
          @click="templateFilter = tab.id; selected = new Set()"
        >
          {{ tab.label }}
        </button>
        <span class="mx-1 w-px bg-gray-200" />
        <button
          v-for="tab in UPLOAD_TABS"
          :key="tab.id"
          class="rounded-full border px-3 py-1 text-xs"
          :class="uploadFilter === tab.id ? 'border-green-500 bg-green-50 text-green-700' : 'text-gray-600 hover:bg-gray-100'"
          @click="uploadFilter = tab.id; selected = new Set()"
        >
          {{ tab.label }}
        </button>
      </div>
      <label class="flex cursor-pointer items-center gap-1.5 text-xs text-gray-500">
        <input type="checkbox" :checked="allChecked" @change="toggleAll" />
        全选
      </label>
    </div>

    <p v-if="loading" class="py-8 text-center text-gray-500">加载中…</p>
    <p v-else-if="tasks.length > 0 && visibleTasks.length === 0" class="py-12 text-center text-gray-400">
      当前分类无记录
    </p>

    <div v-else-if="tasks.length === 0" class="py-12 text-center text-gray-400">
      暂无生成记录，去<button class="text-blue-600 underline" @click="router.push('/')">新建视频</button>
    </div>

    <ul v-else class="space-y-3">
      <TaskRow
        v-for="t in visibleTasks"
        :key="t.id"
        :t="t"
        :marks-count="marksCount(t)"
        :open-feedback="inlineFeedback[`${t.id}-open`]"
        :copy-feedback="inlineFeedback[`${t.id}-copy`]"
        :selected="selected.has(t.id)"
        @toggle-select="selected.has(t.id) ? selected.delete(t.id) : selected.add(t.id)"
        @open-finder="openInFinder(t)"
        @open-marks="openMarkManager(t)"
        @copy-name="copyVideoName(t)"
        @detail="router.push(`/tasks/${t.id}`)"
        @remove="remove(t.id)"
      />
    </ul>
  </div>

  <!-- 删除确认对话框（shadcn-vue AlertDialog） -->
  <ConfirmDialog
    v-model:open="batchOpen"
    title="批量删除"
    :description="`确定删除选中的 ${selected.size} 条生成记录吗？此操作不可恢复。`"
    confirm-text="删除"
    destructive
    @confirm="doBatchRemove"
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
  <UploadMarkManager ref="markManager" :filename="markFilename" @change="loadMarks" />
</template>
