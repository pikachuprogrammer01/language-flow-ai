<script setup lang="ts">
import { Plus, Trash2 } from "lucide-vue-next";
/**
 * STEP 2 匹配规则：定义「凭什么认为一条平台记录属于某个系统视频」
 * 优先级固定（作品ID > URL解析ID > 账号+发布时间 > 账号+日期+标题 > +时长辅助），
 * 可配置的只有依据参数：账号映射/平台映射/时区/发布时间容差/标题标准化/相似度阈值。
 * 保存规则 → dry-run 预估；主操作「开始预匹配」点击后才真正执行（不偷跑）。
 */
import { computed, reactive, ref, watch } from "vue";
import type { ImportBatchView, ImportEstimate, ImportRulesPayload } from "../../api/client";
import Button from "../ui/button.vue";
import Spinner from "../ui/spinner.vue";

const props = defineProps<{
  view: ImportBatchView;
  saving: boolean;
  prematchState: "idle" | "matching" | "matched" | "match_failed";
  estimate: ImportEstimate | null;
}>();

const emit = defineEmits<{
  save: [rules: ImportRulesPayload];
  prematch: [];
  back: [];
}>();

interface MappingRow {
  from: string;
  to: string;
}

const accountRows = ref<MappingRow[]>([]);
const platformRows = ref<MappingRow[]>([]);

const form = reactive({
  timezoneOffsetMinutes: 480,
  publishTimeToleranceMinutes: 5,
  titleSimilarityThreshold: 0.9,
  stripEmoji: true,
  stripHashtag: true,
  collapseWhitespace: true,
  toLowercase: true,
  fullToHalfWidth: true,
});

// 批次规则回填（刷新/点回后不丢配置）
watch(
  () => props.view.matchRules,
  (rules) => {
    if (rules === null) return;
    accountRows.value = Object.entries(rules.accountMapping).map(([from, to]) => ({ from, to }));
    platformRows.value = Object.entries(rules.platformMapping).map(([from, to]) => ({ from, to }));
    form.timezoneOffsetMinutes = rules.timezoneOffsetMinutes;
    form.publishTimeToleranceMinutes = rules.publishTimeToleranceMinutes;
    form.titleSimilarityThreshold = rules.titleSimilarityThreshold;
    form.stripEmoji = rules.titleNormalization.stripEmoji;
    form.stripHashtag = rules.titleNormalization.stripHashtag;
    form.collapseWhitespace = rules.titleNormalization.collapseWhitespace;
    form.toLowercase = rules.titleNormalization.toLowercase;
    form.fullToHalfWidth = rules.titleNormalization.fullToHalfWidth;
  },
  { immediate: true },
);

const dirty = ref(false);

watch(
  [accountRows, platformRows, () => ({ ...form })],
  () => {
    dirty.value = true;
  },
  { deep: true },
);

function toPayload(): ImportRulesPayload {
  return {
    accountMapping: Object.fromEntries(
      accountRows.value.filter((r) => r.from !== "").map((r) => [r.from, r.to]),
    ),
    platformMapping: Object.fromEntries(
      platformRows.value.filter((r) => r.from !== "").map((r) => [r.from, r.to]),
    ),
    timezoneOffsetMinutes: form.timezoneOffsetMinutes,
    publishTimeToleranceMinutes: form.publishTimeToleranceMinutes,
    titleNormalization: {
      stripEmoji: form.stripEmoji,
      stripHashtag: form.stripHashtag,
      collapseWhitespace: form.collapseWhitespace,
      toLowercase: form.toLowercase,
      fullToHalfWidth: form.fullToHalfWidth,
    },
    titleSimilarityThreshold: form.titleSimilarityThreshold,
  };
}

const isAccountDay = computed(() => props.view.dataGranularity === "account_day_level");

const matchMethods = [
  { rank: 1, name: "platform_work_id 完全一致", tone: "强证据" },
  { rank: 2, name: "work_url 解析出的 platform_work_id 一致", tone: "强证据" },
  { rank: 3, name: "标题完全一致 + 发布时间容差内吻合（双证据交叉验证）", tone: "可自动入库" },
  { rank: 4, name: "账号 + 发布时间（容差内）", tone: "弱证据·需确认" },
  { rank: 5, name: "账号 + 日期 + 标准化标题（≥阈值）", tone: "弱证据·需确认" },
  { rank: 6, name: "账号 + 日期 + 标题 + 时长辅助", tone: "弱证据·需确认" },
];
</script>

