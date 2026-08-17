<script setup lang="ts">
/**
 * shadcn-vue AlertDialog 封装（确认对话框，替代原生 window.confirm）
 * 用法：<ConfirmDialog v-model:open="open" title="..." description="..." confirm-text="删除" destructive @confirm="fn" />
 */
import {
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogRoot,
  AlertDialogTitle,
} from "radix-vue";
import Button from "./button.vue";

defineProps<{
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
    <AlertDialogContent
      class="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border bg-background p-6 shadow-lg"
    >
      <div>
        <AlertDialogTitle class="text-lg font-semibold">{{ title }}</AlertDialogTitle>
        <AlertDialogDescription v-if="description" class="mt-2 text-sm text-muted-foreground">
          {{ description }}
        </AlertDialogDescription>
      </div>
      <div class="mt-5 flex justify-end gap-2">
        <AlertDialogCancel as-child>
          <Button variant="outline" size="sm">{{ cancelText ?? "取消" }}</Button>
        </AlertDialogCancel>
        <AlertDialogAction as-child>
          <Button :variant="destructive ? 'destructive' : 'default'" size="sm" @click="emit('confirm')">
            {{ confirmText ?? "确定" }}
          </Button>
        </AlertDialogAction>
      </div>
    </AlertDialogContent>
  </AlertDialogRoot>
</template>
