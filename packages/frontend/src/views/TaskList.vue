<script setup lang="ts">
import { Check, Copy, FolderOpen, Play, Plus, Tag } from "lucide-vue-next";
/**
 * 任务列表页 — 生成记录管理（列表 / 查看详情 / 删除 / 新建入口）
 * 数据源：GET /api/tasks（status 过滤 + 分页）
 */
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { batchDeleteTasks, deleteTask, listTasks, revealVideoInFinder } from "../api/client";
import ConfirmDialog from "../components/ui/confirm-dialog.vue";
import DataTable from "../components/ui/data-table.vue";
import Spinner from "../components/ui/spinner.vue";
import StatusPill from "../components/ui/status-pill.vue";
// biome-ignore lint/style/useImportType: 组件在 Vue 模板中使用（biome 不感知模板标签）
import UploadMarkManager from "../components/upload-mark-manager.vue";
import { useUploadMarks } from "../composables/use-upload-marks";
import { goCreate } from "../lib/create-session";
import type { DataTableColumn } from "../lib/data-table";
import { STATUS_LABEL, TEMPLATE_LABEL, relativeTime, statusVariant } from "../lib/status";
import { advanceTask, canAdvance } from "../lib/task-advance";
import { toast } from "../lib/toast";

type TaskRowData = {
  id: string;
  title: string;
  template: string;
  level: string;
  status: string;
  createdAt: string;
  wordsCount?: number;
  textPreview?: string;
  video?: unknown;
};

/** 列定义：自定义渲染走 #cell-<key> 插槽 */
const COLUMNS: DataTableColumn[] = [
  { key: "title", label: "标题", cellClass: "min-w-[280px]" },
  { key: "template", label: "模板" },
  { key: "level", label: "等级" },
  { key: "status", label: "状态" },
  { key: "wordsCount", label: "词汇" },
  { key: "updatedAt", label: "更新时间", cellClass: "whitespace-nowrap text-gray-500" },
  { key: "actions", label: "操作", cellClass: "text-right" },
];
const rowKey = (t: TaskRowData): string => t.id;

const router = useRouter();
/** 删除确认对话框状态 */
const confirmOpen = ref(false);
const pendingDeleteId = ref("");
/** 批量选择 */
const selected = ref<Set<string>>(new Set());
const batchOpen = ref(false);
/** 模板分类 tab（全部 / 三模板） */
const templateFilter = ref<"all" | "scene_word" | "word_card" | "quiz">("all");
/** 关键词搜索（原型 toolbar：标题 / Content ID 前端过滤） */
const keyword = ref("");
const TEMPLATE_TABS: { id: "all" | "scene_word" | "word_card" | "quiz"; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "scene_word", label: "情景背词" },
  { id: "word_card", label: "单词卡片" },
  { id: "quiz", label: "选择题" },
];
/** 全选（当前筛选结果内）已由 DataTable 表头提供；保留页码/条数状态（客户端分页） */
const page = ref(1);
const pageSize = ref(10);

/** 按模板分类 + 上传状态 + 关键词过滤后的列表 */
const visibleTasks = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  return tasks.value.filter((t) => {
    if (templateFilter.value !== "all" && t.template !== templateFilter.value) return false;
    if (uploadFilter.value === "uploaded" && marksCount(t) === 0) return false;
    if (uploadFilter.value === "not-uploaded" && marksCount(t) > 0) return false;
    if (kw && !`${t.title} ${t.id}`.toLowerCase().includes(kw)) return false;
    return true;
  });
});

/** 标记状态过滤（全部 / 已标记 / 未标记） */
const uploadFilter = ref<"all" | "uploaded" | "not-uploaded">("all");
const UPLOAD_TABS: { id: "all" | "uploaded" | "not-uploaded"; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "uploaded", label: "已标记" },
  { id: "not-uploaded", label: "未标记" },
];

const tasks = ref<TaskRowData[]>([]);
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

/** 上传标记弹窗：当前操作的视频文件名/任务 id（taskId 供弹窗内保存策略联动） */
const markManager = ref<InstanceType<typeof UploadMarkManager> | null>(null);
const markFilename = ref("");
const markTaskId = ref<string | undefined>(undefined);

function openMarkManager(t: { id: string; video?: unknown }): void {
  const name = videoName(t);
  if (!name) return;
  markFilename.value = name;
  markTaskId.value = t.id;
  markManager.value?.open(name);
}

