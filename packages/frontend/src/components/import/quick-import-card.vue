<script setup lang="ts">
import { CircleCheck, FileSpreadsheet, LoaderCircle, TriangleAlert } from "lucide-vue-next";
/**
 * 合集一键导入卡片（快速模式）：选文件 → 服务端无人值守跑完整链路 → 三态结果。
 * 零异常自动入库；任何冲突/未匹配整批不入库并一键带入四步 STEP3（用户裁决 2026-09-28）；
 * 账号日汇总拒绝作品入库（红线），引导四步存账号级。审计痕迹与回滚能力和四步完全一致。
 */
import { ref } from "vue";
import * as XLSX from "xlsx";
import { type QuickImportResult, quickImportBatch } from "../../api/client";
import { parsePastedTable } from "../../lib/analytics-import";
import { toast } from "../../lib/toast";
import Button from "../ui/button.vue";

const emit = defineEmits<{ openBatch: [batchId: string] }>();

const expanded = ref(false);
const state = ref<"idle" | "parsing" | "submitting" | "done">("idle");
const result = ref<QuickImportResult | null>(null);
const fileName = ref("");

const MAX_ROWS = 5000;

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function cellText(cell: unknown): string {
  if (cell === null || cell === undefined) return "";
  if (cell instanceof Date && !Number.isNaN(cell.getTime())) return cell.toISOString().slice(0, 10);
  return String(cell).trim();
}

async function onFilePicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || file.name === "") return;
  state.value = "parsing";
  result.value = null;
  fileName.value = file.name;
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
    if (rows.length > MAX_ROWS) throw new Error(`单次最多 ${MAX_ROWS} 行，请改用四步向导分批处理`);
    const fileHash = await sha256Hex(buffer);
    state.value = "submitting";
    result.value = await quickImportBatch({
      filename: file.name,
      fileSize: file.size,
      fileHash,
      platform: "抖音",
      headers,
      rows,
    });
    state.value = "done";
  } catch (err) {
    state.value = "idle";
    toast.error(err instanceof Error ? err.message : "文件解析失败", { key: "quick-import" });
  }
}

function reset(): void {
  state.value = "idle";
  result.value = null;
  fileName.value = "";
}

const fileInput = ref<HTMLInputElement | null>(null);
</script>

<template>
  <div class="rounded-2xl border border-hairline bg-panel">
    <button
      class="flex w-full cursor-pointer items-center gap-2.5 px-4 py-3 text-left"
      data-testid="quick-toggle"
      @click="expanded = !expanded"
    >
      <FileSpreadsheet class="h-5 w-5 shrink-0 text-brand" aria-hidden="true" />
      <span class="min-w-0 flex-1">
        <span class="block text-[14px] font-bold">合集一键导入（快速模式）</span>
        <span class="block text-xs text-subtle">
          零异常自动入库；有任何冲突/未匹配整批不入库并带入四步工作台处理；账号日汇总拒绝作品入库
        </span>
      </span>
      <span class="shrink-0 text-xs text-brand">{{ expanded ? "收起 ▲" : "展开 ▼" }}</span>
    </button>

    <div v-if="expanded" class="border-t border-hairline px-4 py-3.5" data-testid="quick-body">
      <input ref="fileInput" type="file" accept=".csv,.xlsx,.xls" class="hidden" data-testid="quick-file-input" @change="onFilePicked" />

      <!-- 进行中 -->
      <div v-if="state === 'parsing' || state === 'submitting'" class="flex items-center gap-2.5 py-4 text-[13px]">
        <LoaderCircle class="h-4.5 w-4.5 animate-spin text-brand" aria-hidden="true" />
        {{ state === "parsing" ? `正在解析 ${fileName}…` : "正在自动匹配并校验（全部命中即自动入库）…" }}
      </div>

      <!-- 结果三态 -->
      <template v-else-if="state === 'done' && result !== null">
        <div v-if="result.mode === 'committed'" class="rounded-xl border border-green-200 bg-green-50 px-3.5 py-3 text-[13px] text-green-800" data-testid="quick-committed">
          <p class="flex items-center gap-2 font-semibold">
            <CircleCheck class="h-4.5 w-4.5" aria-hidden="true" />
            一键导入完成：作品级 {{ result.summary?.workLevel ?? 0 }} · 账号级 {{ result.summary?.accountDayLevel ?? 0 }} · 忽略 {{ result.summary?.ignored ?? 0 }}
          </p>
          <p class="mt-1 text-xs">
            批次 <span class="font-mono">{{ result.batchId }}</span> 已提交（全部行为强证据或双证据交叉验证命中，零人工干预）；
            如需撤销可在四步工作台该批次的提交页回滚。
          </p>
        </div>
        <div v-else-if="result.mode === 'manual_required'" class="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-[13px] text-amber-800" data-testid="quick-manual">
          <p class="flex items-center gap-2 font-semibold">
            <TriangleAlert class="h-4.5 w-4.5" aria-hidden="true" /> 整批未入库（存在需人工处理的行）
          </p>
          <p class="mt-1 text-xs">{{ result.reason }}</p>
          <div class="mt-2.5 flex gap-2">
            <Button size="sm" data-testid="quick-goto-steps" @click="emit('openBatch', result.batchId)">进入四步工作台处理 →</Button>
            <Button size="sm" variant="outline" @click="reset">重试其他文件</Button>
          </div>
        </div>
        <div v-else class="rounded-xl border border-blue-200 bg-blue-50 px-3.5 py-3 text-[13px] text-blue-800" data-testid="quick-denied">
          <p class="flex items-center gap-2 font-semibold">
            <TriangleAlert class="h-4.5 w-4.5" aria-hidden="true" /> 该文件不能按作品一键入库
          </p>
          <p class="mt-1 text-xs">{{ result.reason }}</p>
          <div class="mt-2.5 flex gap-2">
            <Button size="sm" data-testid="quick-goto-steps" @click="emit('openBatch', result.batchId)">进入四步工作台 →</Button>
            <Button size="sm" variant="outline" @click="reset">重试其他文件</Button>
          </div>
        </div>
      </template>

      <!-- 初始：选文件 -->
      <div v-else class="flex flex-col items-center gap-2 py-4 text-center">
        <p class="text-[13px]">
          选择平台导出的合集/作品文件（CSV/XLSX，≤{{ MAX_ROWS }} 行，
          <button class="cursor-pointer font-medium text-brand underline" @click="fileInput?.click()">点击选择</button>
        </p>
        <p class="text-xs text-subtle">使用默认匹配规则（时区 UTC+8、发布时间容差 ±5 分钟、标题相似度阈值 90%）；需要自定义规则请走下方四步流程</p>
        <Button size="sm" @click="fileInput?.click()">选择文件并一键导入</Button>
      </div>
    </div>
  </div>
</template>
