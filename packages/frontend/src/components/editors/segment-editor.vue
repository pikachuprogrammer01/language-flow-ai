<script setup lang="ts">
/**
 * scene_word 正文段落编辑器 — CreateTask 与 TaskDetail 共用
 * editMode=false 只读展示段落；editMode=true textarea 编辑（local 副本 + emit，不改入参）
 */
import { ref, watch } from "vue";

const props = defineProps<{
  /** 展示/编辑的段落文本（editMode=false 传展示文本，true 传编辑文本） */
  texts: string[];
  editMode: boolean;
}>();

const emit = defineEmits<{ "update:texts": [string[]] }>();

/** 编辑副本：props 变化时同步 */
const local = ref<string[]>([...props.texts]);
watch(
  () => props.texts,
  (v) => {
    local.value = [...v];
  },
);

function emitLocal(): void {
  emit("update:texts", [...local.value]);
}
</script>

<template>
  <div class="mb-4 space-y-3">
    <template v-for="(t, i) in texts" :key="i">
      <textarea
        v-if="editMode"
        v-model="local[i]"
        rows="3"
        class="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
        placeholder="正文段落"
        @input="emitLocal"
      />
      <p v-else class="text-gray-700">{{ t }}</p>
    </template>
  </div>
</template>
