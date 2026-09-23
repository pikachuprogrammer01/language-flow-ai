<script setup lang="ts">
import { computed } from "vue";
/** 状态胶囊 — 原型 .status/.dot 样式（ok 绿 / run 紫 / warn 橙 / bad 红 / neutral 灰） */
import type { StatusVariant } from "../../lib/status";

const props = defineProps<{
  variant?: StatusVariant;
}>();

const variant = computed<StatusVariant>(() => props.variant ?? "neutral");
</script>

<template>
  <span
    class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-[#f2f3f6] px-2 py-[5px] text-xs text-ink"
  >
    <i
      class="h-[7px] w-[7px] rounded-full"
      :class="
        {
          ok: 'bg-ok',
          run: 'bg-run',
          warn: 'bg-warn',
          bad: 'bg-bad',
          neutral: 'bg-idle',
        }[variant]
      "
    />
    <slot />
  </span>
</template>
