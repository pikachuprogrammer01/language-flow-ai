<script setup lang="ts">
/**
 * 平台数据导入 · 四步精准匹配工作台（/insights/import）
 * 页面壳：持有批次视图与异步状态机，编排 API 调用；子组件只管排版与交互。
 * 刷新恢复：?batch=<id> 直达 + 状态映射回对应步骤（数据全部在服务端，不依赖内存）。
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  type ImportBatchView,
  type ImportCommitSummary,
  type ImportDecisionAction,
  type ImportEstimate,
  type ImportGranularity,
  type ImportRowDetail,
  type ImportRowListItem,
  type ImportRulesPayload,
  type PreflightReport,
  commitImportBatch,
  confirmImportGranularity,
  createImportBatch,
  decideImportRows,
  deleteImportBatch,
  getImportBatch,
  getImportRowDetail,
  listImportRows,
  preflightImportBatch,
  prematchImportBatch,
  rollbackImportBatch,
  saveImportRules,
} from "../api/client";
import DetailPanel from "../components/import/detail-panel.vue";
import ImportStepper from "../components/import/import-stepper.vue";
import QuickImportCard from "../components/import/quick-import-card.vue";
import StepCommit from "../components/import/step-commit.vue";
import StepImport from "../components/import/step-import.vue";
import StepReview from "../components/import/step-review.vue";
import StepRules from "../components/import/step-rules.vue";
import ConfirmDialog from "../components/ui/confirm-dialog.vue";
import { type WizardStep, stepOfBatchStatus } from "../lib/import-batch";
import { toast } from "../lib/toast";

const route = useRoute();
const router = useRouter();

const view = ref<ImportBatchView | null>(null);
const activeStep = ref<WizardStep>(1);
const previewRows = ref<ImportRowListItem[]>([]);
const estimate = ref<ImportEstimate | null>(null);

/** 上传态：creating=服务端解析中；confirming=粒度确认中 */
const creating = ref(false);
const confirming = ref(false);
const savingRules = ref(false);
const prematchState = ref<"idle" | "matching" | "matched" | "match_failed">("idle");

/** 最近一次解析的原始数据（字段识别修正后带 override 重建批次用） */
const lastPayload = ref<{
  filename: string;
  fileSize: number;
  fileHash: string;
  platform: string;
  headers: string[];
  rows: string[][];
} | null>(null);

const maxStep = computed<WizardStep>(() =>
  view.value === null ? 1 : stepOfBatchStatus(view.value.status),
);

function isNeedsConfirmation(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: string }).code === "NEEDS_CONFIRMATION";
}

async function refresh(): Promise<void> {
  if (view.value === null) return;
  view.value = await getImportBatch(view.value.id);
  const rows = await listImportRows(view.value.id, { page: 1, pageSize: 10 });
  previewRows.value = rows.items;
}

onMounted(async () => {
  const batchId = typeof route.query.batch === "string" ? route.query.batch : null;
  if (batchId === null) return;
  try {
    view.value = await getImportBatch(batchId);
    const rows = await listImportRows(batchId, { page: 1, pageSize: 10 });
    previewRows.value = rows.items;
    activeStep.value = maxStep.value;
    // 恢复零副作用：预估只在用户点「保存规则」时重算（绝不在 GET 恢复链路里调 PUT 改批次状态）
    if (view.value.status === "preflight_ok") {
      preflightReport.value = await preflightImportBatch(batchId);
      commitState.value = preflightReport.value.pass ? "ready" : "validation_failed";
    } else if (view.value.status === "committed" || view.value.status === "rolled_back") {
      commitState.value = "completed";
      commitResult.value = (view.value.commitSummary as ImportCommitSummary | null) ?? null;
    }
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "批次恢复失败");
    void router.replace({ query: {} });
    view.value = null;
  }
});

function bindBatchQuery(batchId: string): void {
  void router.replace({ query: { ...route.query, batch: batchId } });
}

