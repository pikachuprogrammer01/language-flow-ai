<script setup lang="ts">
import { CircleCheck, CircleX, ShieldAlert, TriangleAlert } from "lucide-vue-next";
/**
 * STEP 4 提交落库：Preflight 十项报告（逐项 ✓/⚠/ + 阻断项定位）→ 四类计数 → 确认导入
 * 提交状态机：validating → validation_failed | ready → submitting → completed | submit_failed；
 * 已提交批次提供回滚入口（commit_preimage 精确恢复，导入可追溯可撤销）。
 */
import { computed } from "vue";
import type { ImportBatchView, ImportCommitSummary, PreflightReport } from "../../api/client";
import Button from "../ui/button.vue";
import Spinner from "../ui/spinner.vue";

const props = defineProps<{
  view: ImportBatchView;
  report: PreflightReport | null;
  /** validating | validation_failed | ready | submitting | completed | submit_failed */
  commitState: string;
  commitResult: ImportCommitSummary | null;
  commitError: string;
  busy: boolean;
}>();

const emit = defineEmits<{
  rerun: [];
  commit: [];
  back: [];
  rollback: [];
  gotoBlocked: [status: string];
}>();

const pass = computed(() => props.report?.pass === true);
const blocking = computed(() => (props.report?.checks ?? []).filter((c) => c.level === "blocking"));

/** 阻断项 → STEP3 对应筛选（④冲突；其余回全部） */
function blockedFilter(id: number): string {
  return id === 4 ? "conflict" : "all";
}

function levelIcon(level: string): typeof CircleCheck {
  if (level === "pass") return CircleCheck;
  return level === "warning" ? TriangleAlert : CircleX;
}

function levelClass(level: string): string {
  if (level === "pass") return "text-green-600";
  return level === "warning" ? "text-amber-600" : "text-red-600";
}

const isCommitted = computed(() => props.view.status === "committed");
const isRolledBack = computed(() => props.view.status === "rolled_back");
</script>

