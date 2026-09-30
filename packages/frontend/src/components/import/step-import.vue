<script setup lang="ts">
import { FileSpreadsheet, Upload } from "lucide-vue-next";
import { computed, ref } from "vue";
/**
 * STEP 1 导入数据：上传 CSV/XLSX → 服务端字段识别 + 数据粒度三态判定
 * 粒度判定是本步最重要功能（大卡明示 + 判定依据可解释）；
 * ACCOUNT_DAY_LEVEL 明确警示「无法精确归属到单条作品」，只能保存为账号日级数据。
 * 手动调整只允许降级（strong→weak→account_day），禁止升格。
 */
import * as XLSX from "xlsx";
import type { ImportBatchView, ImportGranularity, ImportRowListItem } from "../../api/client";
import { parsePastedTable } from "../../lib/analytics-import";
import { formatFileSize, granularityMeta } from "../../lib/import-batch";
import Button from "../ui/button.vue";
import Select, { type SelectOption } from "../ui/select.vue";
import Spinner from "../ui/spinner.vue";

const props = defineProps<{
  view: ImportBatchView | null;
  /** 服务端创建/确认中 */
  busy: boolean;
  /** 前 10 条预览（刷新后从 rows API 恢复） */
  previewRows: ImportRowListItem[];
}>();

const emit = defineEmits<{
  create: [
    payload: {
      filename: string;
      fileSize: number;
      fileHash: string;
      platform: string;
      headers: string[];
      rows: string[][];
    },
  ];
  redetect: [fieldOverride: Record<string, string | null>];
  confirm: [granularity: ImportGranularity];
}>();

type UploadState = "idle" | "parsing" | "parsed" | "parse_failed";
const uploadState = ref<UploadState>("idle");
const parseError = ref("");

/** 批次声明平台（与 publish_records.platform 同口径自由文本；行内平台差异由 STEP2 平台映射消化） */
const platform = ref("抖音");
const PLATFORM_OPTIONS: SelectOption[] = [
  { value: "抖音", label: "抖音" },
  { value: "快手", label: "快手" },
  { value: "视频号", label: "视频号" },
  { value: "B站", label: "B站" },
  { value: "小红书", label: "小红书" },
];

const MAX_ROWS = 5000;

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 单元格 → 字符串（Date 归一 YYYY-MM-DD，与旧解析口径一致） */
function cellText(cell: unknown): string {
  if (cell === null || cell === undefined) return "";
  if (cell instanceof Date && !Number.isNaN(cell.getTime())) return cell.toISOString().slice(0, 10);
  return String(cell).trim();
}

async function handleFile(file: File): Promise<void> {
  uploadState.value = "parsing";
  parseError.value = "";
  try {
    const buffer = await file.arrayBuffer();
    const lower = file.name.toLowerCase();
    let headers: string[] = [];
    let rows: string[][] = [];
    if (lower.endsWith(".csv") || lower.endsWith(".txt")) {
      const parsed = parsePastedTable(new TextDecoder().decode(buffer));
      if (!parsed) throw new Error("CSV 至少需要表头行 + 1 行数据（两列以上）");
      headers = parsed.headers;
      rows = parsed.rows;
    } else if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
      const wb = XLSX.read(buffer, { type: "array", cellDates: true });
      const first = wb.SheetNames[0];
      const sheet = first !== undefined ? wb.Sheets[first] : undefined;
      if (!sheet) throw new Error("文件里没有工作表");
      const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        raw: true,
        blankrows: false,
        defval: "",
      });
      const cells = matrix
        .map((line) => line.map(cellText))
        .filter((line) => line.some((c) => c !== ""));
      if (cells.length < 2) throw new Error("至少需要表头行 + 1 行数据");
      headers = cells[0] ?? [];
      rows = cells.slice(1);
    } else {
      throw new Error("仅支持 CSV / XLSX 文件");
    }
    if (headers.length < 2) throw new Error("至少需要两列");
    if (rows.length > MAX_ROWS)
      throw new Error(`单次最多 ${MAX_ROWS} 行，当前 ${rows.length} 行，请拆分后导入`);
    const fileHash = await sha256Hex(buffer);
    uploadState.value = "parsed";
    emit("create", {
      filename: file.name,
      fileSize: file.size,
      fileHash,
      platform: platform.value,
      headers,
      rows,
    });
  } catch (err) {
    uploadState.value = "parse_failed";
    parseError.value = err instanceof Error ? err.message : String(err);
  }
}