async function onCreate(payload: NonNullable<typeof lastPayload.value>): Promise<void> {
  creating.value = true;
  try {
    // 更换文件：旧草稿批次先删除（未提交才可删，服务端把关）
    if (view.value !== null && maxStep.value === 1 && view.value.status === "draft") {
      await deleteImportBatch(view.value.id).catch(() => undefined);
    }
    lastPayload.value = payload;
    const created = await createImportBatch(payload);
    view.value = await getImportBatch(created.batchId);
    estimate.value = null;
    prematchState.value = "idle";
    activeStep.value = 1;
    const rows = await listImportRows(created.batchId, { page: 1, pageSize: 10 });
    previewRows.value = rows.items;
    bindBatchQuery(created.batchId);
    toast.success(
      `已解析：${view.value.rowCount} 行 · 粒度判定 ${view.value.dataGranularity === "work_level_strong" ? "作品级（强标识）" : view.value.dataGranularity === "work_level_weak" ? "作品级（弱标识）" : "账号日汇总"}`,
    );
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "创建批次失败", { key: "import-create" });
  } finally {
    creating.value = false;
  }
}

async function onRedetect(fieldOverride: Record<string, string | null>): Promise<void> {
  if (lastPayload.value === null) return;
  creating.value = true;
  try {
    if (view.value !== null && view.value.status === "draft") {
      await deleteImportBatch(view.value.id).catch(() => undefined);
    }
    const created = await createImportBatch({ ...lastPayload.value, fieldOverride });
    view.value = await getImportBatch(created.batchId);
    bindBatchQuery(created.batchId);
    estimate.value = null;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "字段修正失败");
  } finally {
    creating.value = false;
  }
}

async function onConfirmGranularity(granularity: ImportGranularity): Promise<void> {
  if (view.value === null) return;
  confirming.value = true;
  try {
    await confirmImportGranularity(view.value.id, granularity);
    await refresh();
    activeStep.value = 2;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "粒度确认失败");
  } finally {
    confirming.value = false;
  }
}

async function onSaveRules(rules: ImportRulesPayload): Promise<void> {
  if (view.value === null) return;
  savingRules.value = true;
  try {
    const result = await saveImportRules(view.value.id, rules);
    estimate.value = result.estimate;
    prematchState.value = "idle";
    await refresh();
    toast.success("规则已保存，预估已更新");
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "规则保存失败", { key: "import-rules" });
  } finally {
    savingRules.value = false;
  }
}

const rematchConfirmOpen = ref(false);

async function runPrematch(force: boolean): Promise<void> {
  if (view.value === null) return;
  prematchState.value = "matching";
  try {
    await prematchImportBatch(view.value.id, force);
    await refresh();
    prematchState.value = "matched";
    activeStep.value = 3;
    await loadRows();
    toast.success("预匹配完成，进入匹配校验");
  } catch (err) {
    if (isNeedsConfirmation(err)) {
      prematchState.value = "idle";
      rematchConfirmOpen.value = true;
      return;
    }
    prematchState.value = "match_failed";
    toast.error(err instanceof Error ? err.message : "预匹配失败", { key: "import-prematch" });
  }
}

async function onPrematch(): Promise<void> {
  await runPrematch(false);
}

async function onForceRematch(): Promise<void> {
  rematchConfirmOpen.value = false;
  await runPrematch(true);
}

// ── STEP 3：行列表 / 详情 / 裁决编排 ──

const rows = ref<ImportRowListItem[]>([]);
const rowsTotal = ref(0);
const rowsPage = ref(1);
const rowsPageSize = ref(20);
const statusFilter = ref("all");
const keyword = ref("");
const rowsLoading = ref(false);
const decisionBusy = ref(false);
const selectedRowId = ref<number | null>(null);
const rowDetail = ref<ImportRowDetail | null>(null);
const detailLoading = ref(false);
const preflightReport = ref<PreflightReport | null>(null);

async function loadRows(): Promise<void> {
  if (view.value === null) return;
  rowsLoading.value = true;
  try {
    const res = await listImportRows(view.value.id, {
      status: statusFilter.value === "all" ? undefined : statusFilter.value,
      keyword: keyword.value.trim() === "" ? undefined : keyword.value.trim(),
      page: rowsPage.value,
      pageSize: rowsPageSize.value,
    });
    rows.value = res.items;
    rowsTotal.value = res.total;
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "行列表加载失败");
  } finally {
    rowsLoading.value = false;
  }
}

async function openRow(r: ImportRowListItem): Promise<void> {
  if (view.value === null) return;
  selectedRowId.value = r.rowId;
  detailLoading.value = true;
  try {
    rowDetail.value = await getImportRowDetail(view.value.id, r.rowId);
  } catch (err) {
    rowDetail.value = null;
    toast.error(err instanceof Error ? err.message : "行详情加载失败");
  } finally {
    detailLoading.value = false;
  }
}

