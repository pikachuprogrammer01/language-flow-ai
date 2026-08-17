<script setup lang="ts">
/**
 * 任务列表页 — 生成记录管理（列表 / 查看详情 / 删除 / 新建入口）
 * 数据源：GET /api/tasks（status 过滤 + 分页）
 */
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { deleteTask, listTasks } from "../api/client";

const router = useRouter();
const tasks = ref<
  {
    id: string;
    title: string;
    template: string;
    level: string;
    status: string;
    createdAt: string;
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
  if (!window.confirm("确定删除这条生成记录吗？")) return;
  try {
    await deleteTask(id);
    await load();
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
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
        <div class="min-w-0 cursor-pointer flex-1" @click="router.push(`/tasks/${t.id}`)">
          <div class="truncate font-medium">{{ t.title }}</div>
          <div class="mt-1 flex items-center gap-3 text-xs text-gray-500">
            <span class="rounded bg-gray-100 px-1.5 py-0.5">{{ t.level }}</span>
            <span>{{ STATUS_LABEL[t.status] ?? t.status }}</span>
            <span>{{ new Date(t.createdAt).toLocaleString("zh-CN") }}</span>
            <span v-if="t.video" class="text-green-600">▶ 有视频</span>
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
</template>