const dragOver = ref(false);

function onDrop(event: DragEvent): void {
  dragOver.value = false;
  const file = event.dataTransfer?.files?.[0];
  if (file) void handleFile(file);
}

const fileInput = ref<HTMLInputElement | null>(null);

function onFilePicked(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file) void handleFile(file);
  input.value = ""; // 允许重选同一文件
}

// ── 字段识别编辑（改角色 → 带 override 重建批次） ──

/** 不导入哨兵（select.vue 契约：options value 禁空串，「未选择」用哨兵/null 表达） */
const SKIP_VALUE = "__skip__";

const ROLE_OPTIONS: SelectOption[] = [
  { value: SKIP_VALUE, label: "不导入（忽略）" },
  { value: "platform_work_id", label: "平台作品 ID" },
  { value: "work_url", label: "作品链接" },
  { value: "account", label: "账号" },
  { value: "publish_time", label: "发布时间" },
  { value: "date", label: "统计日期" },
  { value: "title", label: "作品标题" },
  { value: "views", label: "播放量" },
  { value: "likes", label: "点赞量" },
  { value: "comments", label: "评论量" },
  { value: "shares", label: "分享量" },
  { value: "completion_rate", label: "完播率" },
  { value: "duration", label: "时长" },
];

const detection = computed(() => props.view?.fieldDetection ?? []);

function onRoleChange(col: number, next: string | null): void {
  const override: Record<string, string | null> = {};
  for (const d of detection.value) {
    override[String(d.col)] =
      d.col === col ? (next === null || next === SKIP_VALUE ? null : next) : d.role;
  }
  emit("redetect", override);
}

// ── 粒度：只允许降级 ──

const GRAN_ORDER: Record<ImportGranularity, number> = {
  work_level_strong: 0,
  work_level_weak: 1,
  account_day_level: 2,
};

const currentGranularity = ref<ImportGranularity | null>(null);
const effectiveGranularity = computed(
  () => currentGranularity.value ?? props.view?.dataGranularity ?? null,
);

const downgradeOptions = computed<SelectOption[]>(() => {
  const g = props.view?.dataGranularity;
  if (!g) return [];
  return (Object.keys(GRAN_ORDER) as ImportGranularity[])
    .filter((x) => GRAN_ORDER[x] >= GRAN_ORDER[g])
    .map((x) => ({ value: x, label: granularityMeta(x).label }));
});

const granMeta = computed(() =>
  effectiveGranularity.value === null ? null : granularityMeta(effectiveGranularity.value),
);

/** 服务端判定依据人话（后端 evidence.note 优先，缺失回退前端静态文案） */
const granNote = computed(() => {
  const ev = props.view?.granularityEvidence as { note?: string } | undefined;
  return ev?.note ?? granMeta.value?.note ?? "";
});

const toneClass = computed(() => {
  switch (granMeta.value?.tone) {
    case "success":
      return "border-green-200 bg-green-50 text-green-800";
    case "warning":
      return "border-amber-200 bg-amber-50 text-amber-800";
    default:
      return "border-red-200 bg-red-50 text-red-800";
  }
});

function onDowngrade(next: string | null): void {
  if (next === "work_level_strong" || next === "work_level_weak" || next === "account_day_level") {
    currentGranularity.value = next;
  }
}
</script>

