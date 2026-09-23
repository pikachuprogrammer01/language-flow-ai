<script setup lang="ts">
/** 审计档案展开面板 — DataTable #expand 插槽内容（输入/候选词/重试/修改日志） */
import type { AuditInfo } from "./audit-panel.vue";

export interface AuditDetail {
  audit?: AuditInfo;
  error?: string;
}

defineProps<{
  /** 正文摘要（展开区顶部灰字） */
  preview: string;
  /** 懒加载的完整档案；null=加载中 */
  detail: AuditDetail | null;
}>();
</script>

<template>
  <div class="space-y-2 text-xs leading-relaxed text-gray-600">
    <p class="text-gray-400">{{ preview }}</p>
    <p v-if="detail === null" class="text-gray-400">档案加载中…</p>
    <template v-else-if="detail.audit">
      <div v-if="detail.audit.input">
        输入：主题「{{ detail.audit.input.topic }}」 · {{ detail.audit.input.level }}
        · 词数 {{ detail.audit.input.wordCount ?? "自动" }}
        · 目标时长 {{ detail.audit.input.targetDuration ?? 60 }}s
      </div>
      <div v-if="detail.audit.process?.candidates?.length">
        候选词（{{ detail.audit.process.candidates.length }}）：
        <span
          v-for="c in detail.audit.process.candidates"
          :key="c.word"
          class="mr-1.5 inline-block rounded bg-white px-1.5 py-0.5"
        >
          {{ c.word }}<span class="text-gray-400">（{{ c.source }}）</span>
        </span>
      </div>
      <div v-if="detail.audit.process?.attempts?.length">
        生成尝试：
        <ul class="ml-4 list-disc">
          <li v-for="(a, i) in detail.audit.process.attempts" :key="i">
            第 {{ i + 1 }} 次：{{ a.result === "accepted" ? "通过" : "拒绝" }}{{ a.reason ? `（${a.reason}）` : "" }}
            <span v-if="a.injectedWords?.length"> · 注入 {{ a.injectedWords.length }} 词</span>
          </li>
        </ul>
      </div>
      <div v-if="detail.audit.modifications?.length">
        修改日志：
        <ul class="ml-4 list-disc">
          <li v-for="(m, i) in detail.audit.modifications" :key="i">
            {{ new Date(String(m.at)).toLocaleString("zh-CN") }} · {{ (m.fields ?? []).join("、") }}
          </li>
        </ul>
      </div>
    </template>
    <p v-else-if="detail?.error" class="text-red-400">{{ detail.error }}</p>
    <p v-else class="text-gray-400">该记录无审计档案（生成于审计功能上线前）</p>
  </div>
</template>
