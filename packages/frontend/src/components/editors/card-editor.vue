<script setup lang="ts">
/**
 * word_card 单词卡片编辑器 — CreateTask 与 TaskDetail 共用
 * 统一 example 字段（父组件把编辑态 text 字段映射为 example 传入）
 * editMode=false 只读展示；editMode=true 编辑（单词/词性/释义/例句/例句翻译）
 */
import { ref, watch } from "vue";

export interface WordCard {
  word: string;
  pos: string;
  meaning: string;
  example: string;
  exampleMeaning?: string;
}

const props = defineProps<{
  cards: WordCard[];
  editMode: boolean;
}>();

const emit = defineEmits<{ "update:cards": [WordCard[]] }>();

/** 编辑副本，props 变化时同步 */
const local = ref<WordCard[]>(props.cards.map((c) => ({ ...c })));
watch(
  () => props.cards,
  (v) => {
    local.value = v.map((c) => ({ ...c }));
  },
);

function emitLocal(): void {
  emit(
    "update:cards",
    local.value.map((c) => ({ ...c })),
  );
}
</script>

<template>
  <div v-if="cards.length > 0" class="mb-4 grid gap-3 sm:grid-cols-2">
    <div v-for="(c, i) in editMode ? local : cards" :key="i" class="rounded-lg border border-gray-200 p-4">
      <template v-if="editMode">
        <div class="flex gap-2">
          <input
            v-model="c.word"
            class="w-1/2 rounded-lg border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
            placeholder="单词"
            @input="emitLocal"
          />
          <input
            v-model="c.pos"
            class="w-1/2 rounded-lg border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
            placeholder="词性"
            @input="emitLocal"
          />
        </div>
        <input
          v-model="c.meaning"
          class="mt-2 w-full rounded-lg border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
          placeholder="释义"
          @input="emitLocal"
        />
        <input
          v-model="c.example"
          class="mt-2 w-full rounded-lg border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
          placeholder="例句"
          @input="emitLocal"
        />
        <input
          v-model="c.exampleMeaning"
          class="mt-2 w-full rounded-lg border border-gray-300 px-2 py-1 text-sm focus:border-blue-500 focus:outline-none"
          placeholder="例句翻译"
          @input="emitLocal"
        />
      </template>
      <template v-else>
        <div class="flex items-baseline gap-2">
          <b class="text-lg text-gray-900">{{ c.word }}</b>
          <span class="text-xs text-gray-400">{{ c.pos }}</span>
        </div>
        <p class="mt-1 text-sm text-gray-700">{{ c.meaning }}</p>
        <p class="mt-2 text-sm leading-relaxed text-gray-800">{{ c.example }}</p>
        <p v-if="c.exampleMeaning" class="mt-1 text-xs text-gray-500">{{ c.exampleMeaning }}</p>
      </template>
    </div>
  </div>
</template>
