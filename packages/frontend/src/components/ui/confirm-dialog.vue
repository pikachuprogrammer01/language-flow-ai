<script setup lang="ts">
import { CircleAlert, TriangleAlert } from "lucide-vue-next";
/**
 * 确认对话框（替代原生 window.confirm）— reka-ui AlertDialog 底座 + lucide 图标
 * 用法：<ConfirmDialog v-model:open="open" title="..." description="..." confirm-text="删除" destructive @confirm="fn" />
 * 焦点管理/ESC 关闭/遮罩点击关闭由 reka 原语保证；本组件只做呈现与事件转发，零内部状态机。
 */
import {
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogRoot,
  AlertDialogTitle,
} from "reka-ui";
import Button from "./button.vue";

const props = defineProps<{
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
}>();

const open = defineModel<boolean>("open", { default: false });

const emit = defineEmits<{ confirm: [] }>();
</script>

<template>
  <AlertDialogRoot v-model:open="open">
    <slot name="trigger" />
    <AlertDialogPortal>
      <AlertDialogOverlay class="cd-overlay fixed inset-0 z-40 bg-black/45" />
      <AlertDialogContent
        class="cd-content fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-[400px] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-hairline bg-white p-6 shadow-[0_24px_70px_rgba(20,20,40,0.22)] focus:outline-none"
      >
        <div class="flex items-start gap-3.5">
          <span
            class="grid h-10 w-10 shrink-0 place-items-center rounded-full"
            :class="props.destructive ? 'bg-red-50 text-bad' : 'bg-brand-soft text-brand'"
          >
            <component
              :is="props.destructive ? TriangleAlert : CircleAlert"
              class="h-5 w-5"
              aria-hidden="true"
            />
          </span>
          <div class="min-w-0 pt-0.5">
            <AlertDialogTitle class="text-[15px] font-bold leading-snug text-ink">
              {{ props.title }}
            </AlertDialogTitle>
            <AlertDialogDescription
              v-if="props.description"
              class="mt-1.5 text-sm leading-relaxed text-subtle"
            >
              {{ props.description }}
            </AlertDialogDescription>
          </div>
        </div>
        <div class="mt-6 flex justify-end gap-2.5">
          <AlertDialogCancel as-child>
            <Button variant="outline" size="sm" class="min-w-[76px]">
              {{ props.cancelText ?? "取消" }}
            </Button>
          </AlertDialogCancel>
          <AlertDialogAction as-child>
            <Button :variant="props.destructive ? 'destructive' : 'default'" size="sm" class="min-w-[76px]" @click="emit('confirm')">
              {{ props.confirmText ?? "确定" }}
            </Button>
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialogPortal>
  </AlertDialogRoot>
</template>

<style scoped>
/* 进出场动画：reka 提供 data-state，不依赖 tailwind 动画插件。
   注意：Tailwind v4 的居中位移走独立 translate 属性（-translate-x/y-1/2），
   keyframes 绝不能再写 transform: translate(...)——两者叠加会把弹窗多推半个身位（先偏左再跳回居中）；
   缩放用独立 scale 属性，与 translate 互不干扰。 */
.cd-overlay[data-state="open"] {
  animation: cd-fade-in 180ms ease-out;
}
.cd-overlay[data-state="closed"],
.cd-content[data-state="closed"] {
  animation: cd-fade-out 160ms ease-in forwards;
}
.cd-content[data-state="open"] {
  animation: cd-pop-in 200ms cubic-bezier(0.21, 1.02, 0.73, 1);
}
@keyframes cd-fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes cd-fade-out {
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
  }
}
@keyframes cd-pop-in {
  from {
    opacity: 0;
    scale: 0.96;
  }
  to {
    opacity: 1;
    scale: 1;
  }
}
</style>
