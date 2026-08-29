<script setup lang="ts">
/**
 * 上传标记一览页 — 集中查看已标记视频的链接 / 平台 / 备注 / 创建时间与视频信息
 * 数据：GET /api/upload-marks/overview（后端关联 contents）
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { type UploadMarkOverview, listUploadMarksOverview } from "../api/client";
// biome-ignore lint/style/useImportType: 组件在 Vue 模板中使用（biome 不感知模板标签）
import UploadMarkManager from "../components/upload-mark-manager.vue";

const router = useRouter();
const loading = ref(true);
const errorMsg = ref("");
const marks = ref<UploadMarkOverview[]>([]);
const platforms = ref<string[]>([]);
const platformFilter = ref<string>("all");
const keyword = ref("");

/** 上传标记弹窗（行内「管理」） */
const markManager = ref<InstanceType<typeof UploadMarkManager> | null>(null);
const markFilename = ref("");
const markTaskId = ref<string | undefined>(undefined);

const TEMPLATE_LABEL: Record<string, string> = {
  scene_word: "情景背词",
  word_card: "单词卡片",
  quiz: "选择题",
};

const rows = computed(() => marks.value);

async function load(): Promise<void> {
  loading.value = true;
  errorMsg.value = "";
  try {
    const data = await listUploadMarksOverview({
      platform: platformFilter.value === "all" ? undefined : platformFilter.value,
      keyword: keyword.value.trim() || undefined,
    });
    marks.value = data.marks;
    platforms.value = data.platforms;
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

/** 筛选变化时重新请求后端（防抖关键词） */
let keywordTimer: ReturnType<typeof setTimeout> | undefined;
watch(platformFilter, () => {
  void load();
});
watch(keyword, () => {
  clearTimeout(keywordTimer);
  keywordTimer = setTimeout(() => {
    void load();
  }, 300);
});

function openManage(m: UploadMarkOverview): void {
  markFilename.value = m.videoFilename;
  markTaskId.value = m.taskId ?? undefined;
  markManager.value?.open(m.videoFilename);
}

function goTask(m: UploadMarkOverview): void {
  if (m.taskId) void router.push(`/tasks/${m.taskId}`);
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="mx-auto max-w-5xl px-6 py-10">
    <h1 class="text-xl font-bold">上传标记</h1>
    <p class="mt-1 text-sm text-gray-500">
      已标记视频一览：发布链接、平台、备注、创建时间与关联视频信息
    </p>

    <p v-if="errorMsg" class="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-600">{{ errorMsg }}</p>
    <p v-else-if="loading && marks.length === 0" class="mt-6 text-center text-sm text-gray-400">
      加载中…
    </p>
    <p v-else-if="!loading && platforms.length === 0 && marks.length === 0" class="mt-6 text-center text-sm text-gray-400">
      暂无上传标记（在生成记录 / 视频资产中点「🏷 标记」添加）
    </p>

    <template v-else>
      <div class="mt-4 flex flex-wrap items-center gap-2">
        <input
          v-model="keyword"
          class="min-w-[12rem] flex-1 rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
          placeholder="搜索标题 / 链接 / 备注 / 文件名…"
        />
        <button
          class="rounded-full border px-3 py-1 text-xs"
          :class="platformFilter === 'all' ? 'border-blue-500 bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-100'"
          @click="platformFilter = 'all'"
        >
          全部平台
        </button>
        <button
          v-for="p in platforms"
          :key="p"
          class="rounded-full border px-3 py-1 text-xs"
          :class="platformFilter === p ? 'border-blue-500 bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-100'"
          @click="platformFilter = p"
        >
          {{ p }}
        </button>
      </div>

      <p class="mt-2 text-xs text-gray-400">共 {{ rows.length }} 条标记</p>

      <div v-if="rows.length === 0" class="mt-6 text-center text-sm text-gray-400">无匹配标记</div>

      <div v-else class="mt-3 space-y-3">
        <article v-for="m in rows" :key="m.id" class="rounded-lg border bg-white p-4">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0 flex-1 space-y-2">
              <div class="flex flex-wrap items-center gap-2">
                <span class="rounded bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                  {{ m.platform }}
                </span>
                <span v-if="m.note" class="rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-800">
                  {{ m.note }}
                </span>
                <span v-else class="text-xs text-gray-400">无备注</span>
                <span class="text-xs text-gray-400">
                  创建 {{ new Date(m.createdAt).toLocaleString("zh-CN") }}
                </span>
              </div>

              <div class="text-sm">
                <span class="mr-1 text-xs text-gray-400">链接</span>
                <a
                  v-if="m.url"
                  :href="m.url"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="break-all text-blue-600 hover:underline"
                >
                  {{ m.url }}
                </a>
                <span v-else class="text-gray-400">未填写</span>
              </div>

              <div class="rounded-md bg-gray-50 px-3 py-2 text-xs text-gray-600">
                <template v-if="m.video">
                  <p class="font-medium text-gray-800">{{ m.video.title }}</p>
                  <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                    <span>{{ TEMPLATE_LABEL[m.video.template] ?? m.video.template }}</span>
                    <span>{{ m.video.level }}</span>
                    <span v-if="m.video.duration != null">时长 {{ m.video.duration.toFixed(1) }}s</span>
                    <span>词汇 {{ m.video.wordsCount }}</span>
                    <span class="break-all text-gray-400">{{ m.videoFilename }}</span>
                  </div>
                </template>
                <template v-else>
                  <p class="text-gray-500">未关联任务（文件可能已删）</p>
                  <p class="mt-0.5 break-all text-gray-400">{{ m.videoFilename }}</p>
                </template>
              </div>
            </div>

            <div class="flex shrink-0 flex-col gap-2 sm:flex-row">
              <button
                class="rounded-lg border px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100"
                @click="openManage(m)"
              >
                管理
              </button>
              <button
                v-if="m.taskId"
                class="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
                @click="goTask(m)"
              >
                看详情
              </button>
            </div>
          </div>
        </article>
      </div>
    </template>

    <UploadMarkManager
      ref="markManager"
      :filename="markFilename"
      :task-id="markTaskId"
      @change="load"
    />
  </div>
</template>
