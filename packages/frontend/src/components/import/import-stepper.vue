<script setup lang="ts">
/**
 * 四步 Stepper（导入数据 → 匹配规则 → 匹配校验 → 提交落库）
 * 固定存在不可删减/合并/换序；已到达步骤可点回，未到达锁定（locked 不响应点击）
 */
import { computed } from "vue";
import { type WizardStep, canGotoStep, stepperStates } from "../../lib/import-batch";

const props = defineProps<{ maxStep: WizardStep; active: WizardStep }>();
const emit = defineEmits<{ goto: [step: WizardStep] }>();

const steps: { step: WizardStep; title: string; sub: string }[] = [
  { step: 1, title: "导入数据", sub: "上传 CSV/XLSX，判定数据粒度" },
  { step: 2, title: "匹配规则", sub: "配置依据与容差，预估匹配结果" },
  { step: 3, title: "匹配校验", sub: "确定性匹配 + 异常人工裁决" },
  { step: 4, title: "提交落库", sub: "Preflight 校验后入库，可回滚" },
];

const states = computed(() => stepperStates(props.maxStep, props.active));

function onClick(step: WizardStep): void {
  if (canGotoStep(step, props.maxStep)) emit("goto", step);
}
</script>

<template>
  <nav class="flex items-stretch gap-2" aria-label="导入步骤" data-testid="import-stepper">
    <template v-for="(s, i) in steps" :key="s.step">
      <button
        class="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-xl px-4 py-3 text-left transition-colors"
        :class="
          states[s.step] === 'current'
            ? 'bg-brand text-white shadow-sm'
            : states[s.step] === 'done'
              ? 'bg-brand-soft text-brand hover:bg-brand/15'
              : 'cursor-not-allowed border border-hairline bg-white text-subtle'
        "
        :disabled="states[s.step] === 'locked'"
        :aria-current="states[s.step] === 'current' ? 'step' : undefined"
        :data-testid="`import-step-${s.step}`"
        @click="onClick(s.step)"
      >
        <span
          class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[13px] font-bold"
          :class="
            states[s.step] === 'current'
              ? 'bg-white/20'
              : states[s.step] === 'done'
                ? 'bg-brand/15'
                : 'bg-[#f2f3f5]'
          "
        >
          {{ s.step }}
        </span>
        <span class="min-w-0">
          <span class="block truncate text-[14px] font-semibold">{{ s.title }}</span>
          <span
            class="block truncate text-[11px]"
            :class="states[s.step] === 'current' ? 'text-white/75' : 'text-subtle'"
          >
            {{ s.sub }}
          </span>
        </span>
      </button>
      <span v-if="i < steps.length - 1" class="self-center text-subtle" aria-hidden="true">→</span>
    </template>
  </nav>
</template>
