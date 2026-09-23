<script setup lang="ts">
// 审计统一管理界面（PRD 10.1.4）：搜索 / 单删 / 批量删除 / 行展开完整档案（DataTable 统一表格）
import { onMounted, ref, watch } from "vue";
import { type UploadMark, batchDeleteTasks, deleteTask, getTask, listTasks } from "../api/client";
import AuditDetailPanel, { type AuditDetail } from "../components/audit-detail.vue";
import ConfirmDialog from "../components/ui/confirm-dialog.vue";
import DataTable from "../components/ui/data-table.vue";
import StatusPill from "../components/ui/status-pill.vue";
// biome-ignore lint/style/useImportType: 组件在 Vue 模板中使用（biome 不感知模板标签）
import UploadMarkManager from "../components/upload-mark-manager.vue";
import { useUploadMarks } from "../composables/use-upload-marks";
import type { DataTableColumn } from "../lib/data-table";
import { clampPage, toggleSelection } from "../lib/data-table";
import { STATUS_LABEL, statusVariant } from "../lib/status";
import { toast } from "../lib/toast";

type TaskSummary = NonNullable<Awaited<ReturnType<typeof listTasks>>["tasks"]>[number];

/** 列定义：自定义渲染全部走 #cell-<key> 插槽 */
const COLUMNS: DataTableColumn[] = [
  { key: "title", label: "标题", cellClass: "max-w-56" },
  { key: "status", label: "状态" },
  { key: "level", label: "等级" },
  { key: "wordsCount", label: "词汇" },
  { key: "candidates", label: "候选词" },
  { key: "attempts", label: "生成尝试" },
  { key: "modifications", label: "修改次数" },
  { key: "marks", label: "上传" },
  { key: "createdAt", label: "创建时间" },
  { key: "actions", label: "操作" },
];
const rowKey = (t: TaskSummary): string => t.id;

const loading = ref(true);
const errorMsg = ref("");
const tasks = ref<TaskSummary[]>([]);
const keyword = ref("");
/** 分页状态（服务端分页，每页条数可选） */
const page = ref(1);
const pageSize = ref(10);
const total = ref(0);
/** 选中 id 集合（批量操作） */
const selected = ref<Set<string>>(new Set());
/** 行展开集合 + 详情懒加载缓存（id → audit 完整档案） */
const expanded = ref<Set<string>>(new Set());
const details = ref<Record<string, AuditDetail>>({});
/** 确认对话框状态 */
const deleteOpen = ref(false);
const batchOpen = ref(false);
const pendingDeleteId = ref("");

