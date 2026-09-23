<script setup lang="ts">
/**
 * 上传标记一览页 — 集中查看已标记视频的链接 / 平台 / 备注 / 创建时间与视频信息
 * 数据：GET /api/upload-marks/overview（后端关联 contents）
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { type UploadMarkOverview, listUploadMarksOverview } from "../api/client";
import DataTable from "../components/ui/data-table.vue";
// biome-ignore lint/style/useImportType: 组件在 Vue 模板中使用（biome 不感知模板标签）
import UploadMarkManager from "../components/upload-mark-manager.vue";
import type { DataTableColumn } from "../lib/data-table";
import { TEMPLATE_LABEL } from "../lib/status";

const router = useRouter();
const loading = ref(true);
const errorMsg = ref("");
const marks = ref<UploadMarkOverview[]>([]);
const platforms = ref<string[]>([]);
const platformFilter = ref<string>("all");
const keyword = ref("");
/** 客户端分页状态 */
const page = ref(1);
const pageSize = ref(10);

/** 列定义：自定义渲染走 #cell-<key> 插槽 */
const COLUMNS: DataTableColumn[] = [
  { key: "video", label: "视频", cellClass: "min-w-[220px]" },
  { key: "platform", label: "平台" },
  { key: "url", label: "链接", cellClass: "min-w-[200px]" },
  { key: "note", label: "备注", cellClass: "whitespace-nowrap" },
  { key: "createdAt", label: "创建时间" },
  { key: "actions", label: "操作", cellClass: "text-right" },
];
const rowKey = (m: UploadMarkOverview): string => m.id;

/** 上传标记弹窗（行内「管理」） */
const markManager = ref<InstanceType<typeof UploadMarkManager> | null>(null);
const markFilename = ref("");
const markTaskId = ref<string | undefined>(undefined);

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
  <div class="px-7 pt-[26px] pb-12">
    <!-- Hero（原型 #marks） -->
    <section class="mb-[22px]">
      <h1 class="mb-1.5 text-[26px] font-bold">上传标记</h1>
      <p class="text-subtle">记录视频是否已上传及上传平台。</p>
    </section>

    <p v-if="errorMsg" class="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-600">{{ errorMsg }}</p>
    <p v-else-if="loading && marks.length === 0" class="mt-6 text-center text-sm text-gray-400">
      加载中…
    </p>
    <p v-else-if="!loading && platforms.length === 0 && marks.length === 0" class="mt-6 text-center text-sm text-gray-400">
      暂无上传标记（在生成记录 / 视频资产中点「标记」添加）
    </p>

    <template v-else>
      <!-- 工具栏（原型 .toolbar：搜索 + 平台筛选） -->
      <div class="mb-3.5 flex flex-wrap items-center gap-2">
        <input
          v-model="keyword"
          class="min-w-[260px] flex-1 rounded-[10px] border border-hairline bg-white px-3 py-[9px] text-sm focus:border-brand focus:outline-none"
          placeholder="搜索标题 / 链接 / 备注 / 文件名…"
        />
        <button
          class="cursor-pointer rounded-[10px] border px-3 py-[7px] text-xs"
          :class="platformFilter === 'all' ? 'border-brand bg-brand-soft text-brand' : 'border-hairline bg-white text-gray-600 hover:bg-gray-50'"
          @click="platformFilter = 'all'"
        >
          全部平台
        </button>
        <button
          v-for="p in platforms"
          :key="p"
          class="cursor-pointer rounded-[10px] border px-3 py-[7px] text-xs"
          :class="platformFilter === p ? 'border-brand bg-brand-soft text-brand' : 'border-hairline bg-white text-gray-600 hover:bg-gray-50'"
          @click="platformFilter = p"
        >
          {{ p }}
        </button>
      </div>

      <p class="mb-3 text-xs text-subtle">共 {{ rows.length }} 条标记</p>

      <!-- 统一表格（客户端分页） -->
      <DataTable
        :columns="COLUMNS"
        :rows="rows"
        :row-key="rowKey"
        v-model:page="page"
        v-model:page-size="pageSize"
        :loading="loading"
        :empty-text="platforms.length === 0 && rows.length === 0 ? '暂无上传标记（在生成记录/视频资产中点「标记」添加）' : '无匹配标记'"
      >
        <template #cell-video="{ row }">
          <template v-if="row.video">
            <p class="font-medium">{{ row.video.title }}</p>
            <p class="mt-0.5 text-xs text-gray-500">
              {{ TEMPLATE_LABEL[row.video.template] ?? row.video.template }} ·
              {{ row.video.level }} ·
              <template v-if="row.video.duration != null">{{ row.video.duration.toFixed(1) }}s · </template>
              词汇 {{ row.video.wordsCount }}
            </p>
          </template>
          <p v-else class="text-gray-500">未关联任务（文件可能已删）</p>
          <p class="break-all font-mono text-[11px] text-gray-400">{{ row.videoFilename }}</p>
        </template>
        <template #cell-platform="{ row }">
          <span class="whitespace-nowrap rounded-full bg-brand-soft px-2 py-0.5 text-xs font-medium text-brand">{{
            row.platform
          }}</span>
        </template>
        <template #cell-url="{ row }">
          <a
            v-if="row.url"
            :href="row.url"
            target="_blank"
            rel="noopener noreferrer"
            class="block max-w-[280px] truncate text-brand hover:underline"
            :title="row.url"
          >
            {{ row.url }}
          </a>
          <span v-else class="text-gray-400">未填写</span>
        </template>
        <template #cell-note="{ row }">
          <span v-if="row.note" class="rounded bg-[#fff8e8] px-2 py-0.5 text-xs text-amber-800">{{ row.note }}</span>
          <span v-else class="text-xs text-gray-400">—</span>
        </template>
        <template #cell-createdAt="{ row }">
          <span class="whitespace-nowrap text-gray-500">{{ new Date(row.createdAt).toLocaleString("zh-CN") }}</span>
        </template>
        <template #cell-actions="{ row }">
          <div class="flex justify-end gap-2 whitespace-nowrap">
            <button
              class="cursor-pointer rounded-[10px] border border-hairline bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
              @click="openManage(row)"
            >
              管理
            </button>
            <button
              v-if="row.taskId"
              class="cursor-pointer rounded-[10px] border border-brand bg-brand px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
              @click="goTask(row)"
            >
              看详情
            </button>
          </div>
        </template>
      </DataTable>
    </template>

    <UploadMarkManager
      ref="markManager"
      :filename="markFilename"
      :task-id="markTaskId"
      @change="load"
    />
  </div>
</template>