async function runDecision(action: ImportDecisionAction): Promise<void> {
  if (view.value === null) return;
  decisionBusy.value = true;
  try {
    const res = await decideImportRows(view.value.id, action);
    view.value = { ...view.value, stats: res.stats };
    toast.success(`已处理 ${res.affected} 行`);
    await loadRows();
    if (selectedRowId.value !== null) {
      rowDetail.value = await getImportRowDetail(view.value.id, selectedRowId.value);
    }
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "裁决失败", { key: "import-decision" });
  } finally {
    decisionBusy.value = false;
  }
}

function onFilter(status: string): void {
  statusFilter.value = status;
  rowsPage.value = 1;
  void loadRows();
}

function onSearch(kw: string): void {
  keyword.value = kw;
  rowsPage.value = 1;
  void loadRows();
}

function onPage(page: number): void {
  rowsPage.value = page;
  void loadRows();
}

function onPageSize(size: number): void {
  rowsPageSize.value = size;
  rowsPage.value = 1;
  void loadRows();
}

/** 重新匹配：清空裁决与候选前二次确认（复用 needs_confirmation 链路），完成后重置右栏 */
async function onRematch(): Promise<void> {
  selectedRowId.value = null;
  rowDetail.value = null;
  await runPrematch(false);
}

/** STEP3 → STEP4：先跑 preflight 拿报告（提交页渲染用），通过与否都进步（不通过展示阻断清单） */
async function onGotoCommit(): Promise<void> {
  if (view.value === null) return;
  commitState.value = "validating";
  decisionBusy.value = true;
  try {
    preflightReport.value = await preflightImportBatch(view.value.id);
    commitState.value = preflightReport.value.pass ? "ready" : "validation_failed";
    commitError.value = preflightReport.value.pass
      ? ""
      : preflightReport.value.checks
          .filter((c) => c.level === "blocking")
          .map((c) => c.message)
          .join("；");
    await refresh();
    activeStep.value = 4;
  } catch (err) {
    commitState.value = "submit_failed";
    commitError.value = err instanceof Error ? err.message : "校验失败";
    toast.error(commitError.value);
  } finally {
    decisionBusy.value = false;
  }
}

// ── STEP 4：提交状态机与回滚 ──

type CommitState =
  | "validating"
  | "validation_failed"
  | "ready"
  | "submitting"
  | "completed"
  | "submit_failed";
const commitState = ref<CommitState>("validating");
const commitResult = ref<ImportCommitSummary | null>(null);
const commitError = ref("");
const rollbackConfirmOpen = ref(false);

async function onCommit(): Promise<void> {
  if (view.value === null) return;
  commitState.value = "submitting";
  decisionBusy.value = true;
  try {
    commitResult.value = await commitImportBatch(view.value.id);
    commitState.value = "completed";
    await refresh();
    toast.success(
      `入库完成：作品级 ${commitResult.value.workLevel} · 账号级 ${commitResult.value.accountDayLevel}`,
    );
  } catch (err) {
    const e = err as Error & { report?: PreflightReport };
    if (e.report !== undefined) {
      preflightReport.value = e.report;
      commitState.value = "validation_failed";
      commitError.value = e.report.checks
        .filter((c) => c.level === "blocking")
        .map((c) => c.message)
        .join("；");
    } else {
      commitState.value = "submit_failed";
      commitError.value = e.message;
    }
    toast.error(e.message, { key: "import-commit" });
  } finally {
    decisionBusy.value = false;
  }
}

async function onRollback(): Promise<void> {
  rollbackConfirmOpen.value = false;
  if (view.value === null) return;
  decisionBusy.value = true;
  try {
    await rollbackImportBatch(view.value.id);
    commitResult.value = null;
    commitState.value = "validating";
    await refresh();
    toast.success("已回滚：受影响发布记录恢复到提交前状态");
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "回滚失败", { key: "import-rollback" });
  } finally {
    decisionBusy.value = false;
  }
}

/** 阻断项定位：回 STEP3 带筛选 */
function onGotoBlocked(status: string): void {
  activeStep.value = 3;
  statusFilter.value = status;
  rowsPage.value = 1;
  void loadRows();
}

/** 一键导入卡片异常回传：加载该批次并停到对应步骤（manual_required 已在 prematched → STEP3） */
async function onQuickOpenBatch(batchId: string): Promise<void> {
  if (batchId === "") return;
  try {
    view.value = await getImportBatch(batchId);
    estimate.value = null;
    prematchState.value = "matched";
    activeStep.value = maxStep.value;
    await loadRows();
    bindBatchQuery(batchId);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "批次加载失败");
  }
}

