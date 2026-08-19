<script setup lang="ts">
/** 词汇胶囊展示 — CreateTask 与 TaskDetail 共用（去重后的词汇列表） */
defineProps<{
  words: { word: string; meaning: string }[];
}>();
</script>

<template>
  <div v-if="words.length > 0" class="flex flex-wrap gap-2">
    <span
      v-for="w in words"
      :key="w.word"
      class="rounded-full bg-amber-100 px-3 py-1 text-sm text-gray-800"
    >
      <b class="text-gray-900">{{ w.word }}</b> {{ w.meaning }}
    </span>
  </div>
</template>
