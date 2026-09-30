<script setup lang="ts">
import { FileSpreadsheet } from "lucide-vue-next";
/**
 * 数据接入（/insights/data）— 发布记录绑定（统一 ID 链路）+ 四步精准匹配导入入口
 * 抖音官方 API 通道已砍除（无企业资质）：导入是外部绩效数据唯一入口（需求 §二十二 真实性约束）
 * 旧逐行下拉框向导已由 /insights/import 四步精准匹配工作台替代（确定性匹配 + 异常人工裁决）
 * 交互组件全部走 reka-ui 底座（Select/Dialog/ConfirmDialog），不使用浏览器原生 select/dialog/alert
 */
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import {
  type PublishRecordInput,
  type PublishRecordView,
  createAnalyticsPublishRecord,
  deleteAnalyticsPublishRecord,
  listAnalyticsPublishRecords,
  listTasks,
  updateAnalyticsPublishRecord,
} from "../api/client";
import Button from "../components/ui/button.vue";
import ConfirmDialog from "../components/ui/confirm-dialog.vue";
import DataTable from "../components/ui/data-table.vue";
import Dialog from "../components/ui/dialog.vue";
import Select, { type SelectOption } from "../components/ui/select.vue";
import Spinner from "../components/ui/spinner.vue";
import { sourceLabel } from "../lib/analytics-insights";
import type { DataTableColumn } from "../lib/data-table";
import { toast } from "../lib/toast";

// ── 平台/状态选项（reka Select，非原生；platform 入库为中文名，与发布记录既有口径一致） ──

const PLATFORM_OPTIONS: SelectOption[] = [
  { value: "抖音", label: "抖音" },
  { value: "快手", label: "快手" },
  { value: "视频号", label: "视频号" },
  { value: "B站", label: "B站" },
  { value: "小红书", label: "小红书" },
  { value: "其他", label: "其他" },
];
const STATUS_OPTIONS: SelectOption[] = [
  { value: "scheduled", label: "已排期" },
  { value: "published", label: "已发布" },
  { value: "deleted", label: "已删除" },
];

// ── 发布记录 ──

const records = ref<PublishRecordView[]>([]);
const recordsLoading = ref(true);
const videoOptions = ref<SelectOption[]>([]);

const RECORD_COLUMNS: DataTableColumn[] = [
  { key: "contentTitle", label: "内容", cellClass: "min-w-[220px]" },
  { key: "platform", label: "平台" },
  { key: "platformVideoId", label: "作品 ID" },
  { key: "publishTime", label: "发布时间" },
  { key: "publishStatus", label: "状态" },
  { key: "actions", label: "操作", cellClass: "text-right" },
];

const recordRowKey = (r: PublishRecordView): string => r.id;

async function loadRecords(): Promise<void> {
  recordsLoading.value = true;
  try {
    const data = await listAnalyticsPublishRecords();
    records.value = data.items;
  } catch (err) {
    // 同 key 去重（批次 4B）：反复点刷新不会叠加多条同款错误 Toast
    toast.error(err instanceof Error ? err.message : "查询发布记录失败", {
      key: "insights-data-records",
    });
  } finally {
    recordsLoading.value = false;
  }
}

async function loadVideoOptions(): Promise<void> {
  try {
    const data = await listTasks({ hasVideo: "true", pageSize: 100 });
    videoOptions.value = data.tasks.map((t) => ({ value: t.id, label: t.title || t.id }));
  } catch {
    videoOptions.value = [];
    toast.warning("可选视频清单加载失败，请点击刷新重试", { key: "insights-data-videos" });
  }
}

// 新建/编辑弹窗（editing=null 为新建）
const recDialogOpen = ref(false);
const recEditing = ref<PublishRecordView | null>(null);
const recContent = ref<string | null>(null);
const recPlatform = ref<string | null>("抖音");
const recVideoId = ref("");
const recPublishTitle = ref("");
const recPublishTime = ref("");
const recStatus = ref<string | null>("published");
const recSaving = ref(false);

function openCreateRecord(): void {
  recEditing.value = null;
  recContent.value = null;
  recPlatform.value = "抖音";
  recVideoId.value = "";
  recPublishTitle.value = "";
  recPublishTime.value = "";
  recStatus.value = "published";
  recDialogOpen.value = true;
}

function openEditRecord(row: PublishRecordView): void {
  recEditing.value = row;
  recContent.value = row.contentId;
  recPlatform.value = row.platform;
  recVideoId.value = row.platformVideoId ?? "";
  recPublishTitle.value = row.publishTitle ?? "";
  recPublishTime.value = "";
  recStatus.value = row.publishStatus;
  recDialogOpen.value = true;
}

/** "2026-09-20 18:00" → ISO；留空为 null；非法格式抛错由 submit 捕获提示 */
function toIsoOrNull(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const iso = new Date(trimmed.replace(" ", "T"));
  if (Number.isNaN(iso.getTime())) throw new Error("发布时间格式须为 YYYY-MM-DD HH:mm");
  return iso.toISOString();
}

