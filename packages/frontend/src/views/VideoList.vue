<script setup lang="ts">
// 视频资产页（PRD 10.1.5）：已有成片的记录列表 / 播放 / 重命名 / 删除
import { computed, onMounted, ref } from "vue";
import { toast } from "vue-sonner";
import { deleteTask, listTasks } from "../api/client";
import ConfirmDialog from "../components/ui/confirm-dialog.vue";
// biome-ignore lint/style/useImportType: 组件在 Vue 模板中使用（biome 不感知模板标签）
import UploadMarkManager from "../components/upload-mark-manager.vue";
import { useUploadMarks } from "../composables/use-upload-marks";

type VideoAsset = NonNullable<Awaited<ReturnType<typeof listTasks>>["tasks"]>[number];

const loading = ref(true);
const errorMsg = ref("");
const assets = ref<VideoAsset[]>([]);
/** 静态文件前缀（video.url 是相对路径，需拼完整 API 地址，与 TaskDetail 播放一致） */
const base = (import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080").replace(/\/$/, "");
/** 播放展开的 id */
const playing = ref<Set<string>>(new Set());
/** 删除确认 */
const deleteOpen = ref(false);
const pendingDeleteId = ref("");

/** 标记状态过滤：全部 / 已标记 / 未标记 */
const uploadFilter = ref<"all" | "uploaded" | "not-uploaded">("all");
const UPLOAD_TABS: { id: "all" | "uploaded" | "not-uploaded"; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "uploaded", label: "已标记" },
  { id: "not-uploaded", label: "未标记" },
];

/** 上传标记索引（useUploadMarks：双索引，任务维度优先） */
const { loadMarks, marksOfTask } = useUploadMarks();

const filteredAssets = computed(() => {
  if (uploadFilter.value === "uploaded")
    return assets.value.filter((t) => marksOfTask(t).length > 0);
  if (uploadFilter.value === "not-uploaded")
    return assets.value.filter((t) => marksOfTask(t).length === 0);
  return assets.value;
});

/** 上传标记弹窗 */
const markManager = ref<InstanceType<typeof UploadMarkManager> | null>(null);
const markFilename = ref("");

function openMarkManager(t: VideoAsset): void {
  const v = t.video;
  if (!v || typeof v !== "object" || !("url" in v) || typeof v.url !== "string") return;
  markFilename.value = v.url.split("/").pop() ?? "";
  markManager.value?.open();
}

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

/** 视频信息守卫（后端 video 结构 {url,duration,format}） */
function videoOf(t: VideoAsset): { url: string; duration: number } | null {
  const v = t.video;
  if (v && typeof v === "object" && typeof (v as { url?: unknown }).url === "string") {
    return {
      url: (v as { url: string }).url,
      duration: Number((v as { duration?: unknown }).duration ?? 0),
    };
  }
  return null;
}

async function load(): Promise<void> {
  loading.value = true;
  errorMsg.value = "";
  try {
    const data = await listTasks({ hasVideo: "true", pageSize: 100 });
    assets.value = data.tasks ?? [];
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

function togglePlay(id: string): void {
  if (playing.value.has(id)) playing.value.delete(id);
  else playing.value.add(id);
}

function requestDelete(id: string): void {
  pendingDeleteId.value = id;
  deleteOpen.value = true;
}

/** 删除视频资产（删除其生成记录） */
async function doDelete(): Promise<void> {
  try {
    await deleteTask(pendingDeleteId.value);
    toast.success("视频已删除");
    await load();
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
  <div class="mx-auto max-w-5xl px-6 py-10">
    <h1 class="text-xl font-bold">视频资产</h1>
    <p class="mt-1 text-sm text-gray-500">已有成片的生成记录：播放 / 上传标记 / 删除（关联生成记录）</p>

    <p v-if="errorMsg" class="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-600">{{ errorMsg }}</p>
    <p v-else-if="loading" class="mt-6 text-center text-sm text-gray-400">加载中…</p>
    <p v-else-if="assets.length === 0" class="mt-6 text-center text-sm text-gray-400">暂无视频资产（先完成生成与渲染）</p>

    <template v-else>
      <!-- 上传状态过滤 -->
      <div class="mt-4 flex gap-2">
        <button
          v-for="tab in UPLOAD_TABS"
          :key="tab.id"
          class="rounded-full border px-3 py-1 text-xs"
          :class="uploadFilter === tab.id ? 'border-blue-500 bg-blue-50 text-blue-700' : 'text-gray-600 hover:bg-gray-100'"
          @click="uploadFilter = tab.id"
        >
          {{ tab.label }}
        </button>
      </div>

      <div v-if="filteredAssets.length === 0" class="mt-6 text-center text-sm text-gray-400">
        {{ uploadFilter === "uploaded" ? "暂无已标记视频" : uploadFilter === "not-uploaded" ? "全部已标记 🎉" : "暂无视频" }}
      </div>

      <div v-else class="mt-3 space-y-3">
        <div v-for="t in filteredAssets" :key="t.id" class="rounded-lg border bg-white p-4">
          <div class="flex items-center justify-between gap-4">
            <div class="min-w-0">
              <span class="font-medium">{{ t.title }}</span>
              <div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                <span
                  class="rounded px-1.5 py-0.5"
                  :class="t.status === 'completed' ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-600'"
                >
                  {{ STATUS_LABEL[String(t.status)] ?? String(t.status) }}
                </span>
                <span>{{ String(t.level) }}</span>
                <span>时长 {{ videoOf(t)?.duration ?? 0 }}s</span>
                <span>词汇 {{ t.wordsCount }}</span>
                <span v-if="t.audio">有配音</span>
                <span v-if="marksOfTask(t).length > 0" class="rounded bg-green-50 px-1.5 py-0.5 text-green-700">
                  已标记 ×{{ marksOfTask(t).length }}
                </span>
                <span>{{ new Date(String(t.createdAt)).toLocaleString("zh-CN") }}</span>
              </div>
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <button
                class="rounded-lg border px-3 py-2 text-sm text-gray-600 hover:bg-gray-100"
                @click="openMarkManager(t)"
              >
                🏷 标记
              </button>
              <button
                class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                @click="togglePlay(t.id)"
              >
                {{ playing.has(t.id) ? "收起" : "播放" }}
              </button>
              <button class="rounded-lg border px-3 py-2 text-sm text-red-500 hover:bg-red-50" @click="requestDelete(t.id)">
                删除
              </button>
            </div>
          </div>
          <!-- 行内播放器（url 为相对路径，拼 base 完整地址） -->
          <video
            v-if="playing.has(t.id) && videoOf(t)"
            :src="base + videoOf(t)!.url"
            controls
            class="mt-3 w-full max-w-md rounded-lg bg-black"
          />
        </div>
      </div>
    </template>

    <!-- 删除确认对话框（shadcn-vue AlertDialog） -->
    <ConfirmDialog
      v-model:open="deleteOpen"
      title="删除视频资产"
      description="确定删除这条视频及其生成记录吗？"
      confirm-text="删除"
      destructive
      @confirm="doDelete"
    />

    <!-- 上传标记管理 -->
    <UploadMarkManager ref="markManager" :filename="markFilename" @change="loadMarks" />
  </div>
</template>
