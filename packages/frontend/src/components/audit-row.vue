<script setup lang="ts">
/** 审计管理行 — AuditList 表格行（主行 + 展开档案行） */
import type { UploadMark } from "../api/client";

export interface AuditDetail {
  audit?: {
    input?: { topic?: string; level?: string; wordCount?: number; targetDuration?: number };
    process?: {
      candidates?: { source?: string; word?: string }[];
      attempts?: { result?: string; reason?: string; injectedWords?: string[] }[];
    };
    modifications?: { at?: string; fields?: string[] }[];
  };
  error?: string;
}

export interface AuditTask {
  id: string;
  title: string;
  level: string;
  status: string;
  wordsCount: number;
  textPreview: string;
  auditSummary?: { hasAudit: boolean; candidates: number; attempts: number; modifications: number };
  video?: unknown;
  createdAt: string;
}

defineProps<{
  t: AuditTask;
  marks: UploadMark[];
  selected: boolean;
  expanded: boolean;
  detail?: AuditDetail | null;
}>();

const emit = defineEmits<{
  toggleSelect: [];
  toggleExpand: [];
  openMarks: [];
  remove: [];
}>();

const STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  ai_generating: "生成中",
  content_ready: "内容就绪",
  tts_processing: "配音中",
  audio_ready: "配音完成",
  video_rendering: "渲染中",
  completed: "已完成",
  failed: "失败",
};
</script>

<template>
  <tr class="hover:bg-gray-50">
      <td class="px-2 py-2.5">
        <input type="checkbox" :checked="selected" @change="emit('toggleSelect')" />
      </td>
      <td class="max-w-56 px-4 py-2.5">
        <button class="text-left font-medium text-blue-600 hover:underline" @click="emit('toggleExpand')">
          {{ t.title }}
          <span class="text-xs text-gray-400">{{ expanded ? "▾" : "▸" }}</span>
        </button>
      </td>
      <td class="px-4 py-2.5">
        <span
          class="rounded px-1.5 py-0.5 text-xs"
          :class="t.status === 'completed' ? 'bg-green-50 text-green-700' : t.status === 'failed' ? 'bg-red-50 text-red-700' : 'bg-gray-100 text-gray-600'"
        >
          {{ STATUS_LABEL[String(t.status)] ?? String(t.status) }}
        </span>
      </td>
      <td class="px-4 py-2.5 text-gray-600">{{ String(t.level) }}</td>
      <td class="px-4 py-2.5 text-gray-600">{{ t.wordsCount }}</td>
      <td class="px-4 py-2.5 text-gray-600">
        {{ t.auditSummary?.candidates ?? 0 }}
        <span v-if="t.auditSummary?.hasAudit" class="ml-1 rounded bg-blue-50 px-1 text-xs text-blue-600">有档案</span>
        <span v-else class="ml-1 rounded bg-gray-100 px-1 text-xs text-gray-400">无</span>
      </td>
      <td class="px-4 py-2.5 text-gray-600">
        {{ t.auditSummary?.attempts ?? 0 }}
        <span v-if="(t.auditSummary?.attempts ?? 0) > 1" class="ml-1 text-xs text-amber-600">重试过</span>
      </td>
      <td class="px-4 py-2.5 text-gray-600">{{ t.auditSummary?.modifications ?? 0 }}</td>
      <td class="px-4 py-2.5">
        <button
          class="flex flex-wrap items-center gap-1"
          :disabled="marks.length === 0"
          :title="marks.length > 0 ? '点击管理上传标记' : undefined"
          @click="emit('openMarks')"
        >
          <span
            v-for="m in marks.slice(0, 2)"
            :key="m.id"
            class="rounded bg-green-50 px-1.5 py-0.5 text-xs text-green-700"
          >
            {{ m.platform }}
          </span>
          <span v-if="marks.length === 0" class="text-xs text-gray-400">—</span>
        </button>
      </td>
      <td class="px-4 py-2.5 text-gray-500">
        {{ new Date(String(t.createdAt)).toLocaleString("zh-CN") }}
      </td>
      <td class="px-4 py-2.5">
        <button class="text-xs text-red-500 hover:underline" @click="emit('remove')">删除</button>
      </td>
    </tr>
    <!-- 行展开：完整档案 -->
    <tr v-if="expanded">
      <td colspan="11" class="bg-gray-50 px-6 py-4">
        <div class="space-y-2 text-xs leading-relaxed text-gray-600">
          <p class="text-gray-400">{{ String(t.textPreview) }}</p>
          <template v-if="detail?.audit">
            <div>
              输入：主题「{{ detail.audit.input?.topic }}」 · {{ detail.audit.input?.level }}
              · 词数 {{ detail.audit.input?.wordCount ?? "自动" }}
              · 目标时长 {{ detail.audit.input?.targetDuration ?? 60 }}s
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
      </td>
    </tr>
</template>