<template>
  <div class="rounded-2xl border border-hairline bg-panel p-4" data-testid="commit-page">
    <div class="mb-3 flex items-center justify-between">
      <h2 class="text-[15px] font-bold">④ 提交落库</h2>
      <Button size="sm" variant="outline" :disabled="busy" data-testid="commit-rerun" @click="emit('rerun')">
        <Spinner v-if="commitState === 'validating'" size="sm" /> 重新校验
      </Button>
    </div>

    <!-- 校验结论横幅 -->
    <div
      v-if="isRolledBack"
      class="mb-3 flex items-center gap-2 rounded-xl border border-gray-200 bg-gray-100 px-3.5 py-2.5 text-[13px] font-semibold text-subtle"
      data-testid="commit-rolledback"
    >
      <ShieldAlert class="h-4.5 w-4.5" aria-hidden="true" /> 本批次已回滚，落库数据已恢复到提交前状态
    </div>
    <div
      v-else-if="isCommitted"
      class="mb-3 flex items-center gap-2 rounded-xl border border-green-200 bg-green-50 px-3.5 py-2.5 text-[13px] font-semibold text-green-800"
      data-testid="commit-done"
    >
      <CircleCheck class="h-4.5 w-4.5" aria-hidden="true" /> 已提交入库（批次 {{ view.id }}），可随时回滚
    </div>
    <div
      v-else-if="pass"
      class="mb-3 flex items-center gap-2 rounded-xl border border-green-200 bg-green-50 px-3.5 py-2.5 text-[13px] font-semibold text-green-800"
      data-testid="commit-pass"
    >
      <CircleCheck class="h-4.5 w-4.5" aria-hidden="true" /> 校验通过，可以提交入库
    </div>
    <div
      v-else
      class="mb-3 flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-3.5 py-2.5 text-[13px] font-semibold text-red-700"
      data-testid="commit-blocked"
    >
      <CircleX class="h-4.5 w-4.5" aria-hidden="true" />
      校验未通过（{{ blocking.length }} 项阻断），处理完才能提交入库
    </div>

    <div class="grid grid-cols-2 gap-4">
      <!-- 左：Preflight 十项 -->
      <section>
        <h3 class="mb-1.5 text-[13px] font-semibold">提交前校验（Preflight 十项）</h3>
        <ol class="overflow-hidden rounded-xl border border-hairline bg-white text-[12px]">
          <li
            v-for="c in report?.checks ?? []"
            :key="c.id"
            class="flex items-start gap-2 border-b border-hairline px-3 py-2 last:border-b-0"
            :data-testid="`preflight-${c.id}`"
          >
            <component :is="levelIcon(c.level)" class="mt-0.5 h-4 w-4 shrink-0" :class="levelClass(c.level)" aria-hidden="true" />
            <span class="min-w-0 flex-1">
              <span class="font-medium">{{ c.id }} · {{ c.name }}</span>
              <span class="block text-subtle">{{ c.message }}</span>
            </span>
            <button
              v-if="c.level !== 'pass' && c.rowIds.length > 0"
              class="shrink-0 cursor-pointer text-[11px] text-brand underline"
              @click="emit('gotoBlocked', blockedFilter(c.id))"
            >
              去处理（{{ c.rowIds.length }} 行）
            </button>
          </li>
          <li v-if="report === null" class="px-3 py-4 text-center text-subtle">尚未执行校验，点「重新校验」</li>
        </ol>
      </section>

      <!-- 右：四类计数 + 提交 -->
      <section>
        <h3 class="mb-1.5 text-[13px] font-semibold">入库统计</h3>
        <div class="mb-3 overflow-hidden rounded-xl border border-hairline bg-white text-[13px]">
          <div class="flex justify-between border-b border-hairline px-3 py-2">
            <span class="text-subtle">作品级数据</span>
            <span class="font-mono font-bold text-green-600">{{ report?.counts.workLevel ?? "—" }}</span>
          </div>
          <div class="flex justify-between border-b border-hairline px-3 py-2">
            <span class="text-subtle">账号级数据</span>
            <span class="font-mono font-bold text-blue-600">{{ report?.counts.accountDayLevel ?? "—" }}</span>
          </div>
          <div class="flex justify-between border-b border-hairline px-3 py-2">
            <span class="text-subtle">忽略（含外部视频 {{ report?.counts.external ?? 0 }}）</span>
            <span class="font-mono font-bold text-subtle">{{ report?.counts.ignored ?? "—" }}</span>
          </div>
          <div class="flex justify-between px-3 py-2">
            <span class="text-subtle">待处理冲突</span>
            <span class="font-mono font-bold" :class="(report?.counts.pendingConflict ?? 0) > 0 ? 'text-red-600' : 'text-green-600'">{{ report?.counts.pendingConflict ?? "—" }}</span>
          </div>
        </div>

        <p v-if="commitState === 'submit_failed' || commitState === 'validation_failed'" class="mb-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700" data-testid="commit-error">
          {{ commitError || "提交前校验未通过，请回到匹配校验处理阻断项" }}
        </p>

        <div class="flex items-center gap-2.5">
          <Button variant="outline" size="sm" :disabled="busy" data-testid="commit-back" @click="emit('back')">← 上一步</Button>
          <Button
            v-if="!isCommitted && !isRolledBack"
            :disabled="!pass || busy"
            data-testid="commit-submit"
            @click="emit('commit')"
          >
            <Spinner v-if="commitState === 'submitting'" size="sm" />
            {{ commitState === "submitting" ? "正在入库…" : "确认导入" }}
          </Button>
          <Button
            v-if="isCommitted"
            variant="destructive"
            size="default"
            :disabled="busy"
            data-testid="commit-rollback"
            @click="emit('rollback')"
          >
            回滚本批次
          </Button>
        </div>
        <p class="mt-2 text-[11px] leading-relaxed text-subtle">
          提交 = 单事务写入 video_metrics（作品级，复用派生重算单一口径）与 creator_metric_daily（账号级），
          原始行数据永久保留在 import_row.raw_data；如需撤销整批，提交后可一键回滚。
        </p>

        <!-- 提交结果 -->
        <div v-if="commitResult !== null" class="mt-3 rounded-xl border border-hairline bg-white p-3 text-[12px]" data-testid="commit-result">
          <p class="mb-1 font-semibold text-green-700">
            入库完成：作品级 {{ commitResult.workLevel }} · 账号级 {{ commitResult.accountDayLevel }} · 忽略 {{ commitResult.ignored }}（外部视频 {{ commitResult.external }}）
          </p>
          <p v-if="commitResult.skippedRows.length > 0" class="text-amber-700">
            跳过 {{ commitResult.skippedRows.length }} 行：
            <span v-for="s in commitResult.skippedRows.slice(0, 5)" :key="s.rowNumber" class="block">第 {{ s.rowNumber }} 行：{{ s.reason }}</span>
          </p>
          <p v-else class="text-subtle">无跳过行</p>
        </div>
      </section>
    </div>
  </div>
</template>
