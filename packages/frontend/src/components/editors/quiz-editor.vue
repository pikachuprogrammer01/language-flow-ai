<script setup lang="ts">
/**
 * quiz 选择题编辑器 — CreateTask 与 TaskDetail 共用
 * editMode=false 只读展示（题干/选项/解析）；editMode=true 编辑（题干/4 选项 radio 答案/解析）
 */
import { ref, watch } from "vue";

export interface QuizQuestion {
  stem: string;
  options: string[];
  correctIndex: number;
  explanation: string;
}

const props = defineProps<{
  questions: QuizQuestion[];
  editMode: boolean;
}>();

const emit = defineEmits<{ "update:questions": [QuizQuestion[]] }>();

/** 编辑副本（深拷贝 options），props 变化时同步 */
const local = ref<QuizQuestion[]>(props.questions.map((q) => ({ ...q, options: [...q.options] })));
watch(
  () => props.questions,
  (v) => {
    local.value = v.map((q) => ({ ...q, options: [...q.options] }));
  },
);

function emitLocal(): void {
  emit(
    "update:questions",
    local.value.map((q) => ({ ...q, options: [...q.options] })),
  );
}
</script>

<template>
  <div v-if="questions.length > 0" class="mb-4 space-y-3">
    <div v-for="(q, qi) in editMode ? local : questions" :key="qi" class="rounded-lg border border-gray-200 p-4">
      <template v-if="editMode">
        <input
          v-model="q.stem"
          class="w-full rounded-lg border border-gray-300 px-2 py-1 text-sm font-medium focus:border-blue-500 focus:outline-none"
          placeholder="题干"
          @input="emitLocal"
        />
        <div class="mt-2 space-y-1">
          <div v-for="(opt, oi) in q.options" :key="oi" class="flex items-center gap-2">
            <input type="radio" :checked="q.correctIndex === oi" @change="q.correctIndex = oi; emitLocal()" />
            <span class="text-xs text-gray-400">{{ String.fromCharCode(65 + oi) }}.</span>
            <input
              v-model="q.options[oi]"
              class="w-full rounded-lg border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
              :placeholder="`选项 ${String.fromCharCode(65 + oi)}`"
              @input="emitLocal"
            />
          </div>
        </div>
        <textarea
          v-model="q.explanation"
          rows="2"
          class="mt-2 w-full rounded-lg border border-gray-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none"
          placeholder="解析"
          @input="emitLocal"
        />
      </template>
      <template v-else>
        <p class="font-medium text-gray-900">{{ qi + 1 }}. {{ q.stem }}</p>
        <ul class="mt-2 space-y-1">
          <li
            v-for="(opt, oi) in q.options"
            :key="oi"
            class="text-sm"
            :class="oi === q.correctIndex ? 'font-medium text-green-700' : 'text-gray-600'"
          >
            {{ String.fromCharCode(65 + oi) }}. {{ opt }}{{ oi === q.correctIndex ? " ✓" : "" }}
          </li>
        </ul>
        <p class="mt-2 text-xs text-gray-500">解析：{{ q.explanation }}</p>
      </template>
    </div>
  </div>
</template>
