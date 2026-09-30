<script setup lang="ts">
/**
 * 通用下拉单选（替代浏览器原生 <select>）— reka-ui Select 原语底座
 * 用法：<Select v-model:value="platform" :options="[{ value: 'douyin', label: '抖音' }]" placeholder="选择平台" />
 * - options 的 value 不允许空字符串（reka 内部限制）；「未选择」状态用 value=null 表达，显示 placeholder
 * - 键盘导航/ESC/焦点回归/ARIA 由 reka 原语保证；本组件只做呈现与事件转发，零业务逻辑
 */
import { Check, ChevronDown } from "lucide-vue-next";
import {
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectPortal,
  SelectRoot,
  SelectTrigger,
  SelectValue,
  SelectViewport,
} from "reka-ui";
import { computed } from "vue";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** 下拉项缩略图（内容确认场景：封面图）；缺省或加载失败时退回纯文本展示 */
  image?: string | null;
  /** 下拉项副行提示（如模板类型），灰色小字 */
  hint?: string | null;
}

const props = withDefaults(
  defineProps<{
    options: readonly SelectOption[];
    placeholder?: string;
    disabled?: boolean;
    /** 视觉尺寸：与既有表单控件对齐 */
    size?: "sm" | "md";
    /** 触发器额外 class（宽度等由使用方控制） */
    triggerClass?: string;
  }>(),
  { placeholder: "请选择", disabled: false, size: "md", triggerClass: "" },
);

const value = defineModel<string | null>("value", { default: null });

const sizeClasses = computed(() =>
  props.size === "sm" ? "px-2 py-1.5 text-xs rounded-[8px]" : "px-2.5 py-2 text-sm rounded-[10px]",
);

const selectedLabel = computed(
  () => props.options.find((o) => o.value === value.value)?.label ?? null,
);

function onUpdate(next: unknown): void {
  // reka 的 modelValue 流转为 string | undefined（清除选择时）
  value.value = typeof next === "string" ? next : null;
}
</script>

<template>
  <SelectRoot :model-value="value ?? undefined" :disabled="props.disabled" @update:model-value="onUpdate">
    <SelectTrigger
      data-testid="select-trigger"
      :class="[
        'flex w-full cursor-pointer items-center justify-between gap-2 border border-hairline bg-white text-left text-ink',
        'focus:border-brand focus:outline-none disabled:cursor-not-allowed disabled:opacity-50',
        sizeClasses,
        props.triggerClass,
      ]"
    >
      <SelectValue :placeholder="props.placeholder">
        <span v-if="selectedLabel !== null">{{ selectedLabel }}</span>
      </SelectValue>
      <ChevronDown class="h-3.5 w-3.5 shrink-0 text-subtle" aria-hidden="true" />
    </SelectTrigger>
    <SelectPortal>
      <SelectContent
        position="popper"
        :side-offset="4"
        class="z-50 min-w-[var(--reka-select-trigger-width)] max-h-[var(--reka-select-content-available-height)] overflow-hidden rounded-xl border border-hairline bg-white shadow-[0_16px_50px_rgba(20,20,40,0.16)]"
      >
        <SelectViewport class="p-1">
          <SelectItem
            v-for="opt in props.options"
            :key="opt.value"
            :value="opt.value"
            :disabled="opt.disabled"
            class="relative flex cursor-pointer select-none items-center gap-2 rounded-lg py-2 pl-7 pr-2.5 text-sm text-ink outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40 data-[highlighted]:bg-brand-soft"
          >
            <SelectItemIndicator class="absolute left-1.5 inline-flex items-center">
              <Check class="h-3.5 w-3.5 text-brand" aria-hidden="true" />
            </SelectItemIndicator>
            <img
              v-if="opt.image"
              :src="opt.image"
              alt=""
              class="h-8 w-14 shrink-0 rounded-md border border-hairline object-cover"
              @error="($event.target as HTMLImageElement).style.display = 'none'"
            />
            <span class="min-w-0">
              <SelectItemText>{{ opt.label }}</SelectItemText>
              <span v-if="opt.hint" class="block truncate text-[11px] text-subtle">{{ opt.hint }}</span>
            </span>
          </SelectItem>
        </SelectViewport>
      </SelectContent>
    </SelectPortal>
  </SelectRoot>
</template>
