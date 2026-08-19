<script setup lang="ts">
/** 生成档案面板（PRD 10.1.4 审计：输入/候选词/重试历史/修改日志）— TaskDetail 使用 */
export interface AuditInfo {
  input?: { topic?: string; level?: string; wordCount?: number; targetDuration?: number };
  process?: {
    candidates?: { source?: string; word?: string }[];
    attempts?: { result?: string; reason?: string; injectedWords?: string[] }[];
  };
  modifications?: { at?: string; fields?: string[] }[];
}

defineProps<{ audit: AuditInfo | null }>();
</script>

<template>
  <details class="mt-8 rounded-lg border border-gray-200">
    <summary class="cursor-pointer px-4 py-3 text-sm font-medium text-gray-700">
      生成档案（输入 / 候选词 / 重试 / 修改日志）
      <span v-if="audit" class="ml-2 rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-600">有档案</span>
      <span v-else class="ml-2 rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-400">无档案</span>
    </summary>
    <div class="space-y-3 border-t px-4 py-3 text-xs leading-relaxed text-gray-600">
      <p v-if="!audit" class="text-gray-400">
        该记录生成于审计功能上线前，无过程档案；此后对它的修改会记录在下方修改日志中。
      </p>
      <div v-if="audit?.input">
        主题「{{ audit.input.topic }}」 · {{ audit.input.level }} · 词数
        {{ audit.input.wordCount ?? "自动" }} · 目标时长 {{ audit.input.targetDuration ?? 60 }}s
      </div>
      <div v-if="audit?.process?.candidates?.length">
        候选词（{{ audit.process.candidates.length }}）：
        <span
          v-for="c in audit.process.candidates"
          :key="c.word"
          class="mr-1.5 inline-block rounded bg-gray-100 px-1.5 py-0.5"
        >
          {{ c.word }}<span class="text-gray-400">（{{ c.source }}）</span>
        </span>
      </div>
      <div v-if="audit?.process?.attempts?.length">
        生成尝试（{{ audit.process.attempts.length }} 次）：
        <ul class="ml-4 list-disc">
          <li v-for="(a, i) in audit.process.attempts" :key="i">
            第 {{ i + 1 }} 次：{{ a.result === "accepted" ? "通过" : "拒绝" }}{{ a.reason ? `（${a.reason}）` : "" }}
            <span v-if="a.injectedWords?.length"> · 注入 {{ a.injectedWords.length }} 词</span>
          </li>
        </ul>
      </div>
      <div v-if="audit?.modifications?.length">
        修改日志：
        <ul class="ml-4 list-disc">
          <li v-for="(m, i) in audit.modifications" :key="i">
            {{ new Date(String(m.at)).toLocaleString("zh-CN") }} · {{ (m.fields ?? []).join("、") }}
          </li>
        </ul>
      </div>
    </div>
  </details>
</template>