<template>
  <div class="rounded-2xl border border-hairline bg-panel p-4">
    <h2 class="mb-1 text-[15px] font-bold">① 导入数据</h2>
    <p class="mb-3 text-xs text-subtle">
      先判断「这批数据有没有资格与具体作品建立一一对应」——上传后系统自动识别字段并判定数据粒度。
    </p>

    <!-- 上传区 -->
    <input
      ref="fileInput"
      type="file"
      accept=".csv,.xlsx,.xls"
      class="hidden"
      data-testid="import-file-input"
      @change="onFilePicked"
    />
    <div
      v-if="view === null || busy"
      class="flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-hairline bg-white px-4 py-8 text-center"
      :class="{ 'border-brand bg-brand-soft/40': dragOver }"
      data-testid="import-dropzone"
      @dragover.prevent="dragOver = true"
      @dragleave.prevent="dragOver = false"
      @drop.prevent="onDrop"
    >
      <template v-if="uploadState === 'parsing' || busy">
        <Spinner size="md" />
        <p class="text-xs text-subtle">正在解析文件…</p>
      </template>
      <template v-else-if="uploadState === 'parse_failed'">
        <p class="text-sm font-medium text-red-600" data-testid="import-parse-error">解析失败：{{ parseError }}</p>
        <Button size="sm" variant="outline" @click="uploadState = 'idle'">重试</Button>
      </template>
      <template v-else>
        <FileSpreadsheet class="h-9 w-9 text-brand" aria-hidden="true" />
        <p class="text-[13px]">
          <button class="cursor-pointer font-medium text-brand underline" @click="fileInput?.click()">点击上传</button>
          或拖拽文件到此处
        </p>
        <p class="text-xs text-subtle">支持 .csv .xlsx 格式，单次最多 {{ MAX_ROWS }} 条</p>
        <div class="flex items-center gap-2">
          <span class="text-xs text-subtle">批次平台</span>
          <Select v-model:value="platform" :options="PLATFORM_OPTIONS" size="sm" trigger-class="w-[130px]" data-testid="import-platform" />
        </div>
        <Button size="sm" :disabled="busy" @click="fileInput?.click()">
          <Upload class="h-4 w-4" aria-hidden="true" /> 选择文件
        </Button>
      </template>
    </div>

    <!-- 已创建批次：概要 + 预览 + 字段识别 + 粒度判定 -->
    <template v-if="view !== null">
      <div class="mb-3 flex items-center gap-2.5 rounded-xl border border-hairline bg-white px-3 py-2.5">
        <FileSpreadsheet class="h-7 w-7 shrink-0 text-green-600" aria-hidden="true" />
        <div class="min-w-0 flex-1 text-[13px]">
          <p class="truncate font-medium">{{ view.filename }}</p>
          <p class="text-xs text-subtle">
            {{ formatFileSize(view.fileSize) }} · {{ view.rowCount }} 条记录 · 批次
            <span class="font-mono">{{ view.id }}</span>
          </p>
        </div>
        <button
          class="cursor-pointer text-xs text-subtle underline hover:text-ink"
          data-testid="import-replace"
          @click="fileInput?.click()"
        >
          更换文件
        </button>
      </div>

      <div class="mb-3 grid grid-cols-4 gap-2 text-center">
        <div class="rounded-lg border border-hairline bg-white px-2 py-2">
          <p class="text-[15px] font-bold">{{ view.rowCount }}</p>
          <p class="text-[11px] text-subtle">总行数</p>
        </div>
        <div class="rounded-lg border border-hairline bg-white px-2 py-2">
          <p class="text-[15px] font-bold">{{ view.headers.length }}</p>
          <p class="text-[11px] text-subtle">列数</p>
        </div>
        <div class="rounded-lg border border-hairline bg-white px-2 py-2">
          <p class="text-[15px] font-bold">{{ view.summary?.accountCount ?? "—" }}</p>
          <p class="text-[11px] text-subtle">账号数量</p>
        </div>
        <div class="rounded-lg border border-hairline bg-white px-2 py-2">
          <p class="text-[13px] font-bold leading-[22px]">
            {{ view.summary ? `${view.summary.dateFrom ?? "—"} ~ ${view.summary.dateTo ?? "—"}` : "—" }}
          </p>
          <p class="text-[11px] text-subtle">日期范围</p>
        </div>
      </div>

      <!-- 数据预览（前 10 条，刷新后从服务端恢复） -->
      <h3 class="mb-1.5 text-[13px] font-semibold">数据预览（前 10 条）</h3>
      <div class="mb-3 overflow-x-auto rounded-xl border border-hairline">
        <table class="w-full border-collapse text-left text-xs">
          <thead class="bg-[#fafbfc] text-subtle">
            <tr>
              <th class="border-b border-hairline px-2.5 py-1.5 font-semibold">#</th>
              <th class="border-b border-hairline px-2.5 py-1.5 font-semibold">日期</th>
              <th class="border-b border-hairline px-2.5 py-1.5 font-semibold">账号</th>
              <th class="border-b border-hairline px-2.5 py-1.5 font-semibold">作品标题</th>
              <th class="border-b border-hairline px-2.5 py-1.5 font-semibold">作品 ID</th>
              <th class="border-b border-hairline px-2.5 py-1.5 font-semibold">播放量</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-hairline bg-white">
            <tr v-for="r in previewRows" :key="r.rowId">
              <td class="px-2.5 py-1.5 text-subtle">{{ r.rowNumber }}</td>
              <td class="whitespace-nowrap px-2.5 py-1.5 font-mono">{{ r.imported.date ?? "—" }}</td>
              <td class="px-2.5 py-1.5">{{ r.imported.account ?? "—" }}</td>
              <td class="max-w-[260px] truncate px-2.5 py-1.5">{{ r.imported.title ?? "—" }}</td>
              <td class="max-w-[180px] truncate px-2.5 py-1.5 font-mono">{{ r.imported.platformWorkId ?? "—" }}</td>
              <td class="px-2.5 py-1.5">{{ r.imported.views ?? "—" }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 数据粒度判定大卡（本步最重要功能） -->
      <div v-if="granMeta" class="mb-3 rounded-xl border px-4 py-3" :class="toneClass" data-testid="granularity-banner">
        <div class="flex flex-wrap items-center gap-2">
          <span class="rounded-full bg-white/70 px-2.5 py-0.5 text-xs font-bold">{{ granMeta.label }}</span>
          <span class="text-[14px] font-bold">{{ granMeta.headline }}</span>
          <span class="ml-auto flex items-center gap-1.5 text-xs">
            <span>手动降级：</span>
            <Select
              :value="effectiveGranularity"
              :options="downgradeOptions"
              size="sm"
              trigger-class="w-[190px]"
              data-testid="granularity-downgrade"
              @update:value="onDowngrade"
            />
          </span>
        </div>
        <p class="mt-1.5 text-xs leading-relaxed">判定依据：{{ granNote }}</p>
        <p v-if="view.dataGranularity === 'account_day_level'" class="mt-1 text-xs font-medium" data-testid="account-day-warning">
          {{ granMeta.note }}
        </p>
      </div>

      <!-- 字段识别表 -->
      <h3 class="mb-1.5 text-[13px] font-semibold">字段识别（可手动修正，改后立即重判）</h3>
      <div class="mb-3 overflow-hidden rounded-xl border border-hairline">
        <table class="w-full border-collapse text-left text-[13px]">
          <thead class="bg-[#fafbfc] text-subtle">
            <tr>
              <th class="border-b border-hairline px-3 py-2 font-semibold">列名</th>
              <th class="border-b border-hairline px-3 py-2 font-semibold">识别为</th>
              <th class="border-b border-hairline px-3 py-2 font-semibold">示例数据</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-hairline bg-white">
            <tr v-for="d in detection" :key="d.col" :data-testid="`detection-row-${d.col}`">
              <td class="px-3 py-1.5 font-mono text-xs">{{ d.header }}</td>
              <td class="w-[230px] px-3 py-1.5">
                <Select
                  :value="d.role ?? SKIP_VALUE"
                  :options="ROLE_OPTIONS"
                  size="sm"
                  @update:value="onRoleChange(d.col, $event)"
                />
              </td>
              <td class="max-w-[280px] truncate px-3 py-1.5 text-xs text-subtle">{{ d.sample || "—" }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="flex items-center justify-between gap-3">
        <Button :disabled="busy" data-testid="import-confirm-granularity" @click="emit('confirm', effectiveGranularity ?? view.dataGranularity)">
          <Spinner v-if="busy" size="sm" /> 确认粒度，下一步：匹配规则 →
        </Button>
      </div>
    </template>
  </div>
</template>
