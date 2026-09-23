<script setup lang="ts">
import { Play, Tag } from "lucide-vue-next";
/**
 * 文件管理页 — 分类管理（视频=成片 / 配音=生成的音频 / BGM=背景音乐素材）
 * 数据源：GET /api/files（分类 + inUse 标记）+ DELETE /api/files/:filename?type=
 */
import {
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from "reka-ui";
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { type UploadMark, batchDeleteFiles, deleteFile, listFiles } from "../api/client";
import ConfirmDialog from "../components/ui/confirm-dialog.vue";
import DataTable from "../components/ui/data-table.vue";
// biome-ignore lint/style/useImportType: 组件在 Vue 模板中使用（biome 不感知模板标签）
import UploadMarkManager from "../components/upload-mark-manager.vue";
import { useUploadMarks } from "../composables/use-upload-marks";
import type { DataTableColumn } from "../lib/data-table";
import { toast } from "../lib/toast";

/** 文件条目（GET /api/files 响应结构） */
interface FileItem {
  filename: string;
  type: "audio" | "video" | "bgm";
  size: number;
  mtime: string;
  inUse: boolean;
  referencedBy: { id: string; title: string }[];
}

/** 列定义：主题列为分组列（同任务视频+配音 rowspan 合并居中） */
const COLUMNS: DataTableColumn[] = [
  { key: "filename", label: "文件名", cellClass: "min-w-[220px]" },
  { key: "topic", label: "主题", group: true, cellClass: "min-w-[140px] text-center align-middle" },
  { key: "type", label: "类型" },
  { key: "size", label: "大小", cellClass: "whitespace-nowrap" },
  { key: "mtime", label: "修改时间" },
  { key: "refs", label: "引用", cellClass: "whitespace-nowrap" },
  { key: "marks", label: "标记" },
  { key: "actions", label: "操作", cellClass: "text-right" },
];
const rowKey = (f: FileItem): string => `${f.type}/${f.filename}`;
/** 分组键：被同一生成记录引用的文件（成片+其配音）为一组；未引用文件各自成组 */
const groupKeyOf = (f: FileItem): string => f.referencedBy[0]?.id ?? `solo:${f.type}/${f.filename}`;
/** 分组主题名（所属生成记录标题） */
const topicOf = (f: FileItem): string => f.referencedBy[0]?.title ?? "未引用";
const router = useRouter();
/** 播放器弹窗当前文件（替代展开行，避免与分组 rowspan 布局冲突） */
const playerFile = ref<FileItem | null>(null);
/** 客户端分页状态 */
const page = ref(1);
const pageSize = ref(10);

/** 静态文件基址（播放器拼完整 URL） */
const base = (import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080").replace(/\/$/, "");
const files = ref<FileItem[]>([]);
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

const filtered = computed(() => {
  const list =
    filter.value === "all" ? files.value : files.value.filter((f) => f.type === filter.value);
  // 按分组键聚合（保持首次出现顺序），组内成片在前、配音紧随，避免同源音频分散
  const order: string[] = [];
  const byGroup = new Map<string, FileItem[]>();
  for (const f of list) {
    const key = groupKeyOf(f);
    const bucket = byGroup.get(key);
    if (bucket) bucket.push(f);
    else {
      byGroup.set(key, [f]);
      order.push(key);
    }
  }
  const typeRank: Record<FileItem["type"], number> = { video: 0, audio: 1, bgm: 2 };
  return order.flatMap((key) =>
    [...(byGroup.get(key) ?? [])].sort((a, b) => typeRank[a.type] - typeRank[b.type]),
  );
});

const totalSize = computed(() => files.value.reduce((n, f) => n + f.size, 0));

/** 分类指标卡（原型 #files grid4）：数量 + 占用，可清理 = 未引用的视频/配音 */
const typeStats = computed(() => {
  const pick = (type: "video" | "audio" | "bgm") => files.value.filter((f) => f.type === type);
  const orphans = files.value.filter((f) => f.type !== "bgm" && f.referencedBy.length === 0);
  const sum = (list: { size: number }[]) => list.reduce((n, f) => n + f.size, 0);
  return [
    { label: "视频文件", count: pick("video").length, size: sum(pick("video")) },
    { label: "音频文件", count: pick("audio").length, size: sum(pick("audio")) },
    { label: "BGM", count: pick("bgm").length, size: sum(pick("bgm")) },
    { label: "可清理", count: orphans.length, size: sum(orphans) },
  ];
});

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
  // 文件名随 open() 同步传入，避免 prop 渲染时序竞态导致按旧文件名（或空）拉取全量标记
  markManager.value?.open(filename);
}

/** 清理未引用文件：全局范围（不受当前 Tab 影响），删除联动清标记；BGM 素材永不清理 */
const cleanupOpen = ref(false);
const cleanupTip = ref("");

const collectOrphans = (): {
  filename: string;
  type: "audio" | "video" | "bgm";
}[] =>
  files.value
    .filter((f) => f.type !== "bgm" && f.referencedBy.length === 0)
    .map((f) => ({ filename: f.filename, type: f.type }));

function openCleanup(): void {
  const orphans = collectOrphans();
  if (orphans.length === 0) {
    toast.success("没有可清理的未引用文件");
    return;
  }
  const videos = orphans.filter((f) => f.type === "video").length;
  const audios = orphans.length - videos;
  cleanupTip.value = `将删除 ${orphans.length} 个未被任何生成记录引用的文件（视频 ${videos} 个、配音 ${audios} 个，含其上传标记），不可恢复。BGM 素材不受影响。`;
  cleanupOpen.value = true;
}

async function doCleanup(): Promise<void> {
  const orphans = collectOrphans();
  try {
    // 默认走服务端引用安全网（force 缺省 false）：列表快照过期时被新记录引用的文件会被跳过
    const result = await batchDeleteFiles(
      orphans.map((f) => ({ filename: f.filename, type: f.type })),
    );
    await load();
    await loadMarks();
    const parts = [`已清理 ${result.deleted} 个未引用文件`];
    if (result.skipped.length > 0) parts.push(`${result.skipped.length} 个因被引用而跳过`);
    if (result.errors.length > 0) parts.push(`${result.errors.length} 个失败`);
    if (result.skipped.length > 0 || result.errors.length > 0) {
      toast.warning(parts.join("；"));
    } else {
      toast.success(parts[0]);
    }
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

function switchFilter(next: "all" | "video" | "audio" | "bgm"): void {
  // 切换分类时清空选中与播放器：避免跨 Tab 残留导致误删
  filter.value = next;
  selected.value = new Set();
  playerFile.value = null;
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

/** 执行批量删除（ConfirmDialog 确认后）：用户已逐项勾选并确认，force 跳过引用检查 */
async function doBatchRemove(): Promise<void> {
  try {
    const items = [...selected.value].map((k) => {
      const [type, filename] = k.split("/");
      return { type, filename } as { type: "audio" | "video" | "bgm"; filename: string };
    });
    const result = await batchDeleteFiles(items, { force: true });
    selected.value = new Set();
    await load();
    await loadMarks();
    const parts = [`已删除 ${result.deleted} 个文件`];
    if (result.notFound.length > 0) parts.push(`${result.notFound.length} 个不存在（已忽略）`);
    if (result.errors.length > 0) {
      parts.push(
        `${result.errors.length} 个失败（${result.errors.map((e) => e.filename).join("、")}）`,
      );
      toast.warning(parts.join("；"));
    } else {
      toast.success(parts.join("；"));
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
  <div class="px-7 pt-[26px] pb-12">
    <!-- Hero（原型 #files） -->
    <section class="mb-[22px] flex items-end justify-between gap-5">
      <div>
        <h1 class="mb-1.5 text-[26px] font-bold">文件管理</h1>
        <p class="text-subtle">管理 audio / video / bgm 本地资产。</p>
      </div>
      <div class="flex gap-2.5">
        <button
          class="cursor-pointer rounded-[10px] border border-hairline bg-white px-3.5 py-[9px] hover:bg-gray-50"
          @click="load"
        >
          刷新
        </button>
        <button
          class="cursor-pointer rounded-[10px] border border-warn/40 bg-[#fff8e8] px-3.5 py-[9px] text-warn hover:bg-[#fdefc8]"
          title="删除未被任何生成记录引用的视频和配音文件"
          @click="openCleanup"
        >
          清理无引用文件
        </button>
      </div>
    </section>

    <p v-if="errorMsg" class="mb-4 rounded-xl bg-red-50 p-3 text-sm text-red-600">{{ errorMsg }}</p>
    <p v-if="loading" class="py-8 text-center text-sm text-subtle">加载中…</p>

    <template v-else>
      <!-- 指标卡（原型 grid4 .metric） -->
      <div class="mb-[22px] grid grid-cols-4 gap-3.5 max-lg:grid-cols-2">
        <div v-for="s in typeStats" :key="s.label" class="rounded-2xl border border-hairline bg-panel p-[18px]">
          <p class="text-[13px] text-subtle">{{ s.label }}</p>
          <p class="mt-2 text-[30px] leading-none font-extrabold">{{ s.count }}</p>
          <p class="mt-1.5 text-xs text-subtle">{{ fmtSize(s.size) }}</p>
        </div>
      </div>

      <p class="mb-4 text-sm text-subtle">
        共 {{ files.length }} 个文件，合计 {{ fmtSize(totalSize) }}；「未引用」= 未被任何生成记录使用，可安全清理
      </p>

      <!-- 分类 Tab：视频 / 配音 / BGM 分开管理 -->
      <div class="mb-4 flex flex-wrap items-center gap-2">
        <button
          v-for="f in (['all', 'video', 'audio', 'bgm'] as const)"
          :key="f"
          class="cursor-pointer rounded-[10px] border px-3 py-[7px] text-sm"
          :class="filter === f ? 'border-brand bg-brand text-white' : 'border-hairline bg-white hover:bg-gray-50'"
          @click="switchFilter(f)"
        >
          {{ f === "all" ? `全部（${files.length}）` : `${TYPE_LABEL[f]}（${files.filter((x) => x.type === f).length}）` }}
        </button>
        <span class="ml-auto flex items-center gap-2">
          <button
            class="cursor-pointer rounded-[10px] border px-3.5 py-[9px] text-sm text-bad hover:bg-red-50 disabled:opacity-40"
            :class="selected.size === 0 ? 'border-hairline bg-white' : 'border-red-200 bg-white'"
            :disabled="selected.size === 0"
            @click="batchRemove"
          >
            批量删除（{{ selected.size }}）
          </button>
        </span>
      </div>

      <!-- 统一表格：勾选/分页/分组主题列（同任务成片+配音合并） -->
      <DataTable
        :columns="COLUMNS"
        :rows="filtered"
        :row-key="rowKey"
        :group-key="groupKeyOf"
        v-model:page="page"
        v-model:page-size="pageSize"
        v-model:selected="selected"
        :loading="loading"
        selectable
        empty-text="没有匹配的文件"
      >
        <template #cell-filename="{ row }">
          <button
            class="flex cursor-pointer items-center gap-1.5 text-left font-mono text-xs text-ink hover:text-brand"
            title="播放预览"
            @click="playerFile = row"
          >
            <Play class="h-3.5 w-3.5 shrink-0 text-gray-400" aria-hidden="true" />
            {{ row.filename }}
          </button>
        </template>
        <template #cell-topic="{ row }">
          <span
            class="text-xs"
            :class="row.referencedBy.length > 0 ? 'font-medium text-ink' : 'text-gray-400'"
            >{{ topicOf(row) }}</span
          >
        </template>
        <template #cell-type="{ row }">
          <span class="whitespace-nowrap rounded bg-[#f2f3f6] px-1.5 py-0.5 text-xs">{{ TYPE_LABEL[row.type] }}</span>
          <span v-if="row.type === 'audio' && row.referencedBy.length > 0" class="ml-1.5 whitespace-nowrap text-[11px] text-brand">
            🔗 与上方成片同源
          </span>
        </template>
        <template #cell-size="{ row }">{{ fmtSize(row.size) }}</template>
        <template #cell-mtime="{ row }">
          <span class="whitespace-nowrap text-gray-500">{{ new Date(row.mtime).toLocaleString("zh-CN") }}</span>
        </template>
        <template #cell-refs="{ row }">
          <span v-if="row.referencedBy.length > 0" class="flex flex-wrap items-center gap-1">
            <button
              v-for="r in row.referencedBy.slice(0, 2)"
              :key="r.id"
              class="max-w-[160px] cursor-pointer truncate rounded bg-brand-soft px-1.5 py-0.5 text-xs text-brand hover:bg-[#ece9ff]"
              :title="r.title"
              @click.stop="router.push(`/tasks/${r.id}`)"
            >
              {{ r.title }}
            </button>
            <span v-if="row.referencedBy.length > 2" class="text-xs text-gray-400">等 {{ row.referencedBy.length }} 条</span>
          </span>
          <span v-else class="text-xs text-warn">未引用</span>
        </template>
        <template #cell-marks="{ row }">
          <span v-if="row.type === 'video' && marksOfFile(row).length > 0" class="flex flex-wrap items-center gap-1">
            <span
              v-for="m in marksOfFile(row).slice(0, 3)"
              :key="m.id"
              class="rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-700"
              :title="m.note ?? undefined"
            >
              {{ m.platform }}
            </span>
            <span v-if="marksOfFile(row).length > 3" class="text-xs text-gray-400">等 {{ marksOfFile(row).length }} 个平台</span>
          </span>
          <span v-else class="text-xs text-gray-400">—</span>
        </template>
        <template #cell-actions="{ row }">
          <div class="flex justify-end gap-2 whitespace-nowrap" @click.stop>
            <button
              v-if="row.type === 'video'"
              class="inline-flex cursor-pointer items-center gap-1 rounded-[10px] border border-hairline bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
              @click="openMarkManager(row.filename)"
            >
              <Tag class="h-3.5 w-3.5" aria-hidden="true" /> 标记
            </button>
            <button
              class="cursor-pointer rounded-[10px] border border-hairline bg-white px-3 py-1.5 text-xs text-bad hover:bg-red-50"
              @click="remove(row)"
            >
              删除
            </button>
          </div>
        </template>
      </DataTable>
    </template>
  </div>

  <!-- 播放器弹窗（视频试看/音频试听，不挤占表格行布局） -->
  <DialogRoot :open="Boolean(playerFile)" @update:open="(v: boolean) => (v ? null : (playerFile = null))">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-40 bg-black/50" />
      <DialogContent
        class="fixed left-1/2 top-1/2 z-50 w-[560px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-hairline bg-panel p-4 shadow-lg"
      >
        <DialogTitle class="text-sm font-semibold">{{ playerFile?.filename }}</DialogTitle>
        <video
          v-if="playerFile?.type === 'video'"
          :src="`${base}/files/video/${playerFile.filename}`"
          controls
          autoplay
          class="mt-3 max-h-[60vh] w-full rounded-xl bg-black"
        />
        <audio
          v-else-if="playerFile"
          :src="`${base}/files/${playerFile.type}/${playerFile.filename}`"
          controls
          autoplay
          class="mt-3 w-full"
        />
        <div class="mt-3 flex justify-end">
          <DialogClose class="cursor-pointer rounded-[10px] border border-hairline bg-white px-4 py-1.5 text-sm hover:bg-gray-50">关闭</DialogClose>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>

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
    title="清理未引用文件"
    :description="cleanupTip"
    confirm-text="清理"
    destructive
    @confirm="doCleanup"
  />

  <!-- 上传标记管理 -->
  <UploadMarkManager ref="markManager" :filename="markFilename" @change="loadMarks" />
</template>
