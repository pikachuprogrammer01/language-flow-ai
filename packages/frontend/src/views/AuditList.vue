<script setup lang="ts">
// 审计统一管理界面（PRD 10.1.4）：搜索 / 单删 / 批量删除 / 行展开完整档案
import { computed, onMounted, ref } from "vue";
import { toast } from "vue-sonner";
import { type UploadMark, batchDeleteTasks, deleteTask, getTask, listTasks } from "../api/client";
import AuditRow, { type AuditDetail } from "../components/audit-row.vue";
import ConfirmDialog from "../components/ui/confirm-dialog.vue";
import Pagination from "../components/ui/pagination.vue";
// biome-ignore lint/style/useImportType: 组件在 Vue 模板中使用（biome 不感知模板标签）
import UploadMarkManager from "../components/upload-mark-manager.vue";
import { useUploadMarks } from "../composables/use-upload-marks";

type TaskSummary = NonNullable<Awaited<ReturnType<typeof listTasks>>["tasks"]>[number];

const loading = ref(true);
const errorMsg = ref("");
const tasks = ref<TaskSummary[]>([]);
const keyword = ref("");
/** 分页状态 */
const page = ref(1);
const pageSize = 10;
const total = ref(0);
/** 选中 id 集合（批量操作） */
const selected = ref<Set<string>>(new Set());
/** 行展开详情缓存（id → audit 等完整档案） */
const expanded = ref<Set<string>>(new Set());
const details = ref<Record<string, AuditDetail>>({});
/** 确认对话框状态 */
const deleteOpen = ref(false);
const batchOpen = ref(false);
const pendingDeleteId = ref("");

const allChecked = computed(
  () => tasks.value.length > 0 && selected.value.size === tasks.value.length,
);

function toggleAll(): void {
  selected.value = allChecked.value ? new Set() : new Set(tasks.value.map((t) => t.id));
}

async function load(): Promise<void> {
  loading.value = true;
  errorMsg.value = "";
  try {
    const data = await listTasks({
      keyword: keyword.value.trim() || undefined,
      page: page.value,
      pageSize,
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

/** 行展开：懒加载完整档案（含 audit） */
async function toggleExpand(id: string): Promise<void> {
  if (expanded.value.has(id)) {
    expanded.value.delete(id);
    return;
  }
  expanded.value.add(id);
  if (!details.value[id]) {
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

function clampPage(): void {
  const maxPage = Math.max(1, Math.ceil(total.value / pageSize));
  if (page.value > maxPage) page.value = maxPage;
}

/** 单条删除（确认后） */
async function doDelete(): Promise<void> {
  try {
    await deleteTask(pendingDeleteId.value);
    toast.success("记录已删除");
    clampPage();
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
    clampPage();
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
  markManager.value?.open();
}
</script>

<template>
  <div class="mx-auto max-w-6xl px-6 py-10">
    <h1 class="text-xl font-bold">审计管理</h1>
    <p class="mt-1 text-sm text-gray-500">
      全部生成记录的审计档案一览（输入/候选词/重试/修改日志），点击行展开完整档案
    </p>

    <!-- 工具栏：搜索 + 批量操作 -->
    <div class="mt-4 flex items-center gap-3">
      <input
        v-model="keyword"
        placeholder="搜索标题…"
        class="w-64 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
        @keyup.enter="load"
      />
      <button
        class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        @click="page = 1; load()"
      >
        搜索
      </button>
      <button
        v-if="selected.size > 0"
        class="rounded-lg border px-4 py-2 text-sm text-red-500 hover:bg-red-50"
        @click="batchOpen = true"
      >
        删除选中（{{ selected.size }}）
      </button>
    </div>

    <p v-if="errorMsg" class="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-600">{{ errorMsg }}</p>
    <p v-else-if="loading" class="mt-6 text-center text-sm text-gray-400">加载中…</p>
    <p v-else-if="tasks.length === 0" class="mt-6 text-center text-sm text-gray-400">
      暂无生成记录{{ keyword ? "（当前搜索无结果）" : "" }}
    </p>

    <div v-else class="mt-4 overflow-x-auto rounded-lg border">
      <table class="w-full text-left text-sm">
        <thead class="bg-gray-50 text-xs text-gray-500">
          <tr>
            <th class="w-8 px-2 py-2.5">
              <input type="checkbox" :checked="allChecked" @change="toggleAll" />
            </th>
            <th class="px-4 py-2.5 font-medium">标题</th>
            <th class="px-4 py-2.5 font-medium">状态</th>
            <th class="px-4 py-2.5 font-medium">等级</th>
            <th class="px-4 py-2.5 font-medium">词汇</th>
            <th class="px-4 py-2.5 font-medium">候选词</th>
            <th class="px-4 py-2.5 font-medium">生成尝试</th>
            <th class="px-4 py-2.5 font-medium">修改次数</th>
            <th class="px-4 py-2.5 font-medium">上传</th>
            <th class="px-4 py-2.5 font-medium">创建时间</th>
            <th class="px-4 py-2.5 font-medium">操作</th>
          </tr>
        </thead>
        <tbody class="divide-y">
          <AuditRow
            v-for="t in tasks"
            :key="t.id"
            :t="t"
            :marks="marksOf(t)"
            :selected="selected.has(t.id)"
            :expanded="expanded.has(t.id)"
            :detail="details[t.id] ?? null"
            @toggle-select="selected.has(t.id) ? selected.delete(t.id) : selected.add(t.id)"
            @toggle-expand="toggleExpand(t.id)"
            @open-marks="openMarkManager(t)"
            @remove="requestDelete(t.id)"
          />
        </tbody>
      </table>
    </div>

    <!-- 分页（shadcn-vue Pagination） -->
    <div v-if="total > pageSize" class="mt-4 flex items-center justify-between">
      <span class="text-xs text-gray-400">共 {{ total }} 条</span>
      <Pagination
        :page="page"
        :total="total"
        :page-size="pageSize"
        @update:page="page = $event; load()"
      />
    </div>

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
