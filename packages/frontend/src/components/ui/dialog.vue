<script setup lang="ts">
/**
 * 通用模态对话框（替代浏览器原生 dialog/alert 与手写遮罩）— reka-ui Dialog 原语底座
 * 用法：<Dialog v-model:open="open" title="新增发布记录"> <template #body>...</template> <template #footer>...</template> </Dialog>
 * - modal 焦点陷阱/ESC 关闭/遮罩点击关闭/aria-modal 由 reka 原语保证
 * - 不内置确认按钮语义（那是 ConfirmDialog 的职责）；本组件提供通用容器 + body/footer 插槽
 */
import { X } from "lucide-vue-next";
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from "reka-ui";
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    title: string;
    description?: string;
    /** 宽度档位：md=440px / lg=640px / xl=880px */
    width?: "md" | "lg" | "xl";
    /** 点击遮罩是否关闭（表单类弹窗可关掉防误触） */
    dismissOnOverlay?: boolean;
  }>(),
  { description: undefined, width: "md", dismissOnOverlay: true },
);

const open = defineModel<boolean>("open", { default: false });

function onInteractOutside(e: Event): void {
  if (!props.dismissOnOverlay) e.preventDefault();
}

const widthClass = computed(
  () =>
    ({
      md: "max-w-[440px]",
      lg: "max-w-[640px]",
      xl: "max-w-[880px]",
    })[props.width],
);
</script>

<template>
  <DialogRoot v-model:open="open" :modal="true">
    <slot name="trigger" />
    <DialogPortal>
      <DialogOverlay class="dlg-overlay fixed inset-0 z-40 bg-black/45" />
      <DialogContent
        data-testid="dialog-content"
        :class="[
          'dlg-content fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2',
          'flex max-h-[calc(100vh-4rem)] flex-col rounded-2xl border border-hairline bg-white shadow-[0_24px_70px_rgba(20,20,40,0.22)] focus:outline-none',
          widthClass,
        ]"
        @interact-outside="onInteractOutside"
      >
        <div class="flex items-start justify-between gap-3 px-6 pt-5">
          <div class="min-w-0">
            <DialogTitle class="text-[15px] font-bold leading-snug text-ink">
              {{ props.title }}
            </DialogTitle>
            <DialogDescription v-if="props.description" class="mt-1 text-xs leading-relaxed text-subtle">
              {{ props.description }}
            </DialogDescription>
          </div>
          <button
            class="shrink-0 cursor-pointer rounded-lg p-1.5 text-subtle hover:bg-brand-soft hover:text-ink"
            aria-label="关闭"
            @click="open = false"
          >
            <X class="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto px-6 py-4 text-sm text-ink">
          <slot name="body" />
        </div>
        <div v-if="$slots.footer" class="flex justify-end gap-2.5 border-t border-hairline px-6 py-4">
          <slot name="footer" />
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
/* 进出场动画与 ConfirmDialog 同一套语汇；缩放用独立 scale 属性，避免与 translate 叠加冲突 */
.dlg-overlay[data-state="open"] {
  animation: dlg-fade-in 180ms ease-out;
}
.dlg-overlay[data-state="closed"],
.dlg-content[data-state="closed"] {
  animation: dlg-fade-out 160ms ease-in forwards;
}
.dlg-content[data-state="open"] {
  animation: dlg-pop-in 200ms cubic-bezier(0.21, 1.02, 0.73, 1);
}
@keyframes dlg-fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes dlg-fade-out {
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
  }
}
@keyframes dlg-pop-in {
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
