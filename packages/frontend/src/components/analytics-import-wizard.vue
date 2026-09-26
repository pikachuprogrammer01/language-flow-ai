<script setup lang="ts">
import { computed, ref } from "vue";
/**
 * 数据导入向导（四步）— 逐视频 / 账号日汇总 双路径
 * ① 导入表格（xlsx 文件 / 粘贴 双通道，表类型自动探测可手动切换）
 * ② 字段映射（目录驱动动态映射，自动预匹配可逐列调整）
 * ③ 匹配确认（账号日：按年月日匹配 + 一天条数设置 + 三态判定，歧义行必须操作者裁决，系统绝不拆数；
 *             逐视频：ID 可匹配性预览，不崩溃只提醒）
 * ④ 提交落库（逐行结果，部分成功语义）
 * 已完成步骤可点回修改，未到达步骤不可跳跃；交互组件全部 reka-ui 底座
 */
import * as XLSX from "xlsx";
import {
  type CreatorDailyFieldEntry,
  type CreatorDailyImportRowResult,
  type ImportRowResult,
  type MetricCatalogEntry,
  type PublishRecordView,
  importAnalyticsCreatorDaily,
  importAnalyticsMetrics,
} from "../api/client";
import Button from "../components/ui/button.vue";
import Select, { type SelectOption } from "../components/ui/select.vue";
import Spinner from "../components/ui/spinner.vue";
import {
  type ColumnMapping,
  type MatchCandidate,
  type ParsedTable,
  type RowMatchVerdict,
  autoMatchColumns,
  autoMatchCreatorDaily,
  buildImportRows,
  buildMetricMapping,
  detectTableKind,
  mappedCount,
  matchRowByDate,
  normalizeDateCell,
  parsePastedTable,
  recordDateKey,
  sheetToParsedTable,
} from "../lib/analytics-import";
import { toast } from "../lib/toast";

const props = defineProps<{
  records: PublishRecordView[];
  catalog: MetricCatalogEntry[];
  creatorDailyFields: CreatorDailyFieldEntry[];
}>();

const emit = defineEmits<{ imported: [] }>();

const ACCOUNT_VALUE = "__account__";
const SKIP_VALUE = "__skip__";

// ── 向导状态 ──

const step = ref<1 | 2 | 3 | 4>(1);
const maxReached = ref<1 | 2 | 3 | 4>(1);
const rawText = ref("");
/** xlsx 文件导入的解析结果（优先于粘贴文本） */
const xlsxTable = ref<ParsedTable | null>(null);
const fileName = ref("");
const kind = ref<"video" | "creator-daily">("video");
const submitting = ref(false);
const videoResults = ref<ImportRowResult[] | null>(null);
const dailyResults = ref<CreatorDailyImportRowResult[] | null>(null);
const summary = ref<{ total: number; succeeded: number; failed: number } | null>(null);

const table = computed<ParsedTable | null>(
  () => xlsxTable.value ?? parsePastedTable(rawText.value),
);

const kindOptions: SelectOption[] = [
  { value: "video", label: "逐视频明细（每行一个作品 ID）" },
  { value: "creator-daily", label: "账号日汇总（每行一天，如「全量指标」导出）" },
];

function goto(next: 1 | 2 | 3 | 4): void {
  if (next > maxReached.value + 1) return; // 未到达的步骤不可跳跃
  step.value = next;
}

/** 推进一步（回看后再次前进不缩回进度条） */
function advance(): void {
  const next = Math.min(step.value + 1, 4) as 1 | 2 | 3 | 4;
  step.value = next;
  maxReached.value = Math.max(maxReached.value, next) as 1 | 2 | 3 | 4;
}

// ── 第①步：双通道表格输入 ──

const fileInput = ref<HTMLInputElement | null>(null);

function openFilePicker(): void {
  fileInput.value?.click();
}