async function submitRecord(): Promise<void> {
  recSaving.value = true;
  try {
    const platform = recPlatform.value ?? "抖音";
    const publishTime = toIsoOrNull(recPublishTime.value);
    const editing = recEditing.value;
    if (editing === null) {
      if (recContent.value === null) throw new Error("请选择要绑定的内容");
      const input: PublishRecordInput = {
        contentId: recContent.value,
        platform,
        platformVideoId: recVideoId.value.trim() === "" ? null : recVideoId.value.trim(),
        publishTitle: recPublishTitle.value.trim() === "" ? null : recPublishTitle.value.trim(),
        publishTime,
        publishStatus: (recStatus.value ?? "published") as PublishRecordInput["publishStatus"],
      };
      await createAnalyticsPublishRecord(input);
      toast.success("发布记录已创建（生产特征与时间轴已同步落库）");
    } else {
      await updateAnalyticsPublishRecord(editing.id, {
        platform,
        platformVideoId: recVideoId.value.trim() === "" ? null : recVideoId.value.trim(),
        publishTitle: recPublishTitle.value.trim() === "" ? null : recPublishTitle.value.trim(),
        ...(recPublishTime.value.trim() === "" ? {} : { publishTime }),
        publishStatus: (recStatus.value ??
          editing.publishStatus) as PublishRecordInput["publishStatus"],
      });
      toast.success("发布记录已更新");
    }
    recDialogOpen.value = false;
    await loadRecords();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  } finally {
    recSaving.value = false;
  }
}

const recToDelete = ref<PublishRecordView | null>(null);
const deleteOpen = computed({
  get: () => recToDelete.value !== null,
  set: (open: boolean) => {
    if (!open) recToDelete.value = null;
  },
});

async function confirmDeleteRecord(): Promise<void> {
  const target = recToDelete.value;
  if (target === null) return;
  try {
    await deleteAnalyticsPublishRecord(target.id);
    toast.success("发布记录已删除（关联指标级联删除）");
    await loadRecords();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "删除失败");
  } finally {
    recToDelete.value = null;
  }
}

// ── 导入入口：四步精准匹配工作台（批次 H2：旧逐行向导已删除） ──

const router = useRouter();

onMounted(async () => {
  await Promise.all([loadRecords(), loadVideoOptions()]);
});
</script>

