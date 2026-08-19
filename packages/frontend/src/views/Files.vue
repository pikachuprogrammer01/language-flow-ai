<script setup lang="ts">
/**
 * 文件管理页 — 分类管理（视频=成片 / 配音=生成的音频 / BGM=背景音乐素材）
 * 数据源：GET /api/files（分类 + inUse 标记）+ DELETE /api/files/:filename?type=
 */
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { toast } from "vue-sonner";
import { type UploadMark, batchDeleteFiles, deleteFile, listFiles } from "../api/client";
import FileRow from "../components/file-row.vue";
import ConfirmDialog from "../components/ui/confirm-dialog.vue";
// biome-ignore lint/style/useImportType: 组件在 Vue 模板中使用（biome 不感知模板标签）
import UploadMarkManager from "../components/upload-mark-manager.vue";
import { useUploadMarks } from "../composables/use-upload-marks";

const router = useRouter();

const base = (import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080").replace(/\/$/, "");
const files = ref<
  {
    filename: string;
    type: "audio" | "video" | "bgm";
    size: number;
    mtime: string;
    inUse: boolean;
    referencedBy: { id: string; title: string }[];
  }[]
>([]);
const filter = ref<"all" | "video" | "audio" | "bgm">("all");
const loading = ref(true);
const errorMsg = ref("");
/** 批量选择（key = type/filename） */
const selected = ref<Set<string>>(new Set());
/** 删除确认对话框状态 */
const confirmOpen = ref(false);
const pendingDelete = ref<{
  filename: string;
  type: "audio" | "video" | "bgm";
  inUse: boolean;
} | null>(null);
const batchOpen = ref(false);
const batchTip = ref("");

const TYPE_LABEL: Record<string, string> = {
  video: "视频（成片）",
  audio: "音频（配音）",
  bgm: "BGM（背景音乐）",
};

const filtered = computed(() =>
  filter.value === "all" ? files.value : files.value.filter((f) => f.type === filter.value),
);

const totalSize = computed(() => files.value.reduce((n, f) => n + f.size, 0));

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function load(): Promise<void> {
  loading.value = true;
  errorMsg.value = "";
  try {
    const data = await listFiles();
    files.value = data.files;
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

/** 上传标记索引（useUploadMarks：一次全量拉取，四页面共用） */
const { loadMarks, marksOf } = useUploadMarks();

function marksOfFile(f: { filename: string }): UploadMark[] {
  return marksOf(f.filename);
}

/** 上传标记弹窗 */
const markManager = ref<InstanceType<typeof UploadMarkManager> | null>(null);
const markFilename = ref("");

function openMarkManager(filename: string): void {
  markFilename.value = filename;
  markManager.value?.open();
}

/** 清理未引用文件：仅视频分类（无记录引用），删除联动清标记 */
const cleanupOpen = ref(false);
const cleanupTip = ref("");

function openCleanup(): void {
  const orphans = filtered.value.filter((f) => f.type === "video" && f.referencedBy.length === 0);
  if (orphans.length === 0) {
    toast.success("没有可清理的未引用视频");
    return;
  }
  cleanupTip.value = `将删除 ${orphans.length} 个未被任何生成记录引用的视频文件（含其上传标记），不可恢复。仅视频分类，BGM 与配音素材不受影响。`;
  cleanupOpen.value = true;
}

async function doCleanup(): Promise<void> {
  const orphans = filtered.value.filter((f) => f.type === "video" && f.referencedBy.length === 0);
  try {
    const result = await batchDeleteFiles(
      orphans.map((f) => ({ filename: f.filename, type: "video" as const })),
    );
    await load();
    await loadMarks();
    toast.success(`已清理 ${result.deleted} 个未引用视频`);
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    cleanupOpen.value = false;
  }
}

async function remove(f: {
  filename: string;
  type: "audio" | "video" | "bgm";
  inUse: boolean;
}): Promise<void> {
  // 确认对话框（ConfirmDialog 状态在模板中管理）
  pendingDelete.value = { filename: f.filename, type: f.type, inUse: f.inUse };
  confirmOpen.value = true;
}

/** 执行单个删除（ConfirmDialog 确认后） */
async function doRemove(): Promise<void> {
  if (!pendingDelete.value) return;
  try {
    await deleteFile(pendingDelete.value.filename, pendingDelete.value.type);
    await load();
    await loadMarks();
    toast.success("文件已删除");
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    pendingDelete.value = null;
  }
}

/** 删除确认描述：素材（BGM/配音）强确认，视频按引用状态提示 */
const deleteTip = computed(() => {
  const f = pendingDelete.value;
  if (!f) return "";
  if (f.type !== "video") {
    return `该文件为${f.type === "bgm" ? "BGM" : "配音"}素材，删除后不可恢复，请确认。`;
  }
  return f.inUse ? "该文件被生成记录引用，删除后记录中的视频/音频将无法播放" : "确定删除该文件？";
});

function keyOf(f: { filename: string; type: string }): string {
  return `${f.type}/${f.filename}`;
}

const allFilteredSelected = computed<boolean>({
  get: () => filtered.value.length > 0 && filtered.value.every((f) => selected.value.has(keyOf(f))),
  set: (checked: boolean) => {
    // 全选 = 当前 Tab 可见的全部；取消 = 仅移除当前 Tab 的（跨 Tab 残留选中保留）
    const next = new Set(selected.value);
    for (const f of filtered.value) {
      if (checked) next.add(keyOf(f));
      else next.delete(keyOf(f));
    }
    selected.value = next;
  },
});

function switchFilter(next: "all" | "video" | "audio" | "bgm"): void {
  // 切换分类时清空选中：全选语义 = 当前 Tab 可见文件，避免跨 Tab 残留导致误删
  filter.value = next;
  selected.value = new Set();
}

function toggle(f: { filename: string; type: "audio" | "video" | "bgm" }): void {
  const k = keyOf(f);
  const next = new Set(selected.value);
  if (next.has(k)) next.delete(k);
  else next.add(k);
  selected.value = next;
}

async function batchRemove(): Promise<void> {
  if (selected.value.size === 0) return;
  const hasReferenced = [...selected.value]
    .map((k) => files.value.find((f) => keyOf(f) === k))
    .some((f) => f?.inUse);
  // 按分类统计，让用户看清删除范围（selected 可能跨分类）
  const byType = { video: 0, audio: 0, bgm: 0 };
  for (const k of selected.value) {
    const [type] = k.split("/");
    if (type === "video" || type === "audio" || type === "bgm") byType[type] += 1;
  }
  const scope = `视频 ${byType.video} 个、配音 ${byType.audio} 个、BGM ${byType.bgm} 个`;
  // 批量删除确认信息 → 对话框
  batchTip.value = hasReferenced
    ? `选中的 ${selected.value.size} 个文件（${scope}）中包含被记录引用的文件，删除后对应记录中的视频/音频将无法播放`
    : `确定删除选中的 ${selected.value.size} 个文件（${scope}）？`;
  batchOpen.value = true;
}

/** 执行批量删除（ConfirmDialog 确认后） */
async function doBatchRemove(): Promise<void> {
  try {
    const items = [...selected.value].map((k) => {
      const [type, filename] = k.split("/");
      return { type, filename } as { type: "audio" | "video" | "bgm"; filename: string };
    });
    const result = await batchDeleteFiles(items);
    selected.value = new Set();
    await load();
    await loadMarks();
    if (result.errors.length > 0) {
      toast.error(
        `已删除 ${result.deleted} 个；${result.errors.length} 个失败（${result.errors.map((e) => e.filename).join("、")}）`,
      );
    } else {
      toast.success(`已删除 ${result.deleted} 个文件`);
    }
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  }
}

onMounted(() => {
  void load();
  void loadMarks();
});
</script>

<template>
  <div class="mx-auto max-w-4xl px-6 py-10">
    <div class="mb-6 flex items-center justify-between">
      <h1 class="text-2xl font-bold">文件管理</h1>
      <button class="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-100" @click="load">刷新</button>
    </div>

    <p v-if="errorMsg" class="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-600">{{ errorMsg }}</p>
    <p v-if="loading" class="py-8 text-center text-gray-500">加载中…</p>

    <template v-else>
      <p class="mb-4 text-sm text-gray-500">
        共 {{ files.length }} 个文件，合计 {{ fmtSize(totalSize) }}；「未引用」= 未被任何生成记录使用，可安全清理
      </p>

      <!-- 分类 Tab：视频 / 配音 / BGM 分开管理 -->
      <div class="mb-4 flex flex-wrap items-center gap-2">
        <button
          v-for="f in (['all', 'video', 'audio', 'bgm'] as const)"
          :key="f"
          class="rounded-lg border px-3 py-1.5 text-sm"
          :class="filter === f ? 'bg-blue-600 text-white' : 'hover:bg-gray-100'"
          @click="switchFilter(f)"
        >
          {{ f === "all" ? `全部（${files.length}）` : `${TYPE_LABEL[f]}（${files.filter((x) => x.type === f).length}）` }}
        </button>
        <span class="ml-auto flex items-center gap-2">
          <button
            class="rounded-lg border px-3 py-1.5 text-sm text-orange-600 hover:bg-orange-50"
            title="删除未被任何生成记录引用的视频文件"
            @click="openCleanup"
          >
            清理未引用
          </button>
          <label v-if="filtered.length > 0" class="flex items-center gap-1 text-sm text-gray-600">
            <input type="checkbox" v-model="allFilteredSelected" />
            全选本页
          </label>
          <button
            class="rounded-lg border px-3 py-1.5 text-sm text-red-500 hover:bg-red-50 disabled:opacity-40"
            :disabled="selected.size === 0"
            @click="batchRemove"
          >
            批量删除（{{ selected.size }}）
          </button>
        </span>
      </div>

      <ul class="space-y-3">
        <FileRow
          v-for="f in filtered"
          :key="`${f.type}-${f.filename}`"
          :f="f"
          :marks="marksOfFile(f)"
          :selected="selected.has(`${f.type}/${f.filename}`)"
          @toggle-select="toggle(f)"
          @open-marks="openMarkManager(f.filename)"
          @remove="remove(f)"
        />
      </ul>
      <p v-if="filtered.length === 0" class="py-10 text-center text-gray-400">没有匹配的文件</p>
    </template>
  </div>

  <!-- 删除确认对话框（shadcn-vue AlertDialog，替代原生 confirm） -->
  <ConfirmDialog
    v-model:open="confirmOpen"
    :title="pendingDelete?.type === 'video' ? '删除文件' : '删除素材'"
    :description="deleteTip"
    confirm-text="删除"
    destructive
    @confirm="doRemove"
  />
  <ConfirmDialog
    v-model:open="batchOpen"
    title="批量删除"
    :description="batchTip"
    confirm-text="删除"
    destructive
    @confirm="doBatchRemove"
  />
  <ConfirmDialog
    v-model:open="cleanupOpen"
    title="清理未引用视频"
    :description="cleanupTip"
    confirm-text="清理"
    destructive
    @confirm="doCleanup"
  />

  <!-- 上传标记管理 -->
  <UploadMarkManager ref="markManager" :filename="markFilename" @change="loadMarks" />
</template>
