<script setup lang="ts">
import { CircleAlert, CircleCheck, CircleX, Info, X } from "lucide-vue-next";
/**
 * 全局轻提示渲染宿主（App.vue 挂载一次）— reka-ui Toast 底座 + lucide 图标
 * 状态源：lib/toast.ts（toast.success/error/warning/info）；本组件零业务逻辑，纯受控渲染
 */
import {
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastRoot,
  ToastTitle,
  ToastViewport,
} from "reka-ui";
import { type ToastVariant, useToasts } from "../../lib/toast";

const { toasts, dismiss } = useToasts();

/** 变体 → 图标 / 强调色（图标着色 + 左侧色条，风格对齐设计令牌） */
const ICONS: Record<ToastVariant, typeof CircleCheck> = {
  success: CircleCheck,
  error: CircleX,
  warning: CircleAlert,
  info: Info,
};
const ICON_CLASS: Record<ToastVariant, string> = {
  success: "text-ok",
  error: "text-bad",
  warning: "text-warn",
  info: "text-brand",
};
const BAR_CLASS: Record<ToastVariant, string> = {
  success: "before:bg-ok",
  error: "before:bg-bad",
  warning: "before:bg-warn",
  info: "before:bg-brand",
};
</script>

<template>
  <ToastProvider :duration="5000" :swipe-direction="'up'">
    <ToastRoot
      v-for="t in toasts"
      :key="t.id"
      :open="t.open"
      class="toast-item pointer-events-auto relative flex w-[420px] max-w-[92vw] items-start gap-3 overflow-hidden rounded-xl border border-hairline bg-white py-3 pl-4 pr-9 shadow-[0_12px_40px_rgba(20,20,40,0.14)]"
      :class="BAR_CLASS[t.variant]"
      @update:open="(v: boolean) => { if (!v) dismiss(t.id); }"
      @escape-key-down="dismiss(t.id)"
    >
      <component :is="ICONS[t.variant]" class="mt-0.5 h-[18px] w-[18px] shrink-0" :class="ICON_CLASS[t.variant]" />
      <div class="min-w-0 flex-1">
        <ToastTitle class="text-sm font-semibold leading-snug text-ink">{{ t.title }}</ToastTitle>
        <ToastDescription v-if="t.description" class="mt-0.5 text-xs leading-snug text-subtle">
          {{ t.description }}
        </ToastDescription>
      </div>
      <ToastClose
        class="absolute right-2.5 top-2.5 cursor-pointer rounded-md p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
        aria-label="关闭提示"
        @click="dismiss(t.id)"
      >
        <X class="h-3.5 w-3.5" />
      </ToastClose>
    </ToastRoot>
    <ToastViewport
      class="fixed left-1/2 top-5 z-[100] flex max-h-screen w-[440px] max-w-[94vw] -translate-x-1/2 flex-col items-center gap-2 outline-none"
    />
  </ToastProvider>
</template>

<style scoped>
/* 进出场动画：reka 提供 data-state，位移+淡入淡出与 lib 中 EXIT_MS 退场窗口对齐 */
.toast-item[data-state="open"] {
  animation: toast-in 220ms cubic-bezier(0.21, 1.02, 0.73, 1);
}
.toast-item[data-state="closed"] {
  animation: toast-out 300ms cubic-bezier(0.06, 0.71, 0.55, 1) forwards;
}
/* 左侧变体色条（BAR_CLASS 的 before:bg-* 提供颜色，这里给形状） */
.toast-item::before {
  content: "";
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
}
@keyframes toast-in {
  from {
    opacity: 0;
    transform: translateY(-12px) scale(0.97);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
@keyframes toast-out {
  from {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
  to {
    opacity: 0;
    transform: translateY(-10px) scale(0.97);
  }
}
</style>
