<script setup lang="ts">
/**
 * 任务列表页 — 生成记录管理（列表 / 查看详情 / 删除 / 新建入口）
 * 数据源：GET /api/tasks（status 过滤 + 分页）
 */
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { toast } from "vue-sonner";
import { batchDeleteTasks, deleteTask, listTasks } from "../api/client";
import ConfirmDialog from "../components/ui/confirm-dialog.vue";

const router = useRouter();
/** 删除确认对话框状态 */
const confirmOpen = ref(false);
const pendingDeleteId = ref("");
/** 批量选择 */
const selected = ref<Set<string>>(new Set());
const batchOpen = ref(false);
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

onMounted(load);
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
    <p v-if="loading" class="py-8 text-center text-gray-500">加载中…</p>

    <div v-else-if="tasks.length === 0" class="py-12 text-center text-gray-400">
      暂无生成记录，去<button class="text-blue-600 underline" @click="router.push('/')">新建视频</button>
    </div>

    <ul v-else class="space-y-3">
      <li
        v-for="t in tasks"
        :key="t.id"
        class="flex items-center justify-between rounded-xl border p-4 hover:shadow-sm"
      >
        <input
          type="checkbox"
          class="mr-3 shrink-0"
          :checked="selected.has(t.id)"
          @change="selected.has(t.id) ? selected.delete(t.id) : selected.add(t.id)"
        />
        <div class="min-w-0 cursor-pointer flex-1" @click="router.push(`/tasks/${t.id}`)">
          <div class="truncate font-medium">{{ t.title }}</div>
          <p v-if="t.textPreview" class="mt-1 truncate text-sm text-gray-600">{{ t.textPreview }}</p>
          <div class="mt-1 flex items-center gap-3 text-xs text-gray-500">
            <span class="rounded bg-gray-100 px-1.5 py-0.5">{{ t.level }}</span>
            <span>{{ STATUS_LABEL[t.status] ?? t.status }}</span>
            <span>{{ new Date(t.createdAt).toLocaleString("zh-CN") }}</span>
            <span v-if="t.video" class="text-green-600">▶ 有视频</span>
            <span v-else class="text-gray-400">暂无视频</span>
          </div>
        </div>
        <div class="ml-4 flex shrink-0 gap-2">
          <button
            class="rounded-lg border px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100"
            @click="router.push(`/tasks/${t.id}`)"
          >
            详情
          </button>
          <button
            class="rounded-lg border px-3 py-1.5 text-xs text-red-500 hover:bg-red-50"
            @click="remove(t.id)"
          >
            删除
          </button>
        </div>
      </li>
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
</template>