<template>
  <div class="rounded-2xl border border-hairline bg-panel p-4">
    <h2 class="mb-1 text-[15px] font-bold">② 匹配规则</h2>
    <p class="mb-3 text-xs text-subtle">
      让系统明确「凭什么认为一条平台记录属于某个系统视频」。匹配优先级固定：强证据压制弱证据，绝不反过来；全程确定性程序规则，不使用大模型猜测归属。
    </p>

    <!-- 账号日级批次提示：作品级规则不适用 -->
    <p
      v-if="isAccountDay"
      class="mb-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800"
      data-testid="rules-account-day-note"
    >
      本批为账号日汇总：作品级匹配参数不适用，只需确认平台归属；下一步将全部行标记为「账号日级」，仅支持保存为账号日级数据。
    </p>

    <div class="grid grid-cols-2 gap-4">
      <!-- 左：映射与参数 -->
      <div class="space-y-4">
        <section>
          <h3 class="mb-1.5 text-[13px] font-semibold">匹配优先级（固定，不可调换）</h3>
          <ol class="space-y-1">
            <li
              v-for="m in matchMethods"
              :key="m.rank"
              class="flex items-center gap-2 rounded-lg border border-hairline bg-white px-2.5 py-1.5 text-xs"
            >
              <span class="flex h-4.5 w-4.5 items-center justify-center rounded-full bg-brand-soft text-[10px] font-bold text-brand">{{ m.rank }}</span>
              <span class="font-mono">{{ m.name }}</span>
              <span
                class="ml-auto rounded px-1.5 py-0.5 text-[10px]"
                :class="
                  m.tone === '强证据'
                    ? 'bg-green-50 text-green-700'
                    : m.tone === '可自动入库'
                      ? 'bg-brand-soft text-brand'
                      : 'bg-amber-50 text-amber-700'
                "
              >{{ m.tone }}</span>
            </li>
          </ol>
        </section>

        <section>
          <div class="mb-1.5 flex items-center justify-between">
            <h3 class="text-[13px] font-semibold">账号映射（平台账号名 → 系统账号标识）</h3>
            <Button size="sm" variant="outline" data-testid="rules-add-account" @click="accountRows.push({ from: '', to: '' })">
              <Plus class="h-3.5 w-3.5" aria-hidden="true" /> 添加
            </Button>
          </div>
          <div v-if="accountRows.length === 0" class="rounded-lg border border-dashed border-hairline bg-white px-3 py-2 text-xs text-subtle">
            暂无映射；未映射账号的行会在 Preflight ⑤ 提示
          </div>
          <div v-for="(row, i) in accountRows" :key="`a${i}`" class="mb-1.5 flex items-center gap-2">
            <input v-model="row.from" placeholder="导出文件中的账号名" class="w-1/2 rounded-lg border border-hairline bg-white px-2.5 py-1.5 text-xs focus:border-brand focus:outline-none" />
            <span class="text-subtle">→</span>
            <input v-model="row.to" placeholder="系统账号标识" class="w-1/2 rounded-lg border border-hairline bg-white px-2.5 py-1.5 text-xs focus:border-brand focus:outline-none" />
            <button class="cursor-pointer text-subtle hover:text-red-600" aria-label="删除映射" @click="accountRows.splice(i, 1)">
              <Trash2 class="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        </section>

        <section>
          <div class="mb-1.5 flex items-center justify-between">
            <h3 class="text-[13px] font-semibold">平台映射（导出平台名 → 系统平台）</h3>
            <Button size="sm" variant="outline" @click="platformRows.push({ from: '', to: '' })">
              <Plus class="h-3.5 w-3.5" aria-hidden="true" /> 添加
            </Button>
          </div>
          <div v-for="(row, i) in platformRows" :key="`p${i}`" class="mb-1.5 flex items-center gap-2">
            <input v-model="row.from" placeholder="如 douyin" class="w-1/2 rounded-lg border border-hairline bg-white px-2.5 py-1.5 text-xs focus:border-brand focus:outline-none" />
            <span class="text-subtle">→</span>
            <input v-model="row.to" placeholder="如 抖音" class="w-1/2 rounded-lg border border-hairline bg-white px-2.5 py-1.5 text-xs focus:border-brand focus:outline-none" />
            <button class="cursor-pointer text-subtle hover:text-red-600" aria-label="删除映射" @click="platformRows.splice(i, 1)">
              <Trash2 class="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        </section>

        <section class="grid grid-cols-2 gap-3">
          <label class="text-xs">
            <span class="mb-1 block text-subtle">时区（分钟偏移，UTC+8 = 480）</span>
            <input v-model.number="form.timezoneOffsetMinutes" type="number" class="w-full rounded-lg border border-hairline bg-white px-2.5 py-1.5 text-xs focus:border-brand focus:outline-none" />
          </label>
          <label class="text-xs">
            <span class="mb-1 block text-subtle">发布时间容差（±分钟）</span>
            <input v-model.number="form.publishTimeToleranceMinutes" type="number" min="0" max="1440" class="w-full rounded-lg border border-hairline bg-white px-2.5 py-1.5 text-xs focus:border-brand focus:outline-none" data-testid="rules-tolerance" />
          </label>
        </section>

        <section>
          <h3 class="mb-1.5 text-[13px] font-semibold">标题标准化与相似度阈值</h3>
          <div class="mb-2 flex flex-wrap gap-3 text-xs">
            <label class="flex items-center gap-1.5"><input v-model="form.stripEmoji" type="checkbox" class="accent-[var(--color-brand,#6d5dfc)]" /> 去 emoji</label>
            <label class="flex items-center gap-1.5"><input v-model="form.stripHashtag" type="checkbox" class="accent-[var(--color-brand,#6d5dfc)]" /> 去话题标签</label>
            <label class="flex items-center gap-1.5"><input v-model="form.collapseWhitespace" type="checkbox" class="accent-[var(--color-brand,#6d5dfc)]" /> 空白折叠</label>
            <label class="flex items-center gap-1.5"><input v-model="form.toLowercase" type="checkbox" class="accent-[var(--color-brand,#6d5dfc)]" /> 大小写归一</label>
            <label class="flex items-center gap-1.5"><input v-model="form.fullToHalfWidth" type="checkbox" class="accent-[var(--color-brand,#6d5dfc)]" /> 全角转半角</label>
          </div>
          <div class="flex items-center gap-2 text-xs">
            <span class="text-subtle">相似度阈值</span>
            <input v-model.number="form.titleSimilarityThreshold" type="range" min="0.5" max="1" step="0.01" class="w-40 accent-[var(--color-brand,#6d5dfc)]" data-testid="rules-threshold" />
            <span class="font-mono font-semibold text-brand">{{ (form.titleSimilarityThreshold * 100).toFixed(0) }}%</span>
          </div>
        </section>
      </div>

      <!-- 右：预估 + 主操作 -->
      <div class="space-y-4">
        <section>
          <h3 class="mb-1.5 text-[13px] font-semibold">匹配规则预估（保存后由系统 dry-run 计算）</h3>
          <div class="overflow-hidden rounded-xl border border-hairline bg-white">
            <dl class="divide-y divide-hairline text-[13px]">
              <div class="flex items-center justify-between px-3 py-2.5">
                <dt class="text-subtle">总记录</dt>
                <dd class="font-mono text-[15px] font-bold" data-testid="estimate-total">{{ estimate?.total ?? "—" }}</dd>
              </div>
              <div class="flex items-center justify-between px-3 py-2.5">
                <dt class="text-subtle">预计强匹配（自动唯一对应）</dt>
                <dd class="font-mono text-[15px] font-bold text-green-600" data-testid="estimate-strong">{{ estimate?.expectStrongMatch ?? "—" }}</dd>
              </div>
              <div class="flex items-center justify-between px-3 py-2.5">
                <dt class="text-subtle">预计需要人工确认（冲突）</dt>
                <dd class="font-mono text-[15px] font-bold text-amber-600" data-testid="estimate-manual">{{ estimate?.expectManualConfirm ?? "—" }}</dd>
              </div>
              <div class="flex items-center justify-between px-3 py-2.5">
                <dt class="text-subtle">预计未匹配</dt>
                <dd class="font-mono text-[15px] font-bold text-red-600" data-testid="estimate-unmatched">{{ estimate?.expectUnmatched ?? "—" }}</dd>
              </div>
            </dl>
          </div>
          <p v-if="estimate === null" class="mt-1.5 text-xs text-subtle">先「保存规则」，系统立即给出四类预估（不执行匹配、不落库）。</p>
        </section>

        <div class="flex flex-col gap-2.5">
          <Button variant="outline" :disabled="saving || prematchState === 'matching'" data-testid="rules-save" @click="emit('save', toPayload())">
            <Spinner v-if="saving" size="sm" /> {{ dirty && estimate !== null ? "规则已改动，重新保存并预估" : "保存规则并预估" }}
          </Button>
          <Button :disabled="estimate === null || prematchState === 'matching' || saving" data-testid="rules-prematch" @click="emit('prematch')">
            <Spinner v-if="prematchState === 'matching'" size="sm" />
            {{ prematchState === "matching" ? "正在执行确定性匹配…" : "开始预匹配 →" }}
          </Button>
          <p v-if="prematchState === 'match_failed'" class="text-xs text-red-600" data-testid="prematch-error">
            预匹配失败，请检查规则后重试（错误详情见右上角提示）
          </p>
          <p class="text-[11px] leading-relaxed text-subtle">
            点击「开始预匹配」才会真正执行匹配并进入下一步；保存规则只预估，不动数据。禁止点击下一步后才偷偷执行无法解释的匹配。
          </p>
        </div>
      </div>
    </div>

    <div class="mt-4 flex items-center justify-between border-t border-hairline pt-3">
      <Button variant="outline" size="sm" data-testid="rules-back" @click="emit('back')">← 上一步</Button>
    </div>
  </div>
</template>
