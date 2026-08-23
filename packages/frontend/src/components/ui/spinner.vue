<script setup lang="ts">
/** 行内加载指示器（按钮 loading 态用，配合 animate-spin 旋转） */
defineProps<{ size?: "sm" | "md" | "lg" }>();
</script>

<template>
  <svg
    class="animate-spin text-current"
    :class="size === 'sm' ? 'h-3 w-3' : size === 'lg' ? 'h-6 w-6' : 'h-4 w-4'"
    xmlns="http://www.w3.org/2000/svg"
    fill="none"
    viewBox="0 0 24 24"
  >
    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
    <path
      class="opacity-90"
      fill="currentColor"
      d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z"
    />
  </svg>
</template>
