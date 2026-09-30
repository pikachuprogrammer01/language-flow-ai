<script setup lang="ts">
import { CircleCheck, CircleX, LoaderCircle, Search, TriangleAlert } from "lucide-vue-next";
/**
 * STEP 3 右侧详情面板：平台导入记录 + 候选视频（封面/标题/video_id/发布时间/时长 + 匹配证据 checklist）
 + 人工裁决动作区。
 * CONFLICT 展示全部候选并列，「选择此视频」必须显式点击（系统绝不自动选最高分）；
 * UNMATCHED 提供搜索绑定 / 外部视频 / 账号级 / 忽略；
 * ACCOUNT_DAY_LEVEL 只给「保存为账号日级 / 忽略」，绝不出现"确认归属此视频"。
 */
import { computed, ref, watch } from "vue";
import {
  type ImportRowDetail,
  type PublishRecordView,
  listAnalyticsPublishRecords,
} from "../../api/client";
import {
  evidenceChecklist,
  formatDuration,
  rowActions,
  statusPillMeta,
} from "../../lib/import-batch";
import Button from "../ui/button.vue";
import Spinner from "../ui/spinner.vue";

const props = defineProps<{
  detail: ImportRowDetail | null;
  loading: boolean;
  busy: boolean;
}>();

const emit = defineEmits<{
  confirm: [rowId: number];
  assign: [rowId: number, videoId: string];
  external: [rowId: number];
  accountDay: [rowId: number];
  ignore: [rowId: number];
  reset: [rowId: number];
}>();

const status = computed(() => props.detail?.row.matchStatus ?? null);
const actions = computed(() =>
  status.value === null
    ? null
    : rowActions(
        status.value,
        props.detail?.decision !== null && props.detail?.decision !== undefined,
      ),
);

const showRaw = ref(false);
watch(
  () => props.detail?.row.id,
  () => {
    showRaw.value = false;
  },
);

/** 指标列键值对（提为 computed：模板闭包内丢失 v-else 收窄） */
const metricPairs = computed<[string, string][]>(() => {
  const d = props.detail;
  if (d === null) return [];
  return d.row.normalized.metricHeaders.map(
    (h) => [h, d.row.rawData[h] ?? "—"] as [string, string],
  );
});