async function load(): Promise<void> {
  loading.value = true;
  errorMsg.value = "";
  try {
    const data = await listTasks({
      keyword: keyword.value.trim() || undefined,
      page: page.value,
      pageSize: pageSize.value,
    });
    tasks.value = data.tasks ?? [];
    total.value = data.total ?? 0;
    selected.value = new Set();
    expanded.value = new Set();
    details.value = {};
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

/** 翻页/换条数重新拉取（同帧多源变更合并一次） */
watch([page, pageSize], () => {
  void load();
});

/** 展开切换：新增展开行懒加载完整档案 */
async function onExpandedUpdate(next: Set<string>): Promise<void> {
  const added = [...next].filter((id) => !expanded.value.has(id));
  expanded.value = next;
  for (const id of added) {
    if (details.value[id]) continue;
    try {
      details.value[id] = await getTask(id);
    } catch {
      details.value[id] = { error: "详情加载失败" };
    }
  }
}

function requestDelete(id: string): void {
  pendingDeleteId.value = id;
  deleteOpen.value = true;
}

/** 删除后页码钳回合法范围（末页被清空时） */
function clampPageAfterDelete(): void {
  page.value = clampPage(page.value, Math.max(0, total.value - 1), pageSize.value);
}

/** 单条删除（确认后） */
async function doDelete(): Promise<void> {
  try {
    await deleteTask(pendingDeleteId.value);
    toast.success("记录已删除");
    clampPageAfterDelete();
    await load();
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    pendingDeleteId.value = "";
  }
}

/** 批量删除（确认后） */
async function doBatchDelete(): Promise<void> {
  try {
    const ids = [...selected.value];
    const result = await batchDeleteTasks(ids);
    toast.success(
      `已删除 ${result.deleted} 条${result.notFound.length > 0 ? `，${result.notFound.length} 条不存在` : ""}`,
    );
    clampPageAfterDelete();
    await load();
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  }
}

onMounted(() => {
  void load();
  void loadMarks();
});

/** 上传标记索引（useUploadMarks：双索引，任务维度优先）+ 弹窗（「上传」列只读展示平台，点击管理） */
const { loadMarks, marksOfTask } = useUploadMarks();
const markManager = ref<InstanceType<typeof UploadMarkManager> | null>(null);
const markFilename = ref("");

/** 从记录的 video 字段提取文件名（结构收窄，避免 any；标记弹窗按文件名定位） */
function videoFilenameOf(t: { video?: unknown }): string | null {
  if (
    t.video &&
    typeof t.video === "object" &&
    "url" in t.video &&
    typeof t.video.url === "string"
  ) {
    return t.video.url.split("/").pop() ?? null;
  }
  return null;
}

function marksOf(t: { id: string; video?: unknown }): UploadMark[] {
  return marksOfTask(t);
}

function openMarkManager(t: { video?: unknown }): void {
  const name = videoFilenameOf(t);
  if (!name) return;
  markFilename.value = name;
  markManager.value?.open(name);
}
</script>

<template>
  <div class="px-7 pt-[26px] pb-12">
    <!-- Hero（原型 #audit） -->
    <section class="mb-[22px]">
      <h1 class="mb-1.5 text-[26px] font-bold">审计管理</h1>
      <p class="text-subtle">查看 AI 生成、人工编辑、配音和渲染操作记录。</p>
    </section>

    <!-- 工具栏：搜索 + 批量操作 -->
    <div class="mb-3.5 flex items-center gap-2.5">
      <input
        v-model="keyword"
        placeholder="搜索标题…"
        class="w-64 rounded-[10px] border border-hairline bg-white px-3 py-[9px] text-sm focus:border-brand focus:outline-none"
        @keyup.enter="load"
      />
      <button
        class="cursor-pointer rounded-[10px] border border-brand bg-brand px-3.5 py-[9px] text-sm font-medium text-white hover:opacity-90"
        @click="page = 1; load()"
      >
        搜索
      </button>
      <button
        v-if="selected.size > 0"
        class="cursor-pointer rounded-[10px] border border-red-200 bg-white px-3.5 py-[9px] text-sm text-bad hover:bg-red-50"
        @click="batchOpen = true"
      >
        删除选中（{{ selected.size }}）
      </button>
    </div>

    <p v-if="errorMsg" class="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-600">{{ errorMsg }}</p>

    <!-- 统一表格：服务端分页 + 勾选 + 展开档案 -->
    <DataTable
      v-else
      :columns="COLUMNS"
      :rows="tasks"
      :row-key="rowKey"
      :total="total"
      v-model:page="page"
      v-model:page-size="pageSize"
      v-model:selected="selected"
      :expanded="expanded"
      :loading="loading"
      selectable
      :empty-text="keyword ? '当前搜索无结果' : '暂无生成记录'"
      @update:expanded="onExpandedUpdate"
    >
      <template #cell-title="{ row }">
        <button
          class="cursor-pointer text-left font-medium text-brand hover:underline"
          @click.stop="onExpandedUpdate(toggleSelection(expanded, row.id))"
        >
          {{ row.title }}
          <span class="text-xs text-gray-400">{{ expanded.has(row.id) ? "▾" : "▸" }}</span>
        </button>
      </template>
      <template #cell-status="{ row }">
        <StatusPill :variant="statusVariant(row.status)">{{ STATUS_LABEL[row.status] ?? row.status }}</StatusPill>
      </template>
      <template #cell-candidates="{ row }">
        {{ row.auditSummary?.candidates ?? 0 }}
        <span
          v-if="row.auditSummary?.hasAudit"
          class="ml-1 rounded bg-brand-soft px-1 text-xs text-brand"
          >有档案</span
        >
        <span v-else class="ml-1 rounded bg-[#f2f3f6] px-1 text-xs text-gray-400">无</span>
      </template>
      <template #cell-attempts="{ row }">
        {{ row.auditSummary?.attempts ?? 0 }}
        <span v-if="(row.auditSummary?.attempts ?? 0) > 1" class="ml-1 text-xs text-warn">重试过</span>
      </template>
      <template #cell-modifications="{ row }">{{ row.auditSummary?.modifications ?? 0 }}</template>
      <template #cell-marks="{ row }">
        <button
          class="flex cursor-pointer flex-wrap items-center gap-1"
          :disabled="marksOf(row).length === 0"
          :title="marksOf(row).length > 0 ? '点击管理上传标记' : undefined"
          @click.stop="openMarkManager(row)"
        >
          <span
            v-for="m in marksOf(row).slice(0, 2)"
            :key="m.id"
            class="rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700"
          >
            {{ m.platform }}
          </span>
          <span v-if="marksOf(row).length === 0" class="text-xs text-gray-400">—</span>
        </button>
      </template>
      <template #cell-createdAt="{ row }">
        <span class="text-gray-500">{{ new Date(row.createdAt).toLocaleString("zh-CN") }}</span>
      </template>
      <template #cell-actions="{ row }">
        <button class="cursor-pointer text-xs text-bad hover:underline" @click.stop="requestDelete(row.id)">
          删除
        </button>
      </template>
      <template #expand="{ row }">
        <AuditDetailPanel :preview="row.textPreview" :detail="details[row.id] ?? null" />
      </template>
    </DataTable>

    <!-- 删除确认对话框（shadcn-vue AlertDialog） -->
    <ConfirmDialog
      v-model:open="deleteOpen"
      title="删除生成记录"
      description="确定删除这条生成记录吗？"
      confirm-text="删除"
      destructive
      @confirm="doDelete"
    />
    <ConfirmDialog
      v-model:open="batchOpen"
      title="批量删除"
      :description="`确定删除选中的 ${selected.size} 条生成记录吗？此操作不可恢复。`"
      confirm-text="删除"
      destructive
      @confirm="doBatchDelete"
    />

    <!-- 上传标记管理 -->
    <UploadMarkManager ref="markManager" :filename="markFilename" @change="loadMarks" />
  </div>
</template>
