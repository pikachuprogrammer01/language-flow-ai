<script setup lang="ts">
// 视频资产页（PRD 10.1.5）：已有成片的记录列表 / 播放 / 重命名 / 删除
import { onMounted, ref } from "vue";
import { toast } from "vue-sonner";
import { deleteTask, listTasks, updateTask } from "../api/client";
import ConfirmDialog from "../components/ui/confirm-dialog.vue";

type VideoAsset = NonNullable<Awaited<ReturnType<typeof listTasks>>["tasks"]>[number];

const loading = ref(true);
const errorMsg = ref("");
const assets = ref<VideoAsset[]>([]);
/** 播放展开的 id */
const playing = ref<Set<string>>(new Set());
/** 重命名状态：id → 输入值 */
const renaming = ref<string>("");
const renameValue = ref("");
const savingRename = ref(false);
/** 删除确认 */
const deleteOpen = ref(false);
const pendingDeleteId = ref("");

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

function startRename(t: VideoAsset): void {
  renaming.value = t.id;
  renameValue.value = t.title;
}

/** 重命名保存（PATCH title，与记录编辑共用接口） */
async function saveRename(): Promise<void> {
  const title = renameValue.value.trim();
  if (!title || !renaming.value) return;
  savingRename.value = true;
  try {
    await updateTask(renaming.value, { title });
    toast.success("标题已更新");
    renaming.value = "";
    await load();
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    savingRename.value = false;
  }
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

onMounted(load);
</script>

<template>
  <div class="mx-auto max-w-5xl px-6 py-10">
    <h1 class="text-xl font-bold">视频资产</h1>
    <p class="mt-1 text-sm text-gray-500">已有成片的生成记录：播放 / 重命名 / 删除（关联生成记录）</p>

    <p v-if="errorMsg" class="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-600">{{ errorMsg }}</p>
    <p v-else-if="loading" class="mt-6 text-center text-sm text-gray-400">加载中…</p>
    <p v-else-if="assets.length === 0" class="mt-6 text-center text-sm text-gray-400">暂无视频资产（先完成生成与渲染）</p>

    <div v-else class="mt-4 space-y-3">
      <div v-for="t in assets" :key="t.id" class="rounded-lg border bg-white p-4">
        <div class="flex items-center justify-between gap-4">
          <div class="min-w-0">
            <template v-if="renaming === t.id">
              <input
                v-model="renameValue"
                class="w-72 rounded-lg border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                maxlength="255"
                @keyup.enter="saveRename"
              />
              <button
                class="ml-2 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                :disabled="savingRename"
                @click="saveRename"
              >
                保存
              </button>
              <button class="ml-2 rounded-lg border px-3 py-1.5 text-xs hover:bg-gray-100" @click="renaming = ''">
                取消
              </button>
            </template>
            <template v-else>
              <span class="font-medium">{{ t.title }}</span>
              <button class="ml-2 text-xs text-blue-600 hover:underline" @click="startRename(t)">重命名</button>
            </template>
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
              <span>{{ new Date(String(t.createdAt)).toLocaleString("zh-CN") }}</span>
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-2">
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
        <!-- 行内播放器 -->
        <video
          v-if="playing.has(t.id) && videoOf(t)"
          :src="videoOf(t)!.url"
          controls
          class="mt-3 w-full max-w-md rounded-lg bg-black"
        />
      </div>
    </div>

    <!-- 删除确认对话框（shadcn-vue AlertDialog） -->
    <ConfirmDialog
      v-model:open="deleteOpen"
      title="删除视频资产"
      description="确定删除这条视频及其生成记录吗？"
      confirm-text="删除"
      destructive
      @confirm="doDelete"
    />
  </div>
</template>