function fmtTime(iso: string | null): string {
  return iso === null ? "—" : new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

// ── UNMATCHED 搜索系统视频 ──
const searchKeyword = ref("");
const searchResults = ref<PublishRecordView[]>([]);
const searching = ref(false);
const searchError = ref("");

async function onSearch(): Promise<void> {
  if (searchKeyword.value.trim() === "") return;
  searching.value = true;
  searchError.value = "";
  try {
    const res = await listAnalyticsPublishRecords({
      keyword: searchKeyword.value.trim(),
      pageSize: 20,
    });
    searchResults.value = res.items;
    if (res.items.length === 0)
      searchError.value = "没有匹配的系统视频（可换关键词，或标记为外部视频）";
  } catch (err) {
    searchError.value = err instanceof Error ? err.message : "搜索失败";
  } finally {
    searching.value = false;
  }
}
</script>

<template>
  <aside class="w-[380px] shrink-0 self-start rounded-2xl border border-hairline bg-panel p-3" data-testid="detail-panel">
    <h3 class="mb-2 text-[14px] font-bold">匹配详情</h3>

    <div v-if="loading" class="flex items-center justify-center gap-2 py-10 text-xs text-subtle">
      <Spinner size="sm" /> 加载行详情…
    </div>

    <p v-else-if="detail === null" class="rounded-xl border border-dashed border-hairline bg-white px-3 py-8 text-center text-xs text-subtle">
      点击左侧任意记录行<br />查看导入数据、候选视频与匹配证据
    </p>

    <template v-else>
      <!-- 状态条 -->
      <div
        class="mb-2.5 flex items-center gap-2 rounded-xl px-3 py-2"
        :class="{
          'bg-green-50 text-green-800': status === 'unique_match' || status === 'confirmed',
          'bg-amber-50 text-amber-800': status === 'conflict',
          'bg-red-50 text-red-700': status === 'unmatched',
          'bg-blue-50 text-blue-800': status === 'account_day_level',
          'bg-gray-100 text-subtle': status === 'ignored',
        }"
        data-testid="detail-status"
      >
        <component
          :is="status === 'unmatched' || status === 'account_day_level' ? TriangleAlert : CircleCheck"
          class="h-4 w-4 shrink-0"
          aria-hidden="true"
        />
        <span class="text-[13px] font-semibold">{{ statusPillMeta(detail.row.matchStatus).label }}</span>
        <span v-if="detail.row.matchStatus === 'account_day_level'" class="text-[11px]">
          账号日汇总，无法精确归属到单条作品
        </span>
      </div>

      <!-- 平台导入记录 -->
      <section class="mb-2.5 rounded-xl border border-hairline bg-white">
        <h4 class="border-b border-hairline px-3 py-1.5 text-xs font-semibold text-subtle">平台导入记录</h4>
        <dl class="px-3 py-1.5 text-[12px]">
          <div v-for="f in [
            ['日期', detail.row.normalized.date ?? detail.row.normalized.publishTime ?? '—'],
            ['平台', detail.row.normalized.platform ?? '—'],
            ['账号', detail.row.normalized.account ?? '—'],
            ['作品标题', detail.row.normalized.title ?? '—'],
            ['作品 ID', detail.row.normalized.platformWorkId ?? '—'],
            ['链接', detail.row.normalized.workUrl ?? '—'],
          ]" :key="f[0]" class="flex justify-between gap-3 py-0.5">
            <dt class="shrink-0 text-subtle">{{ f[0] }}</dt>
            <dd class="min-w-0 truncate text-right" :title="String(f[1])">{{ f[1] }}</dd>
          </div>
          <div v-for="pair in metricPairs" :key="pair[0]" class="flex justify-between gap-3 py-0.5">
            <dt class="shrink-0 text-subtle">{{ pair[0] }}</dt>
            <dd class="font-mono">{{ pair[1] }}</dd>
          </div>
        </dl>
        <button class="w-full cursor-pointer border-t border-hairline px-3 py-1.5 text-left text-[11px] text-brand" @click="showRaw = !showRaw">
          {{ showRaw ? "收起" : "查看" }}原始行数据（raw_data 永久保留）
        </button>
        <pre v-if="showRaw" class="max-h-40 overflow-auto border-t border-hairline bg-[#fafbfc] px-3 py-2 text-[10.5px] leading-relaxed">{{ JSON.stringify(detail.row.rawData, null, 2) }}</pre>
      </section>

      <!-- 已确认归属 -->
      <section v-if="detail.row.matchStatus === 'confirmed' && detail.decision" class="mb-2.5 rounded-xl border border-green-200 bg-green-50/60 px-3 py-2 text-[12px]" data-testid="detail-confirmed">
        <p class="font-semibold text-green-800">已确认归属</p>
        <p class="mt-0.5 text-green-900">
          {{ detail.decision.matchedVideoId ?? "（账号日级数据）" }}
          <span class="text-green-700">· {{ detail.decision.decisionType === "operator_confirm" ? "批量确认" : detail.decision.decisionType === "operator_assign" ? "人工指定" : "存为账号级" }}</span>
        </p>
        <Button v-if="actions?.reset" size="sm" variant="outline" class="mt-2" data-testid="detail-reset" :disabled="busy" @click="emit('reset', detail.row.id)">
          撤销裁决，回到系统建议
        </Button>
      </section>

      <!-- 候选视频列表（CONFLICT/UNIQUE 展示） -->
      <section v-if="detail.candidates.length > 0" class="mb-2.5">
        <h4 class="mb-1.5 text-xs font-semibold text-subtle">系统候选视频（{{ detail.candidates.length }}）</h4>
        <div
          v-for="c in detail.candidates"
          :key="c.videoId"
          class="mb-2 rounded-xl border bg-white p-2.5"
          :class="c.rank === 1 ? 'border-brand/50' : 'border-hairline'"
          :data-testid="`candidate-${c.videoId}`"
        >
          <div class="flex gap-2.5">
            <img
              v-if="c.video?.coverUrl"
              :src="c.video.coverUrl"
              alt=""
              class="h-[64px] w-[114px] shrink-0 rounded-lg border border-hairline object-cover"
              @error="($event.target as HTMLImageElement).style.visibility = 'hidden'"
            />
            <span v-else class="flex h-[64px] w-[114px] shrink-0 items-center justify-center rounded-lg border border-dashed border-hairline text-[10px] text-subtle">无封面</span>
            <div class="min-w-0 flex-1 text-[12px]">
              <p class="truncate font-medium" :title="c.video?.videoTitle ?? ''">{{ c.video?.videoTitle ?? "（记录已删除）" }}</p>
              <p class="truncate font-mono text-[10.5px] text-subtle">{{ c.videoId }}</p>
              <p class="text-[11px] text-subtle">{{ fmtTime(c.video?.publishTime ?? null) }} · {{ formatDuration(c.video?.durationSec ?? null) }}</p>
              <span class="mt-0.5 inline-block rounded bg-brand-soft px-1.5 py-0.5 text-[10px] font-medium text-brand">
                {{ c.matchMethod }} · {{ (c.matchScore * 100).toFixed(0) }}%
              </span>
            </div>
          </div>
          <!-- 匹配证据 checklist（为什么成立，逐条可解释） -->
          <ul class="mt-2 space-y-0.5 border-t border-hairline pt-1.5 text-[11.5px]">
            <li v-for="item in evidenceChecklist(c.evidence)" :key="item.text" class="flex items-center gap-1.5">
              <component :is="item.ok ? CircleCheck : CircleX" class="h-3.5 w-3.5 shrink-0" :class="item.ok ? 'text-green-600' : 'text-red-500'" aria-hidden="true" />
              <span :class="item.ok ? '' : 'text-red-600'">{{ item.text }}</span>
            </li>
          </ul>
          <Button
            v-if="(status === 'conflict' || status === 'unmatched') && actions?.assign"
            size="sm"
            :variant="c.rank === 1 ? 'default' : 'outline'"
            class="mt-2 w-full"
            :disabled="busy"
            :data-testid="`assign-${c.videoId}`"
            @click="emit('assign', detail.row.id, c.videoId)"
          >
            选择此视频
          </Button>
        </div>
      </section>

      <!-- UNMATCHED：搜索系统视频手动绑定 -->
      <section v-if="status === 'unmatched'" class="mb-2.5 rounded-xl border border-hairline bg-white p-2.5" data-testid="detail-search">
        <h4 class="mb-1.5 text-xs font-semibold text-subtle">搜索系统视频并绑定</h4>
        <div class="flex gap-1.5">
          <input
            v-model="searchKeyword"
            placeholder="标题 / 作品 ID 关键词"
            class="min-w-0 flex-1 rounded-lg border border-hairline px-2.5 py-1.5 text-xs focus:border-brand focus:outline-none"
            data-testid="video-search-input"
            @keyup.enter="onSearch"
          />
          <Button size="sm" :disabled="searching" @click="onSearch">
            <LoaderCircle v-if="searching" class="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            <Search v-else class="h-3.5 w-3.5" aria-hidden="true" /> 搜索
          </Button>
        </div>
        <p v-if="searchError !== ''" class="mt-1.5 text-[11px] text-red-600">{{ searchError }}</p>
        <ul class="mt-1.5 max-h-44 space-y-1 overflow-auto">
          <li v-for="v in searchResults" :key="v.id" class="flex items-center gap-2 rounded-lg border border-hairline px-2 py-1.5 text-[11.5px]">
            <img v-if="v.coverUrl" :src="v.coverUrl" alt="" class="h-7 w-10 shrink-0 rounded object-cover" />
            <span class="min-w-0 flex-1">
              <span class="block truncate">{{ v.publishTitle || v.contentTitle }}</span>
              <span class="block truncate font-mono text-[10px] text-subtle">{{ v.id }} · {{ v.platform }}</span>
            </span>
            <Button size="sm" :disabled="busy" :data-testid="`search-assign-${v.id}`" @click="emit('assign', detail.row.id, v.id)">绑定</Button>
          </li>
        </ul>
      </section>

      <!-- 人工裁决动作区（账号日级无 assign/confirm，红线由 rowActions 收口） -->
      <section v-if="actions && status !== 'confirmed' && status !== 'ignored'" class="flex flex-wrap gap-1.5" data-testid="detail-actions">
        <Button v-if="actions.confirm" size="sm" :disabled="busy" data-testid="act-confirm" @click="emit('confirm', detail.row.id)">确认唯一匹配</Button>
        <Button v-if="actions.accountDay" size="sm" variant="outline" :disabled="busy" data-testid="act-account-day" @click="emit('accountDay', detail.row.id)">保存为账号级数据</Button>
        <Button v-if="actions.external" size="sm" variant="outline" :disabled="busy" data-testid="act-external" @click="emit('external', detail.row.id)">标记为外部视频</Button>
        <Button v-if="actions.ignore" size="sm" variant="outline" :disabled="busy" data-testid="act-ignore" @click="emit('ignore', detail.row.id)">忽略本行</Button>
      </section>

      <p v-if="status === 'ignored'" class="text-center text-xs text-subtle" data-testid="detail-ignored">
        本行已忽略，提交时不会写入任何统计表
      </p>
    </template>
  </aside>
</template>