<template>
  <main class="px-7 pt-[26px] pb-12">
    <section class="mb-[22px] flex items-end justify-between gap-5">
      <div>
        <h1 class="mb-1.5 text-[26px] font-bold">数据接入</h1>
        <p class="text-subtle">
          发布记录绑定 + 创作者后台数据导入。导入是外部绩效数据的唯一入口，落库后自动重算派生指标。
        </p>
      </div>
      <Button variant="outline" size="sm" :disabled="recordsLoading" @click="loadRecords">刷新</Button>
    </section>

    <!-- 真实性声明（需求 §二十二：不得让用户误认为数据来自平台官方接口） -->
    <div
      class="mb-4 rounded-xl border border-[#f8df9c] bg-[#fff8e8] px-3.5 py-3 text-[13px] leading-relaxed"
    >
      抖音开放平台数据通道未接入（需企业资质，本项目不具备，已按决策砍除）。
      本页导入的数据来源标注一律为 <b>[{{ sourceLabel("CREATOR_IMPORT") }}]</b>，不会伪装成平台官方 API。
      2秒跳出率、完播率等漏斗指标仅创作者后台可得。
    </div>

    <!-- ── 发布记录绑定（统一 ID 链路：platform + 作品 ID 唯一，禁标题模糊匹配） ── -->
    <section class="mb-8">
      <div class="mb-2.5 flex items-center justify-between">
        <h2 class="text-[17px] font-bold">发布记录</h2>
        <Button size="sm" @click="openCreateRecord">新建发布记录</Button>
      </div>
      <p class="mb-2.5 text-xs text-subtle leading-relaxed">
        每条已发布视频先在此绑定平台作品 ID，导入的指标才能对上号（创建/更新会自动固化生产特征与段落时间轴）。
      </p>
      <DataTable
        :columns="RECORD_COLUMNS"
        :rows="records"
        :row-key="recordRowKey"
        :loading="recordsLoading"
        empty-text="暂无发布记录 —— 点击右上角「新建发布记录」绑定平台作品 ID"
        :page-size="10"
      >
        <template #cell-contentTitle="{ row }">
          <span class="font-medium">{{ row.publishTitle || row.contentTitle }}</span>
          <span v-if="row.videoAssetId" class="ml-1.5 text-xs text-subtle">{{ row.videoAssetId }}</span>
        </template>
        <template #cell-platform="{ row }">{{ row.platform }}</template>
        <template #cell-platformVideoId="{ row }">
          <span v-if="row.platformVideoId" class="font-mono text-xs">{{ row.platformVideoId }}</span>
          <span v-else class="text-xs text-amber-700">未绑定作品 ID</span>
        </template>
        <template #cell-publishTime="{ row }">
          <span class="text-xs">{{ row.publishTime ? row.publishTime.slice(0, 16).replace("T", " ") : "—" }}</span>
        </template>
        <template #cell-publishStatus="{ row }">
          <span class="text-xs">{{ row.publishStatus === "published" ? "已发布" : row.publishStatus === "scheduled" ? "已排期" : "已删除" }}</span>
        </template>
        <template #cell-actions="{ row }">
          <div class="flex justify-end gap-1.5">
            <Button variant="outline" size="sm" class="px-2 py-0.5 text-xs" @click="openEditRecord(row)">编辑</Button>
            <Button variant="outline" size="sm" class="px-2 py-0.5 text-xs text-red-600" @click="recToDelete = row">删除</Button>
          </div>
        </template>
      </DataTable>
    </section>

    <!-- ── 数据导入入口：四步精准匹配工作台 ── -->
    <section>
      <h2 class="mb-2.5 text-[17px] font-bold">数据导入（创作者后台导出）</h2>
      <button
        class="flex w-full cursor-pointer items-center gap-4 rounded-2xl border border-hairline bg-panel px-5 py-4 text-left transition-colors hover:border-brand/50"
        data-testid="goto-import"
        @click="router.push('/insights/import')"
      >
        <FileSpreadsheet class="h-9 w-9 shrink-0 text-brand" aria-hidden="true" />
        <span class="min-w-0 flex-1">
          <span class="block text-[14px] font-bold">四步精准匹配导入工作台</span>
          <span class="block text-xs leading-relaxed text-subtle">
            导入数据 → 匹配规则 → 匹配校验 → 提交落库：系统自动完成确定性匹配，用户只处理异常；
            账号日汇总绝不归属到单个作品；批次可追溯、可回滚。
          </span>
        </span>
        <span class="shrink-0 text-sm font-medium text-brand">前往导入 →</span>
      </button>
    </section>

    <!-- 发布记录表单（reka-ui Dialog，非原生） -->
    <Dialog
      v-model:open="recDialogOpen"
      :title="recEditing === null ? '新建发布记录' : '编辑发布记录'"
      description="平台 + 作品 ID 全局唯一（禁止重复绑定）；创建成功即固化生产特征与段落时间轴。"
      width="lg"
      :dismiss-on-overlay="false"
    >
      <template #body>
        <div class="space-y-3.5">
          <div v-if="recEditing === null">
            <span class="mb-1 block text-[13px] font-bold">绑定内容（仅列已有成片的记录）</span>
            <Select v-model:value="recContent" :options="videoOptions" placeholder="选择视频内容" />
          </div>
          <div v-else>
            <span class="mb-1 block text-[13px] font-bold">绑定内容</span>
            <input :value="recEditing.contentTitle" disabled class="w-full rounded-[10px] border border-hairline bg-[#fafbfc] px-3 py-2 text-sm text-subtle" />
          </div>
          <div class="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
            <div>
              <span class="mb-1 block text-[13px] font-bold">平台</span>
              <Select v-model:value="recPlatform" :options="PLATFORM_OPTIONS" />
            </div>
            <div>
              <span class="mb-1 block text-[13px] font-bold">状态</span>
              <Select v-model:value="recStatus" :options="STATUS_OPTIONS" />
            </div>
          </div>
          <div>
            <span class="mb-1 block text-[13px] font-bold">平台作品 ID（抖音 = 作品页 URL 中的 item_id）</span>
            <input
              v-model="recVideoId"
              type="text"
              maxlength="100"
              placeholder="7432123456789012345"
              class="w-full rounded-[10px] border border-hairline bg-white px-3 py-2 font-mono text-sm focus:border-brand focus:outline-none"
            />
          </div>
          <div class="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
            <div>
              <span class="mb-1 block text-[13px] font-bold">发布标题（可选）</span>
              <input v-model="recPublishTitle" type="text" maxlength="255" placeholder="留空取内容标题" class="w-full rounded-[10px] border border-hairline bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none" />
            </div>
            <div>
              <span class="mb-1 block text-[13px] font-bold">发布时间（可选 YYYY-MM-DD HH:mm）</span>
              <input v-model="recPublishTime" type="text" maxlength="16" placeholder="2026-09-20 18:00" class="w-full rounded-[10px] border border-hairline bg-white px-3 py-2 text-sm focus:border-brand focus:outline-none" />
            </div>
          </div>
        </div>
      </template>
      <template #footer>
        <Button variant="outline" size="sm" @click="recDialogOpen = false">取消</Button>
        <Button size="sm" :disabled="recSaving" @click="submitRecord">
          <Spinner v-if="recSaving" size="sm" /> {{ recEditing === null ? "创建" : "保存" }}
        </Button>
      </template>
    </Dialog>

    <ConfirmDialog
      v-model:open="deleteOpen"
      title="删除发布记录"
      description="该记录关联的指标与每日快照将级联删除，且不可恢复。确定删除？"
      confirm-text="删除"
      destructive
      @confirm="confirmDeleteRecord"
    />
  </main>
</template>
