<script setup lang="ts">
import { Play, Tag } from "lucide-vue-next";
// 视频资产页（PRD 10.1.5）：已有成片的记录列表 / 播放 / 重命名 / 删除
import { computed, onMounted, ref } from "vue";
import { deleteTask, listTasks } from "../api/client";
import ConfirmDialog from "../components/ui/confirm-dialog.vue";
// biome-ignore lint/style/useImportType: 组件在 Vue 模板中使用（biome 不感知模板标签）
import UploadMarkManager from "../components/upload-mark-manager.vue";
import { useUploadMarks } from "../composables/use-upload-marks";
import { toast } from "../lib/toast";

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
const markTaskId = ref<string | undefined>(undefined);

function openMarkManager(t: VideoAsset): void {
  const v = t.video;
  if (!v || typeof v !== "object" || !("url" in v) || typeof v.url !== "string") return;
  const name = v.url.split("/").pop() ?? "";
  markFilename.value = name;
  markTaskId.value = t.id;
  markManager.value?.open(name);
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

/** 时长秒 → 00:48（原型 chip 格式） */
function fmtDuration(sec: number): string {
  const s = Math.round(sec);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
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
  <div class="px-7 pt-[26px] pb-12">
    <!-- Hero（原型 #videos） -->
    <section class="mb-[22px] flex items-end justify-between gap-5">
      <div>
        <h1 class="mb-1.5 text-[26px] font-bold">视频资产</h1>
        <p class="text-subtle">查看已渲染完成的视频，进入发布或重新制作。</p>
      </div>
      <button
        class="cursor-pointer rounded-[10px] border border-hairline bg-white px-3.5 py-[9px] hover:bg-gray-50"
        @click="load"
      >
        刷新
      </button>
    </section>

    <p v-if="errorMsg" class="mt-4 rounded-xl bg-red-50 p-3 text-sm text-red-600">{{ errorMsg }}</p>
    <p v-else-if="loading" class="mt-6 text-center text-sm text-subtle">加载中…</p>
    <p v-else-if="assets.length === 0" class="mt-6 text-center text-sm text-gray-400">暂无视频资产（先完成生成与渲染）</p>

    <template v-else>
      <!-- 上传状态过滤 -->
      <div class="mb-3.5 flex gap-2">
        <button
          v-for="tab in UPLOAD_TABS"
          :key="tab.id"
          class="cursor-pointer rounded-[10px] border px-3 py-[7px] text-xs"
          :class="uploadFilter === tab.id ? 'border-brand bg-brand-soft text-brand' : 'border-hairline bg-white text-gray-600 hover:bg-gray-50'"
          @click="uploadFilter = tab.id"
        >
          {{ tab.label }}
        </button>
      </div>

      <div v-if="filteredAssets.length === 0" class="mt-6 text-center text-sm text-gray-400">
        {{ uploadFilter === "uploaded" ? "暂无已标记视频" : uploadFilter === "not-uploaded" ? "全部已标记 🎉" : "暂无视频" }}
      </div>

      <!-- 资产卡片网格（原型 .asset-grid：9:16 封面 + 元信息） -->
      <div v-else class="grid grid-cols-3 gap-3.5 max-lg:grid-cols-2">
        <div
          v-for="t in filteredAssets"
          :key="t.id"
          class="overflow-hidden rounded-[15px] border border-hairline bg-panel"
        >
          <!-- 封面区：未播放时渐变占位，播放时就地内嵌播放器 -->
          <div
            v-if="playing.has(t.id) && videoOf(t)"
            class="flex justify-center bg-[#0f1117] py-2"
          >
            <video
              :src="base + videoOf(t)!.url"
              controls
              autoplay
              class="max-h-[290px] rounded-lg bg-black"
            />
          </div>
          <button
            v-else
            class="relative flex aspect-[9/16] max-h-[290px] w-full cursor-pointer items-center justify-center overflow-hidden bg-gradient-to-b from-[#151722] to-[#2d3150] text-white"
            :disabled="!videoOf(t)"
            :title="videoOf(t) ? '播放预览' : '暂无成片'"
            @click="videoOf(t) && togglePlay(t.id)"
          >
            <!-- 第一帧预览：原生 video 截帧（#t=0.1），加载失败回退渐变底 -->
            <video
              v-if="videoOf(t)"
              :src="`${base}${videoOf(t)!.url}#t=0.1`"
              preload="metadata"
              muted
              playsinline
              class="absolute inset-0 h-full w-full object-cover"
            />
            <Play class="relative h-12 w-12 text-white drop-shadow-[0_2px_8px_rgba(0,0,0,0.6)]" aria-hidden="true" />
          </button>
          <div class="p-[13px]">
            <b class="mb-1.5 block leading-snug">{{ t.title }}</b>
            <div class="flex flex-wrap gap-1.5">
              <span class="rounded-full bg-[#f1f2f5] px-[7px] py-1 text-[11px]">{{ t.template }}</span>
              <span class="rounded-full bg-[#f1f2f5] px-[7px] py-1 text-[11px]">{{ String(t.level) }}</span>
              <span class="rounded-full bg-[#f1f2f5] px-[7px] py-1 text-[11px]">{{ fmtDuration(videoOf(t)?.duration ?? 0) }}</span>
              <span class="rounded-full bg-[#f1f2f5] px-[7px] py-1 text-[11px]">词汇 {{ t.wordsCount }}</span>
              <span
                v-if="marksOfTask(t).length > 0"
                class="rounded-full bg-emerald-50 px-[7px] py-1 text-[11px] text-emerald-700"
              >
                已标记 ×{{ marksOfTask(t).length }}
              </span>
            </div>
            <div class="mt-2.5 flex items-center justify-between gap-2">
              <span
                class="rounded px-1.5 py-0.5 text-xs"
                :class="t.status === 'completed' ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-600'"
              >
                {{ STATUS_LABEL[String(t.status)] ?? String(t.status) }}
              </span>
              <div class="flex gap-2">
                <button
                  class="inline-flex cursor-pointer items-center gap-1 rounded-[10px] border border-hairline bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
                  @click="openMarkManager(t)"
                >
                  <Tag class="h-3.5 w-3.5" aria-hidden="true" /> 标记
                </button>
                <button
                  class="cursor-pointer rounded-[10px] border border-hairline bg-white px-3 py-1.5 text-xs text-bad hover:bg-red-50"
                  @click="requestDelete(t.id)"
                >
                  删除
                </button>
              </div>
            </div>
          </div>
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
    <UploadMarkManager
      ref="markManager"
      :filename="markFilename"
      :task-id="markTaskId"
      @change="loadMarks"
    />
  </div>
</template>
