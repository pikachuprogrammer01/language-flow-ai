<script setup lang="ts">
// 审计统一管理界面（PRD 10.1.4）：全部生成记录的审计概要一览，详情链到记录页
import { onMounted, ref } from "vue";
import { listTasks } from "../api/client";

type TaskSummary = NonNullable<Awaited<ReturnType<typeof listTasks>>["tasks"]>[number];

const loading = ref(true);
const errorMsg = ref("");
const tasks = ref<TaskSummary[]>([]);

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
    const data = await listTasks({});
    tasks.value = data.tasks ?? [];
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="mx-auto max-w-5xl px-6 py-10">
    <h1 class="text-xl font-bold">审计管理</h1>
    <p class="mt-1 text-sm text-gray-500">
      全部生成记录的审计档案一览（输入/候选词/重试/修改日志），点击标题查看完整档案
    </p>

    <p v-if="errorMsg" class="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-600">{{ errorMsg }}</p>
    <p v-else-if="loading" class="mt-6 text-center text-sm text-gray-400">加载中…</p>
    <p v-else-if="tasks.length === 0" class="mt-6 text-center text-sm text-gray-400">暂无生成记录</p>

    <div v-else class="mt-4 overflow-x-auto rounded-lg border">
      <table class="w-full text-left text-sm">
        <thead class="bg-gray-50 text-xs text-gray-500">
          <tr>
            <th class="px-4 py-2.5 font-medium">标题</th>
            <th class="px-4 py-2.5 font-medium">状态</th>
            <th class="px-4 py-2.5 font-medium">词汇</th>
            <th class="px-4 py-2.5 font-medium">候选词</th>
            <th class="px-4 py-2.5 font-medium">生成尝试</th>
            <th class="px-4 py-2.5 font-medium">修改次数</th>
            <th class="px-4 py-2.5 font-medium">创建时间</th>
          </tr>
        </thead>
        <tbody class="divide-y">
          <tr v-for="t in tasks" :key="t.id" class="hover:bg-gray-50">
            <td class="px-4 py-2.5">
              <router-link
                :to="`/tasks/${t.id}`"
                class="font-medium text-blue-600 hover:underline"
              >
                {{ t.title }}
              </router-link>
            </td>
            <td class="px-4 py-2.5">
              <span
                class="rounded px-1.5 py-0.5 text-xs"
                :class="t.status === 'completed' ? 'bg-green-50 text-green-700' : t.status === 'failed' ? 'bg-red-50 text-red-700' : 'bg-gray-100 text-gray-600'"
              >
                {{ STATUS_LABEL[String(t.status)] ?? String(t.status) }}
              </span>
            </td>
            <td class="px-4 py-2.5 text-gray-600">{{ t.wordsCount }}</td>
            <td class="px-4 py-2.5 text-gray-600">
              {{ t.auditSummary?.candidates ?? 0 }}
              <span v-if="t.auditSummary?.hasAudit" class="ml-1 rounded bg-blue-50 px-1 text-xs text-blue-600">有档案</span>
              <span v-else class="ml-1 rounded bg-gray-100 px-1 text-xs text-gray-400">无</span>
            </td>
            <td class="px-4 py-2.5 text-gray-600">
              {{ t.auditSummary?.attempts ?? 0 }}
              <span
                v-if="(t.auditSummary?.attempts ?? 0) > 1"
                class="ml-1 text-xs text-amber-600"
                title="存在重试"
              >
                重试过
              </span>
            </td>
            <td class="px-4 py-2.5 text-gray-600">{{ t.auditSummary?.modifications ?? 0 }}</td>
            <td class="px-4 py-2.5 text-gray-500">
              {{ new Date(String(t.createdAt)).toLocaleString("zh-CN") }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