/* 进入 STEP3（预匹配完成/点回）时自动拉行列表 */
watch(activeStep, (step) => {
  if (step === 3 && view.value !== null && rows.value.length === 0) void loadRows();
});

function onGoto(step: WizardStep): void {
  activeStep.value = step;
}
</script>

<template>
  <section class="mx-auto w-full max-w-[1440px] space-y-3" data-testid="import-page">
    <header>
      <h1 class="text-[20px] font-bold">视频发布记录导入 · 四步精准匹配</h1>
      <p class="mt-0.5 text-xs text-subtle">
        系统自动完成确定性匹配，用户只处理异常。支持 CSV/XLSX；账号日汇总数据绝不归属到单个作品。
      </p>
    </header>

    <ImportStepper :max-step="maxStep" :active="activeStep" @goto="onGoto" />

    <!-- 合集一键导入（快速模式）：仅未进入批次流程时展示，不打断四步主线 -->
    <QuickImportCard v-if="view === null" @open-batch="onQuickOpenBatch" />

    <StepImport
      v-if="activeStep === 1"
      :view="view"
      :busy="creating || confirming"
      :preview-rows="previewRows"
      @create="onCreate"
      @redetect="onRedetect"
      @confirm="onConfirmGranularity"
    />

    <StepRules
      v-else-if="activeStep === 2 && view !== null"
      :view="view"
      :saving="savingRules"
      :prematch-state="prematchState"
      :estimate="estimate"
      @save="onSaveRules"
      @prematch="onPrematch"
      @back="activeStep = 1"
    />

    <StepReview
      v-else-if="activeStep === 3 && view !== null"
      :view="view"
      :items="rows"
      :total="rowsTotal"
      :page="rowsPage"
      :page-size="rowsPageSize"
      :status-filter="statusFilter"
      :keyword="keyword"
      :loading="rowsLoading"
      :busy="decisionBusy"
      :selected-row-id="selectedRowId"
      @filter="onFilter"
      @search="onSearch"
      @page="onPage"
      @page-size="onPageSize"
      @select="openRow"
      @confirm-all-unique="runDecision({ action: 'confirm', allUnique: true })"
      @batch-ignore="(ids) => runDecision({ action: 'ignore', rowIds: ids })"
      @batch-account-day="(ids) => runDecision({ action: 'account_day', rowIds: ids })"
      @rematch="onRematch"
      @next="onGotoCommit"
    >
      <DetailPanel
        :detail="rowDetail"
        :loading="detailLoading"
        :busy="decisionBusy"
        @confirm="(rowId) => runDecision({ action: 'confirm', rowIds: [rowId] })"
        @assign="(rowId, videoId) => runDecision({ action: 'assign', rowId, videoId })"
        @external="(rowId) => runDecision({ action: 'external', rowIds: [rowId] })"
        @account-day="(rowId) => runDecision({ action: 'account_day', rowIds: [rowId] })"
        @ignore="(rowId) => runDecision({ action: 'ignore', rowIds: [rowId] })"
        @reset="(rowId) => runDecision({ action: 'reset', rowIds: [rowId] })"
      />
    </StepReview>

    <StepCommit
      v-else-if="activeStep === 4 && view !== null"
      :view="view"
      :report="preflightReport"
      :commit-state="commitState"
      :commit-result="commitResult"
      :commit-error="commitError"
      :busy="decisionBusy"
      @rerun="onGotoCommit"
      @commit="onCommit"
      @back="activeStep = 3"
      @rollback="rollbackConfirmOpen = true"
      @goto-blocked="onGotoBlocked"
    />

    <ConfirmDialog
      v-model:open="rollbackConfirmOpen"
      title="回滚本批次导入"
      description="受影响发布记录的全部指标（含派生行与每日快照）将恢复到提交前状态；原始导入数据保留，可重新匹配后再次提交。"
      confirm-text="确认回滚"
      destructive
      @confirm="onRollback"
    />

    <ConfirmDialog
      v-model:open="rematchConfirmOpen"
      title="重新匹配将清空人工裁决"
      description="本批次已存在人工裁决记录；重新执行匹配会清空全部候选与人工裁决并回到系统建议基线。确认继续？"
      confirm-text="确认重匹配"
      destructive
      @confirm="onForceRematch"
    />
  </section>
</template>