/** SheetJS cellDates 下日期单元格是 Date（UTC 口径，日历日取 ISO 前 10 位） */
function cellToDate(cell: unknown): string | null {
  if (cell instanceof Date && !Number.isNaN(cell.getTime())) {
    return cell.toISOString().slice(0, 10);
  }
  if (typeof cell === "string") return normalizeDateCell(cell);
  return null;
}

async function onFilePicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    const buffer = await file.arrayBuffer();
    const wb = XLSX.read(buffer, { type: "array", cellDates: true });
    const firstSheet = wb.SheetNames[0];
    const sheet = firstSheet !== undefined ? wb.Sheets[firstSheet] : undefined;
    if (!sheet) throw new Error("文件里没有工作表");
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: true,
      blankrows: false,
      defval: "",
    });
    const parsed = sheetToParsedTable(matrix, cellToDate);
    if (parsed === null) throw new Error("至少需要表头行 + 1 行数据（两列以上）");
    xlsxTable.value = parsed;
    fileName.value = file.name;
    resetDownstream();
    applyDetection();
    toast.success(`已解析 ${file.name}：${parsed.rows.length} 行 × ${parsed.headers.length} 列`);
  } catch (err) {
    toast.error(`xlsx 解析失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    input.value = ""; // 允许重选同一文件
  }
}

function onTextChange(): void {
  xlsxTable.value = null;
  fileName.value = "";
  resetDownstream();
  applyDetection();
}

// ── 表类型：自动探测 + 手动切换 ──

const detectedKind = computed(() => (table.value ? detectTableKind(table.value) : null));

function applyDetection(): void {
  const t = table.value;
  if (t === null) return;
  const kindOf = detectTableKind(t);
  if (kindOf !== null) kind.value = kindOf;
  rebuildMapping(t);
}

function onKindChange(next: string | null): void {
  if (next !== "video" && next !== "creator-daily") return;
  kind.value = next;
  const t = table.value;
  if (t !== null) rebuildMapping(t);
  resetDownstream();
}

// ── 第②步：字段映射 ──

const mapping = ref<ColumnMapping>([]);
const matchCol = ref<number>(-1); // video：作品 ID 列
const dateCol = ref<number>(-1); // daily：日期列

const mappingOptions = computed<SelectOption[]>(() => {
  const skipLabel = kind.value === "video" ? "不导入该列" : "不映射";
  const base: SelectOption[] = [{ value: SKIP_VALUE, label: skipLabel }];
  if (kind.value === "video") {
    return [
      ...base,
      ...props.catalog.filter((m) => m.importable).map((m) => ({ value: m.name, label: m.label })),
    ];
  }
  return [...base, ...props.creatorDailyFields.map((f) => ({ value: f.name, label: f.label }))];
});

function rebuildMapping(t: ParsedTable): void {
  if (kind.value === "video") {
    mapping.value = autoMatchColumns(t.headers, props.catalog);
    const idCol = t.headers.findIndex((h) => /作品\s*ID|视频ID|item_id|记录ID/i.test(h.trim()));
    matchCol.value = idCol >= 0 ? idCol : 0;
    dateCol.value = -1;
  } else {
    mapping.value = autoMatchCreatorDaily(t.headers, props.creatorDailyFields);
    const dCol = t.headers.findIndex((h) => /日期|统计时间/i.test(h.trim()));
    dateCol.value = dCol >= 0 ? dCol : 0;
    matchCol.value = -1;
  }
}

function onMappingSelect(index: number, next: unknown): void {
  const copy: ColumnMapping = [...mapping.value];
  copy[index] = typeof next === "string" && next !== SKIP_VALUE ? next : null;
  mapping.value = copy;
}

const colOptions = computed<SelectOption[]>(() =>
  (table.value?.headers ?? []).map((h, i) => ({ value: String(i), label: h })),
);
const dateColValue = computed<string | null>({
  get: () => (dateCol.value >= 0 ? String(dateCol.value) : null),
  set: (v) => {
    dateCol.value = v === null ? -1 : Number(v);
  },
});
const matchColValue = computed<string | null>({
  get: () => (matchCol.value >= 0 ? String(matchCol.value) : null),
  set: (v) => {
    matchCol.value = v === null ? -1 : Number(v);
  },
});

const step2Valid = computed(() => {
  const t = table.value;
  if (t === null || mappedCount(mapping.value) === 0) return false;
  return kind.value === "video" ? matchCol.value >= 0 : dateCol.value >= 0;
});

// ── 第③步：匹配确认（账号日三态裁决 / 逐视频可匹配性预览） ──

const expectedPerDay = ref(1);
/** 逐行裁决：recordId 或 __account__（仅账号级） */
const decisions = ref<string[]>([]);

/** 发布记录按日分组（年月日粒度，发布时间缺失回退创建时间）
 * 未绑定作品 ID 的记录不参与自动匹配（避免把账号日数据自动归到无法溯源的作品上），仅可人工指派 */
const recordsByDate = computed(() => {
  const map = new Map<string, MatchCandidate[]>();
  for (const r of props.records) {
    if (r.publishStatus === "deleted" || r.platformVideoId === null) continue;
    const key = recordDateKey(r.publishTime, r.createdAt);
    const list = map.get(key) ?? [];
    const title = r.publishTitle || r.contentTitle;
    list.push({ recordId: r.id, label: `${title}（${r.platform} · ${r.platformVideoId}）` });
    map.set(key, list);
  }
  return map;
});

/** 每行日期（daily 路径归一化；非法日期行保留原文供提醒） */
const rowDates = computed<(string | null)[]>(() => {
  const t = table.value;
  if (t === null || dateCol.value < 0) return [];
  return t.rows.map((cells) => normalizeDateCell(cells[dateCol.value] ?? ""));
});

const verdicts = computed<RowMatchVerdict[]>(() =>
  rowDates.value.map((date) =>
    matchRowByDate(
      date === null ? [] : (recordsByDate.value.get(date) ?? []),
      expectedPerDay.value,
    ),
  ),
);

/** 逐视频路径：ID 在发布记录中的可匹配性预览（不阻断，只提醒） */
const knownVideoIds = computed(() => {
  const set = new Set<string>();
  for (const r of props.records) {
    if (r.platformVideoId !== null) set.add(r.platformVideoId);
  }
  return set;
});

const videoRowIds = computed<string[]>(() => {
  const t = table.value;
  if (t === null || matchCol.value < 0) return [];
  return t.rows.map((cells) => (cells[matchCol.value] ?? "").trim());
});

function initDecisions(): void {
  decisions.value = verdicts.value.map((v) => v.suggestedRecordId ?? ACCOUNT_VALUE);
}

function onExpectedPerDayChange(): void {
  initDecisions(); // 阈值变化 → 判定重算，裁决回到系统建议基线
}

const undecidedRows = computed(() =>
  kind.value === "creator-daily"
    ? verdicts.value.filter((v, i) => v.status === "ambiguous" && decisions.value[i] === undefined)
        .length
    : 0,
);

const invalidDateRows = computed(() =>
  kind.value === "creator-daily" ? rowDates.value.filter((d) => d === null).length : 0,
);

function adoptAllAuto(): void {
  decisions.value = verdicts.value.map((v) => v.suggestedRecordId ?? ACCOUNT_VALUE);
  toast.success("已按系统建议重置全部归属（唯一匹配 → 作品，其余 → 仅账号级）");
}

function setAllAccount(): void {
  decisions.value = verdicts.value.map(() => ACCOUNT_VALUE);
  toast.success("全部行已设为「仅记账号级」");
}

const step3Ready = computed(() => {
  if (kind.value === "video") return true; // 不可匹配行允许提交（后端逐行回错误，不崩）
  return undecidedRows.value === 0 && invalidDateRows.value === 0;
});

function decisionOptions(index: number): SelectOption[] {
  const verdict = verdicts.value[index];
  const options: SelectOption[] = [{ value: ACCOUNT_VALUE, label: "仅记账号级（不归因作品）" }];
  for (const c of verdict?.candidates ?? []) options.push({ value: c.recordId, label: c.label });
  return options;
}

function decisionValue(index: number): string | null {
  return decisions.value[index] ?? null;
}

function onDecisionSelect(index: number, next: unknown): void {
  const copy = [...decisions.value];
  copy[index] = typeof next === "string" ? next : ACCOUNT_VALUE;
  decisions.value = copy;
}

// ── 第④步：提交 ──

const platform = ref<string | null>("抖音");
const platformOptions: SelectOption[] = [
  { value: "抖音", label: "抖音" },
  { value: "快手", label: "快手" },
  { value: "视频号", label: "视频号" },
  { value: "B站", label: "B站" },
  { value: "小红书", label: "小红书" },
];

function resetDownstream(): void {
  videoResults.value = null;
  dailyResults.value = null;
  summary.value = null;
  decisions.value = [];
}

async function submit(): Promise<void> {
  const t = table.value;
  if (t === null || !step3Ready.value) return;
  submitting.value = true;
  try {
    if (kind.value === "video") {
      const rows = buildImportRows(t, matchCol.value, mapping.value);
      const res = await importAnalyticsMetrics({
        sourceType: "CREATOR_IMPORT",
        metricMapping: buildMetricMapping(t.headers, mapping.value),
        rows,
      });
      videoResults.value = res.results;
      summary.value = res.summary;
    } else {
      const rows = t.rows.map((cells, i) => {
        const values: Record<string, number | string | null> = {};
        t.headers.forEach((header, col) => {
          if (mapping.value[col] === null) return;
          const cell = (cells[col] ?? "").trim();
          if (cell === "") return;
          const numeric = Number(cell.replace(/,/g, ""));
          values[header] = Number.isNaN(numeric) ? cell : numeric;
        });
        const decision = decisions.value[i] ?? ACCOUNT_VALUE;
        return {
          statDate: rowDates.value[i] ?? "",
          values,
          attribution:
            decision === ACCOUNT_VALUE
              ? { mode: "account" as const }
              : { mode: "video" as const, recordId: decision },
        };
      });
      const fieldMapping = buildMetricMapping(t.headers, mapping.value);
      const res = await importAnalyticsCreatorDaily({
        platform: platform.value ?? "抖音",
        fieldMapping,
        rows,
      });
      dailyResults.value = res.results;
      summary.value = res.summary;
    }
    if ((summary.value?.succeeded ?? 0) > 0) {
      toast.success(`导入完成：${summary.value?.succeeded}/${summary.value?.total} 行成功`);
      emit("imported");
    } else {
      toast.warning("没有任何行导入成功，请查看逐行原因");
    }
  } catch (err) {
    // 同 key 去重（批次 4B）：连续提交失败不叠加同款错误 Toast
    toast.error(err instanceof Error ? err.message : String(err), { key: "import-wizard" });
  } finally {
    submitting.value = false;
  }
}

/** 第②步「下一步」：进入③时初始化裁决 */
function toStep3(): void {
  if (!step2Valid.value) return;
  if (kind.value === "creator-daily") initDecisions();
  advance();
}
</script>

<template>
  <div class="rounded-2xl border border-hairline bg-panel p-4">
    <!-- 步骤条：已完成可点回修改，未到达不可跳跃 -->
    <nav class="mb-4 flex flex-wrap items-center gap-1.5 text-[13px]" aria-label="导入步骤">
      <template v-for="(s, i) in [1, 2, 3, 4]" :key="s">
        <button
          v-if="s <= maxReached"
          class="cursor-pointer rounded-full px-3 py-1.5 font-medium transition-colors"
          :class="step === s ? 'bg-brand text-white' : 'bg-brand-soft text-brand hover:bg-brand/15'"
          :aria-current="step === s ? 'step' : undefined"
          @click="goto(s as 1 | 2 | 3 | 4)"
        >
          {{ s }}. {{ ["导入表格", "字段映射", "匹配确认", "提交落库"][i] }}
        </button>
        <span
          v-else
          class="rounded-full px-3 py-1.5 text-subtle"
          :class="step === s ? 'bg-brand-soft font-medium' : 'border border-hairline'"
        >
          {{ s }}. {{ ["导入表格", "字段映射", "匹配确认", "提交落库"][i] }}
        </span>
        <span v-if="s < 4" class="text-subtle" aria-hidden="true">→</span>
      </template>
      <span class="ml-auto text-xs text-subtle">第 {{ step }} 步 / 共 4 步</span>
    </nav>

    <!-- ① 导入表格 -->
    <section v-if="step === 1">
      <div class="mb-2.5 flex flex-wrap items-center gap-2.5">
        <input
          ref="fileInput"
          type="file"
          accept=".xlsx,.xls"
          class="hidden"
          data-testid="wizard-file-input"
          @change="onFilePicked"
        />
        <Button variant="outline" size="sm" data-testid="wizard-xlsx-btn" @click="openFilePicker">
          导入 xlsx 文件
        </Button>
        <span v-if="fileName !== ''" class="text-xs text-ink">
          当前文件：<span class="font-mono">{{ fileName }}</span>
          <button class="ml-1.5 cursor-pointer text-subtle underline hover:text-ink" @click="xlsxTable = null; fileName = ''; onTextChange()">清除</button>
        </span>
      </div>
      <textarea
        v-model="rawText"
        data-testid="wizard-textarea"
        rows="6"
        spellcheck="false"
        placeholder="或粘贴表格数据（创作者后台复制：制表符 / 另存 CSV：逗号 / 多空格对齐，首行为表头）"
        class="w-full rounded-[10px] border border-hairline bg-white px-3 py-2.5 font-mono text-xs leading-relaxed text-ink focus:border-brand focus:outline-none"
        :class="{ 'opacity-50': xlsxTable !== null }"
        @input="onTextChange"
      ></textarea>
      <p v-if="rawText.trim() !== '' && table === null && xlsxTable === null" class="mt-1.5 text-xs text-red-600">
        未能解析出表格：至少需要表头行 + 1 行数据（两列以上）。
      </p>

      <template v-if="table !== null">
        <div class="mt-3.5 flex flex-wrap items-center gap-3">
          <div>
            <span class="mb-1 block text-xs text-subtle">表格类型（自动探测：{{ detectedKind === "video" ? "逐视频明细" : detectedKind === "creator-daily" ? "账号日汇总" : "未能判定，请手动选择" }}）</span>
            <Select :value="kind" :options="kindOptions" trigger-class="w-[300px]" @update:value="onKindChange" />
          </div>
          <span class="text-xs text-subtle">{{ table.rows.length }} 行 × {{ table.headers.length }} 列（分隔：{{ table.delimiter }}）</span>
        </div>
        <Button class="mt-3.5" data-testid="wizard-next-1" :disabled="table === null" @click="advance">下一步：字段映射</Button>
      </template>
    </section>

    <!-- ② 字段映射 -->
    <section v-else-if="step === 2 && table !== null">
      <div class="mb-3 flex flex-wrap items-end gap-3">
        <div v-if="kind === 'video'">
          <span class="mb-1 block text-xs text-subtle">作品 ID 所在列</span>
          <Select v-model:value="matchColValue" :options="colOptions" size="sm" placeholder="选择列" trigger-class="w-[200px]" />
        </div>
        <div v-else>
          <span class="mb-1 block text-xs text-subtle">日期所在列（按年月日匹配）</span>
          <Select v-model:value="dateColValue" :options="colOptions" size="sm" placeholder="选择列" trigger-class="w-[200px]" />
        </div>
        <span class="pb-1.5 text-xs text-subtle">
          已自动预匹配 {{ mappedCount(mapping) }} 列 · {{ kind === "video" ? "行匹配仅走作品 ID，绝不按标题模糊匹配" : "账号级口径字段，落 creator_metric_daily" }}
        </span>
      </div>
      <div class="overflow-hidden rounded-xl border border-hairline">
        <table class="w-full border-collapse text-left text-[13px]">
          <thead class="bg-[#fafbfc] text-subtle">
            <tr>
              <th class="border-b border-hairline px-3 py-2 font-semibold">表格列名</th>
              <th class="border-b border-hairline px-3 py-2 font-semibold">{{ kind === "video" ? "导入为（视频指标）" : "映射为（账号日字段）" }}</th>
              <th class="border-b border-hairline px-3 py-2 font-semibold">示例值</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-hairline bg-white">
            <tr v-for="(header, i) in table.headers" :key="header + i">
              <td class="px-3 py-1.5 font-mono text-xs">
                {{ header }}
                <span v-if="i === (kind === 'video' ? matchCol : dateCol)" class="ml-1.5 rounded bg-brand-soft px-1.5 py-0.5 text-[10px] text-brand">{{ kind === "video" ? "ID 列" : "日期列" }}</span>
              </td>
              <td class="w-[260px] px-3 py-1.5">
                <Select
                  :value="mapping[i] ?? SKIP_VALUE"
                  :options="mappingOptions"
                  size="sm"
                  @update:value="onMappingSelect(i, $event)"
                />
              </td>
              <td class="px-3 py-1.5 text-xs text-subtle">{{ table.rows[0]?.[i] ?? "—" }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="mt-3.5 flex items-center gap-3">
        <Button variant="outline" size="sm" @click="goto(1)">上一步</Button>
        <Button data-testid="wizard-next-2" :disabled="!step2Valid" @click="toStep3">下一步：匹配确认</Button>
        <span v-if="!step2Valid" class="text-xs text-amber-700">至少映射一列并选定{{ kind === "video" ? " ID 列" : "日期列" }}</span>
      </div>
    </section>

    <!-- ③ 匹配确认 -->
    <section v-else-if="step === 3 && table !== null">
      <!-- 账号日路径：一天条数设置 + 逐行三态裁决 -->
      <template v-if="kind === 'creator-daily'">
        <div class="mb-3 flex flex-wrap items-end gap-3">
          <div>
            <span class="mb-1 block text-xs text-subtle">一天的发布条数设置（正常节奏，超出即提醒人工裁决）</span>
            <input
              v-model.number="expectedPerDay"
              type="number"
              min="1"
              max="10"
              class="w-[90px] rounded-[8px] border border-hairline bg-white px-2 py-1.5 text-sm focus:border-brand focus:outline-none"
              data-testid="wizard-expected-per-day"
              @change="onExpectedPerDayChange"
            />
          </div>
          <div class="flex gap-2">
            <Button variant="outline" size="sm" data-testid="wizard-adopt-all" @click="adoptAllAuto">采纳全部自动匹配</Button>
            <Button variant="outline" size="sm" @click="setAllAccount">全部仅账号级</Button>
          </div>
        </div>
        <p class="mb-2.5 text-xs text-subtle leading-relaxed">
          按「年-月-日」对齐发布记录；唯一匹配自动预选，歧义行必须由你裁决。系统绝不把账号日数据拆分摊派到多个作品。
          归属到作品的行为近似归因（当日总播放含老视频长尾），落库必携估算标记。
        </p>
        <div class="overflow-hidden rounded-xl border border-hairline">
          <table class="w-full border-collapse text-left text-[13px]">
            <thead class="bg-[#fafbfc] text-subtle">
              <tr>
                <th class="border-b border-hairline px-3 py-2 font-semibold">日期</th>
                <th class="border-b border-hairline px-3 py-2 font-semibold">判定</th>
                <th class="border-b border-hairline px-3 py-2 font-semibold">归属（操作者裁决）</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-hairline bg-white">
              <tr v-for="(row, i) in table.rows" :key="i" :class="verdicts[i]?.status === 'ambiguous' && !decisions[i] ? 'bg-amber-50/70' : ''">
                <td class="whitespace-nowrap px-3 py-1.5 font-mono text-xs">
                  {{ rowDates[i] ?? "—" }}
                  <span v-if="rowDates[i] === null" class="ml-1 text-red-600">日期无法解析</span>
                </td>
                <td class="px-3 py-1.5 text-xs">
                  <span v-if="verdicts[i]?.status === 'unique'" class="rounded bg-green-50 px-1.5 py-0.5 text-green-700">自动匹配</span>
                  <span v-else-if="verdicts[i]?.status === 'ambiguous'" class="rounded bg-amber-50 px-1.5 py-0.5 text-amber-700">需裁决（{{ verdicts[i]?.candidates.length }} 条候选）</span>
                  <span v-else class="rounded bg-gray-100 px-1.5 py-0.5 text-subtle">当日无发布</span>
                  <span v-if="verdicts[i]?.warning" class="ml-1.5 text-subtle">{{ verdicts[i]?.warning }}</span>
                </td>
                <td class="min-w-[280px] px-3 py-1.5">
                  <Select
                    :value="decisionValue(i)"
                    :options="decisionOptions(i)"
                    size="sm"
                    placeholder="必须选择归属"
                    :data-testid="`wizard-decision-${i}`"
                    @update:value="onDecisionSelect(i, $event)"
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="undecidedRows > 0" class="mt-2 text-xs text-amber-700">还有 {{ undecidedRows }} 行歧义待裁决（不裁决不能提交）</p>
        <p v-if="invalidDateRows > 0" class="mt-2 text-xs text-red-600">{{ invalidDateRows }} 行日期无法解析为 YYYY-MM-DD，请回第②步改日期列</p>
      </template>

      <!-- 逐视频路径：ID 可匹配性预览（不阻断） -->
      <template v-else>
        <p class="mb-2.5 text-xs text-subtle leading-relaxed">
          提交前预览作品 ID 与发布记录的对齐情况；未绑定的行不会崩溃，后端逐行返回错误，可先回「发布记录」区块补绑。
        </p>
        <div class="overflow-hidden rounded-xl border border-hairline">
          <table class="w-full border-collapse text-left text-[13px]">
            <thead class="bg-[#fafbfc] text-subtle">
              <tr>
                <th class="border-b border-hairline px-3 py-2 font-semibold">行</th>
                <th class="border-b border-hairline px-3 py-2 font-semibold">作品 ID</th>
                <th class="border-b border-hairline px-3 py-2 font-semibold">可匹配性</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-hairline bg-white">
              <tr v-for="(id, i) in videoRowIds" :key="i">
                <td class="px-3 py-1.5 text-xs">{{ i + 1 }}</td>
                <td class="px-3 py-1.5 font-mono text-xs">{{ id || "（空）" }}</td>
                <td class="px-3 py-1.5 text-xs">
                  <span v-if="id !== '' && knownVideoIds.has(id)" class="rounded bg-green-50 px-1.5 py-0.5 text-green-700">可匹配</span>
                  <span v-else class="rounded bg-amber-50 px-1.5 py-0.5 text-amber-700">发布记录中未找到，提交时逐行回错</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>

      <div class="mt-3.5 flex items-center gap-3">
        <Button variant="outline" size="sm" @click="goto(2)">上一步</Button>
        <Button data-testid="wizard-next-3" :disabled="!step3Ready" @click="advance">下一步：提交落库</Button>
      </div>
    </section>

    <!-- ④ 提交落库 -->
    <section v-else-if="step === 4">
      <div class="mb-3 flex items-center gap-3">
        <div v-if="kind === 'creator-daily'">
          <span class="mb-1 block text-xs text-subtle">账号平台</span>
          <Select v-model:value="platform" :options="platformOptions" size="sm" trigger-class="w-[140px]" />
        </div>
        <span class="text-xs text-subtle">
          {{ kind === "video" ? `将提交 ${table?.rows.length ?? 0} 行逐视频指标` : `将提交 ${table?.rows.length ?? 0} 行账号日汇总（含 ${decisions.filter((d) => d !== ACCOUNT_VALUE).length} 行归属作品）` }}
        </span>
      </div>
      <div class="flex items-center gap-3">
        <Button variant="outline" size="sm" @click="goto(3)">上一步</Button>
        <Button data-testid="wizard-submit" :disabled="submitting" @click="submit">
          <Spinner v-if="submitting" size="sm" /> 确认提交
        </Button>
      </div>

      <div v-if="summary !== null" class="mt-5">
        <h3 class="mb-2 text-[15px] font-bold">
          导入结果：成功 {{ summary.succeeded }} / 共 {{ summary.total }}
          <span v-if="summary.failed > 0" class="text-red-600">（失败 {{ summary.failed }}）</span>
        </h3>
        <div class="overflow-hidden rounded-xl border border-hairline">
          <table class="w-full border-collapse text-left text-[13px]">
            <thead class="bg-[#fafbfc] text-subtle">
              <tr>
                <th class="border-b border-hairline px-3 py-2 font-semibold">行</th>
                <th class="border-b border-hairline px-3 py-2 font-semibold">状态</th>
                <th class="border-b border-hairline px-3 py-2 font-semibold">写入</th>
                <th class="border-b border-hairline px-3 py-2 font-semibold">跳过 / 原因</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-hairline bg-white">
              <template v-if="videoResults !== null">
                <tr v-for="r in videoResults" :key="r.row" :class="r.ok ? '' : 'bg-red-50/60'">
                  <td class="px-3 py-1.5 text-xs">{{ r.row + 1 }}</td>
                  <td class="px-3 py-1.5">
                    <span v-if="r.ok" class="text-xs text-green-700">成功</span>
                    <span v-else class="text-xs text-red-600">{{ r.error ?? "失败" }}</span>
                  </td>
                  <td class="px-3 py-1.5 text-xs">
                    <span v-if="r.written.length > 0">{{ r.written.join("、") }}</span>
                    <span v-else class="text-subtle">—</span>
                    <span v-if="r.derived.length > 0" class="ml-1 text-subtle">+派生 {{ r.derived.length }}</span>
                  </td>
                  <td class="px-3 py-1.5 text-xs text-subtle">
                    <span v-for="s in r.skipped" :key="s.field" class="block whitespace-normal">{{ s.field }}：{{ s.reason }}</span>
                    <span v-if="r.skipped.length === 0">—</span>
                  </td>
                </tr>
              </template>
              <template v-else-if="dailyResults !== null">
                <tr v-for="r in dailyResults" :key="r.row" :class="r.ok ? '' : 'bg-red-50/60'">
                  <td class="px-3 py-1.5 text-xs">{{ r.row + 1 }}（{{ r.statDate }}）</td>
                  <td class="px-3 py-1.5">
                    <span v-if="r.ok" class="text-xs text-green-700">成功</span>
                    <span v-else class="text-xs text-red-600">{{ r.error ?? "失败" }}</span>
                  </td>
                  <td class="px-3 py-1.5 text-xs">
                    账号日 {{ r.dailyWritten.length }} 列
                    <span v-if="r.videoRecordId !== null" class="ml-1">→ 归属作品 {{ r.videoWritten.length }} 指标 + 派生 {{ r.videoDerived.length }}</span>
                  </td>
                  <td class="px-3 py-1.5 text-xs text-subtle">
                    <span v-for="s in r.skipped" :key="s.field" class="block whitespace-normal">{{ s.field }}：{{ s.reason }}</span>
                    <span v-if="r.skipped.length === 0">—</span>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
        <Button class="mt-3" variant="outline" size="sm" @click="step = 1; maxReached = 1; rawText = ''; xlsxTable = null; fileName = ''; resetDownstream(); mapping = []">
          完成，开始新一轮导入
        </Button>
      </div>
    </section>
  </div>
</template>