/** 按钮内联反馈：taskId+动作 → 短暂显示「已复制/已打开」后还原（不弹 toast） */
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
    flashFeedback(`${t.id}-open`, "已打开");
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
    flashFeedback(`${t.id}-copy`, "已复制");
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  }
}

/** 继续生产：内容就绪→配音+渲染；配音完成→只差渲染（链路断点从列表一键推到底） */
const advancingId = ref("");

async function advance(row: TaskRowData): Promise<void> {
  if (advancingId.value) return;
  advancingId.value = row.id;
  try {
    const { action } = await advanceTask(row.id);
    toast.success(action === "render" ? "配音已就绪，视频渲染完成" : "配音 + 渲染完成，视频已生成");
    await load();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err), {
      description: "可重试；失败原因见详情页审计档案",
    });
  } finally {
    advancingId.value = "";
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
  <div class="px-7 pt-[26px] pb-12">
    <!-- Hero（原型 #tasks） -->
    <section class="mb-[22px] flex items-end justify-between gap-5">
      <div>
        <h1 class="mb-1.5 text-[26px] font-bold">生成记录</h1>
        <p class="text-subtle">统一查看内容生成、配音、渲染与失败重试。</p>
      </div>
      <div class="flex gap-2.5">
        <button
          class="cursor-pointer rounded-[10px] border border-hairline bg-white px-3.5 py-[9px] hover:bg-gray-50"
          @click="load"
        >
          刷新
        </button>
        <button
          v-if="selected.size > 0"
          class="cursor-pointer rounded-[10px] border border-red-200 bg-white px-3.5 py-[9px] text-red-500 hover:bg-red-50"
          @click="batchOpen = true"
        >
          删除选中（{{ selected.size }}）
        </button>
        <button
          class="inline-flex cursor-pointer items-center gap-1.5 rounded-[10px] border border-brand bg-brand px-3.5 py-[9px] text-white hover:opacity-90"
          @click="goCreate()"
        >
          <Plus class="h-4 w-4" /> 新建任务
        </button>
      </div>
    </section>

    <p v-if="errorMsg" class="mb-4 rounded-xl bg-red-50 p-3 text-sm text-red-600">{{ errorMsg }}</p>

    <!-- 工具栏（原型 .toolbar：搜索 + 筛选 + 全选） -->
    <div v-if="tasks.length > 0" class="mb-3.5 flex flex-wrap items-center justify-between gap-3">
      <div class="flex flex-wrap items-center gap-2">
        <input
          v-model="keyword"
          class="min-w-[260px] rounded-[10px] border border-hairline bg-white px-3 py-[9px] text-sm focus:border-brand focus:outline-none"
          placeholder="搜索标题 / Content ID"
        />
        <button
          v-for="tab in TEMPLATE_TABS"
          :key="tab.id"
          class="cursor-pointer rounded-[10px] border px-3 py-[7px] text-xs"
          :class="templateFilter === tab.id ? 'border-brand bg-brand-soft text-brand' : 'border-hairline bg-white text-gray-600 hover:bg-gray-50'"
          @click="templateFilter = tab.id; selected = new Set()"
        >
          {{ tab.label }}
        </button>
        <span class="mx-1 h-5 w-px bg-hairline" />
        <button
          v-for="tab in UPLOAD_TABS"
          :key="tab.id"
          class="cursor-pointer rounded-[10px] border px-3 py-[7px] text-xs"
          :class="uploadFilter === tab.id ? 'border-ok bg-emerald-50 text-emerald-700' : 'border-hairline bg-white text-gray-600 hover:bg-gray-50'"
          @click="uploadFilter = tab.id; selected = new Set()"
        >
          {{ tab.label }}
        </button>
      </div>
    </div>

    <!-- 统一表格（客户端分页）：行点击进详情，表头全选 -->
    <DataTable
      :columns="COLUMNS"
      :rows="visibleTasks"
      :row-key="rowKey"
      v-model:page="page"
      v-model:page-size="pageSize"
      v-model:selected="selected"
      :loading="loading"
      selectable
      :empty-text="tasks.length === 0 ? '暂无生成记录，点右上「新建任务」开始生产' : '当前筛选无记录'"
      @row-click="(row: TaskRowData) => router.push(`/tasks/${row.id}`)"
    >
      <template #cell-title="{ row }">
        <div class="flex items-center gap-2">
          <span class="truncate font-medium">{{ row.title }}</span>
          <span
            v-if="marksCount(row) > 0"
            class="shrink-0 rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700"
            title="已标记平台"
          >
            已标记 ×{{ marksCount(row) }}
          </span>
        </div>
        <p v-if="row.textPreview" class="mt-0.5 max-w-[420px] truncate text-xs text-gray-500">
          {{ row.textPreview }}
        </p>
      </template>
      <template #cell-template="{ row }">{{ TEMPLATE_LABEL[row.template] ?? row.template }}</template>
      <template #cell-status="{ row }">
        <StatusPill :variant="statusVariant(row.status)">{{ STATUS_LABEL[row.status] ?? row.status }}</StatusPill>
      </template>
      <template #cell-wordsCount="{ row }">{{ row.wordsCount ?? "—" }}</template>
      <template #cell-updatedAt="{ row }">{{ relativeTime(row.createdAt) }}</template>
      <template #cell-actions="{ row }">
        <div class="flex justify-end gap-2 whitespace-nowrap" @click.stop>
          <button
            v-if="canAdvance(row.status) && !videoUrl(row)"
            class="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[10px] border border-brand/40 bg-brand-soft px-3 py-1.5 text-xs font-medium text-brand hover:bg-[#ece9ff] disabled:opacity-50"
            :disabled="Boolean(advancingId)"
            :title="row.status === 'audio_ready' ? '配音已完成，点击渲染视频' : '从断点继续：配音 → 渲染'"
            @click="advance(row)"
          >
            <Spinner v-if="advancingId === row.id" size="sm" />
            <Play v-else class="h-3.5 w-3.5" aria-hidden="true" />
            {{ advancingId === row.id ? "生产中…" : "继续生产" }}
          </button>
          <button
            v-if="videoUrl(row)"
            class="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[10px] border border-hairline bg-white px-3 py-1.5 text-xs text-brand hover:bg-brand-soft"
            :class="inlineFeedback[`${row.id}-open`] ? 'border-ok bg-emerald-50 text-emerald-700' : ''"
            title="在 Finder 中打开视频所在目录"
            @click="openInFinder(row)"
          >
            <Check v-if="inlineFeedback[`${row.id}-open`]" class="h-3.5 w-3.5" />
            <FolderOpen v-else class="h-3.5 w-3.5" />
            {{ inlineFeedback[`${row.id}-open`] ?? "打开" }}
          </button>
          <button
            v-if="videoUrl(row)"
            class="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[10px] border border-hairline bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
            title="管理上传平台标记"
            @click="openMarkManager(row)"
          >
            <Tag class="h-3.5 w-3.5" /> 标记
          </button>
          <button
            v-if="videoName(row)"
            class="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-[10px] border border-hairline bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
            :class="inlineFeedback[`${row.id}-copy`] ? 'border-ok bg-emerald-50 text-emerald-700' : ''"
            title="复制视频名称"
            @click="copyVideoName(row)"
          >
            <Check v-if="inlineFeedback[`${row.id}-copy`]" class="h-3.5 w-3.5" />
            <Copy v-else class="h-3.5 w-3.5" />
            {{ inlineFeedback[`${row.id}-copy`] ?? "复制视频名称" }}
          </button>
          <button
            class="cursor-pointer whitespace-nowrap rounded-[10px] border border-hairline bg-white px-3 py-1.5 text-xs text-bad hover:bg-red-50"
            @click="remove(row.id)"
          >
            删除
          </button>
        </div>
      </template>
    </DataTable>
  </div>

  <!-- 删除确认对话框（shadcn-vue AlertDialog） -->
  <ConfirmDialog
    v-model:open="batchOpen"
    title="批量删除"
    :description="`确定删除选中的 ${selected.size} 条生成记录吗？此操作不可恢复；对应音频/视频文件会变为未引用，可到文件管理「清理无引用文件」释放磁盘。`"
    confirm-text="删除"
    destructive
    @confirm="doBatchRemove"
  />
  <ConfirmDialog
    v-model:open="confirmOpen"
    title="删除生成记录"
    description="确定删除这条生成记录吗？此操作不可恢复；其音频/视频文件会变为未引用，可到文件管理「清理无引用文件」释放磁盘。"
    confirm-text="删除"
    destructive
    @confirm="doRemove"
  />

  <!-- 上传标记管理 -->
  <UploadMarkManager
    ref="markManager"
    :filename="markFilename"
    :task-id="markTaskId"
    @change="loadMarks"
  />
</template>
