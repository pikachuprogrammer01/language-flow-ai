<script setup lang="ts">
// 审计统一管理界面（PRD 10.1.4）：搜索 / 单删 / 批量删除 / 行展开完整档案
import { computed, onMounted, ref } from "vue";
import { toast } from "vue-sonner";
import { batchDeleteTasks, deleteTask, getTask, listTasks } from "../api/client";
import ConfirmDialog from "../components/ui/confirm-dialog.vue";

type TaskSummary = NonNullable<Awaited<ReturnType<typeof listTasks>>["tasks"]>[number];

/** 行展开的详情类型（宽松解析，与后端 audit 结构对齐） */
interface AuditDetail {
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

const loading = ref(true);
const errorMsg = ref("");
const tasks = ref<TaskSummary[]>([]);
const keyword = ref("");
/** 选中 id 集合（批量操作） */
const selected = ref<Set<string>>(new Set());
/** 行展开详情缓存（id → audit 等完整档案） */
const expanded = ref<Set<string>>(new Set());
const details = ref<Record<string, AuditDetail>>({});
/** 确认对话框状态 */
const deleteOpen = ref(false);
const batchOpen = ref(false);
const pendingDeleteId = ref("");

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

const allChecked = computed(
  () => tasks.value.length > 0 && selected.value.size === tasks.value.length,
);

function toggleAll(): void {
  selected.value = allChecked.value ? new Set() : new Set(tasks.value.map((t) => t.id));
}

async function load(): Promise<void> {
  loading.value = true;
  errorMsg.value = "";
  try {
    const data = await listTasks({ keyword: keyword.value.trim() || undefined });
    tasks.value = data.tasks ?? [];
    selected.value = new Set();
    expanded.value = new Set();
    details.value = {};
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

/** 行展开：懒加载完整档案（含 audit） */
async function toggleExpand(id: string): Promise<void> {
  if (expanded.value.has(id)) {
    expanded.value.delete(id);
    return;
  }
  expanded.value.add(id);
  if (!details.value[id]) {
    try {
      details.value[id] = await getTask(id);
    } catch {
      details.value[id] = { error: "详情加载失败" };
    }
  }
}

function requestDelete(id: string): void {
  pendingDeleteId.value = id;
  deleteOpen.value = true;
}

/** 单条删除（确认后） */
async function doDelete(): Promise<void> {
  try {
    await deleteTask(pendingDeleteId.value);
    toast.success("记录已删除");
    await load();
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  } finally {
    pendingDeleteId.value = "";
  }
}

/** 批量删除（确认后） */
async function doBatchDelete(): Promise<void> {
  try {
    const ids = [...selected.value];
    const result = await batchDeleteTasks(ids);
    toast.success(
      `已删除 ${result.deleted} 条${result.notFound.length > 0 ? `，${result.notFound.length} 条不存在` : ""}`,
    );
    await load();
  } catch (err) {
    errorMsg.value = err instanceof Error ? err.message : String(err);
  }
}

onMounted(load);
</script>

<template>
  <div class="mx-auto max-w-6xl px-6 py-10">
    <h1 class="text-xl font-bold">审计管理</h1>
    <p class="mt-1 text-sm text-gray-500">
      全部生成记录的审计档案一览（输入/候选词/重试/修改日志），点击行展开完整档案
    </p>

    <!-- 工具栏：搜索 + 批量操作 -->
    <div class="mt-4 flex items-center gap-3">
      <input
        v-model="keyword"
        placeholder="搜索标题…"
        class="w-64 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
        @keyup.enter="load"
      />
      <button
        class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        @click="load"
      >
        搜索
      </button>
      <button
        v-if="selected.size > 0"
        class="rounded-lg border px-4 py-2 text-sm text-red-500 hover:bg-red-50"
        @click="batchOpen = true"
      >
        删除选中（{{ selected.size }}）
      </button>
    </div>

    <p v-if="errorMsg" class="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-600">{{ errorMsg }}</p>
    <p v-else-if="loading" class="mt-6 text-center text-sm text-gray-400">加载中…</p>
    <p v-else-if="tasks.length === 0" class="mt-6 text-center text-sm text-gray-400">
      暂无生成记录{{ keyword ? "（当前搜索无结果）" : "" }}
    </p>

    <div v-else class="mt-4 overflow-x-auto rounded-lg border">
      <table class="w-full text-left text-sm">
        <thead class="bg-gray-50 text-xs text-gray-500">
          <tr>
            <th class="w-8 px-2 py-2.5">
              <input type="checkbox" :checked="allChecked" @change="toggleAll" />
            </th>
            <th class="px-4 py-2.5 font-medium">标题</th>
            <th class="px-4 py-2.5 font-medium">状态</th>
            <th class="px-4 py-2.5 font-medium">等级</th>
            <th class="px-4 py-2.5 font-medium">词汇</th>
            <th class="px-4 py-2.5 font-medium">候选词</th>
            <th class="px-4 py-2.5 font-medium">生成尝试</th>
            <th class="px-4 py-2.5 font-medium">修改次数</th>
            <th class="px-4 py-2.5 font-medium">创建时间</th>
            <th class="px-4 py-2.5 font-medium">操作</th>
          </tr>
        </thead>
        <tbody class="divide-y">
          <template v-for="t in tasks" :key="t.id">
            <tr class="hover:bg-gray-50">
              <td class="px-2 py-2.5">
                <input
                  type="checkbox"
                  :checked="selected.has(t.id)"
                  @change="selected.has(t.id) ? selected.delete(t.id) : selected.add(t.id)"
                />
              </td>
              <td class="max-w-56 px-4 py-2.5">
                <button class="text-left font-medium text-blue-600 hover:underline" @click="toggleExpand(t.id)">
                  {{ t.title }}
                  <span class="text-xs text-gray-400">{{ expanded.has(t.id) ? "▾" : "▸" }}</span>
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
              <td class="px-4 py-2.5 text-gray-500">
                {{ new Date(String(t.createdAt)).toLocaleString("zh-CN") }}
              </td>
              <td class="px-4 py-2.5">
                <button class="text-xs text-red-500 hover:underline" @click="requestDelete(t.id)">删除</button>
              </td>
            </tr>
            <!-- 行展开：完整档案 -->
            <tr v-if="expanded.has(t.id)">
              <td colspan="10" class="bg-gray-50 px-6 py-4">
                <div class="space-y-2 text-xs leading-relaxed text-gray-600">
                  <p class="text-gray-400">{{ String(t.textPreview) }}</p>
                  <template v-if="details[t.id]?.audit">
                    <div>
                      输入：主题「{{ details[t.id]?.audit?.input?.topic }}」 · {{ details[t.id]?.audit?.input?.level }}
                      · 词数 {{ details[t.id]?.audit?.input?.wordCount ?? "自动" }}
                      · 目标时长 {{ details[t.id]?.audit?.input?.targetDuration ?? 60 }}s
                    </div>
                    <div v-if="details[t.id]?.audit?.process?.candidates?.length">
                      候选词（{{ details[t.id]?.audit?.process?.candidates?.length }}）：
                      <span
                        v-for="c in details[t.id]?.audit?.process?.candidates"
                        :key="c.word"
                        class="mr-1.5 inline-block rounded bg-white px-1.5 py-0.5"
                      >
                        {{ c.word }}<span class="text-gray-400">（{{ c.source }}）</span>
                      </span>
                    </div>
                    <div v-if="details[t.id]?.audit?.process?.attempts?.length">
                      生成尝试：
                      <ul class="ml-4 list-disc">
                        <li v-for="(a, i) in details[t.id]?.audit?.process?.attempts" :key="i">
                          第 {{ i + 1 }} 次：{{ a.result === "accepted" ? "通过" : "拒绝" }}{{ a.reason ? `（${a.reason}）` : "" }}
                          <span v-if="a.injectedWords?.length"> · 注入 {{ a.injectedWords.length }} 词</span>
                        </li>
                      </ul>
                    </div>
                    <div v-if="details[t.id]?.audit?.modifications?.length">
                      修改日志：
                      <ul class="ml-4 list-disc">
                        <li v-for="(m, i) in details[t.id]?.audit?.modifications" :key="i">
                          {{ new Date(String(m.at)).toLocaleString("zh-CN") }} · {{ (m.fields ?? []).join("、") }}
                        </li>
                      </ul>
                    </div>
                  </template>
                  <p v-else-if="details[t.id]?.error" class="text-red-400">{{ details[t.id].error }}</p>
                  <p v-else class="text-gray-400">该记录无审计档案（生成于审计功能上线前）</p>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <!-- 删除确认对话框（shadcn-vue AlertDialog） -->
    <ConfirmDialog
      v-model:open="deleteOpen"
      title="删除生成记录"
      description="确定删除这条生成记录吗？"
      confirm-text="删除"
      destructive
      @confirm="doDelete"
    />
    <ConfirmDialog
      v-model:open="batchOpen"
      title="批量删除"
      :description="`确定删除选中的 ${selected.size} 条生成记录吗？此操作不可恢复。`"
      confirm-text="删除"
      destructive
      @confirm="doBatchDelete"
    />
  </div>
</template>
