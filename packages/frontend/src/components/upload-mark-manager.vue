<script setup lang="ts">
import {
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from "radix-vue";
/**
 * 上传标记管理器（弹窗）— 四个页面复用
 * 表示视频已上传到外部平台；一个视频可多条标记（多个平台）
 * 用法：<UploadMarkManager :filename="t.videoFilename" @change="reload" />
 */
import { computed, onMounted, ref } from "vue";
import { toast } from "vue-sonner";
import {
  type UploadMark,
  addUploadMark,
  deleteUploadMark,
  listUploadMarks,
  updateUploadMark,
} from "../api/client";
import ConfirmDialog from "./ui/confirm-dialog.vue";

const props = defineProps<{
  /** 当前视频文件名（如 xxx.mp4）；为空时禁用添加 */
  filename: string;
  /** 关联任务 id（可选；传了后端直接绑定，未传由后端按文件名自动反查） */
  taskId?: string;
}>();

const emit = defineEmits<{ change: [] }>();

const PLATFORMS = ["抖音", "小红书", "视频号", "B站", "快手", "西瓜视频", "其他"] as const;

/** 备注预设（序号 _ 由用户改为数字；选「自定义」自由输入） */
const NOTE_PRESETS = [
  "情景英语四级词汇-第_集",
  "单词卡片四级词汇-第_集",
  "选择题四级词汇-第_集",
  "情景英语六级词汇-第_集",
  "单词卡片六级词汇-第_集",
  "选择题六级词汇-第_集",
] as const;

/** 选中预设并填充备注输入框（自定义则清空） */
const notePresetSel = ref("__custom__");
const editNotePresetSel = ref("__custom__");

function applyNotePreset(preset: string): void {
  addNote.value = preset === "__custom__" ? "" : preset;
}

function applyEditNotePreset(preset: string): void {
  editNote.value = preset === "__custom__" ? "" : preset;
}

const open = ref(false);
const loading = ref(false);
const marks = ref<UploadMark[]>([]);
/** 添加表单 */
const addPlatform = ref<string>("抖音");
const addCustomPlatform = ref("");
const addUrl = ref("");
const addNote = ref("");
const saving = ref(false);
/** 编辑态：id → 表单值 */
const editingId = ref<string | null>(null);
const editPlatform = ref("");
const editCustomPlatform = ref("");
const editUrl = ref("");
const editNote = ref("");
/** 删除确认 */
const deleteOpen = ref(false);
const pendingDeleteId = ref("");

/** 最终提交的平台名（选「其他」时用自定义输入） */
const resolvePlatform = (selected: string, custom: string): string =>
  selected === "其他" ? custom.trim() || "其他" : selected;

async function load(): Promise<void> {
  loading.value = true;
  try {
    marks.value = await listUploadMarks(props.filename);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  } finally {
    loading.value = false;
  }
}

function onOpenChange(v: boolean): void {
  open.value = v;
  if (v) void load();
}

/** 外部打开（父组件通过 ref 调用） */
defineExpose({ open: () => onOpenChange(true) });

async function save(): Promise<void> {
  const platform = resolvePlatform(addPlatform.value, addCustomPlatform.value);
  if (!platform) {
    toast.error("请填写平台名称");
    return;
  }
  saving.value = true;
  try {
    await addUploadMark({
      videoFilename: props.filename,
      platform,
      url: addUrl.value.trim() || undefined,
      note: addNote.value.trim() || undefined,
      taskId: props.taskId,
    });
    addUrl.value = "";
    addNote.value = "";
    addCustomPlatform.value = "";
    // 成功不弹 toast：弹窗内列表立即出现新标记，父页面「已标记」徽章随 change 刷新
    emit("change");
    await load();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  } finally {
    saving.value = false;
  }
}

function startEdit(m: UploadMark): void {
  editingId.value = m.id;
  const custom = PLATFORMS.includes(m.platform as (typeof PLATFORMS)[number]) ? "" : m.platform;
  editPlatform.value = custom ? "其他" : m.platform;
  editCustomPlatform.value = custom;
  editUrl.value = m.url ?? "";
  editNote.value = m.note ?? "";
}

async function saveEdit(m: UploadMark): Promise<void> {
  const platform = resolvePlatform(editPlatform.value, editCustomPlatform.value);
  if (!platform) {
    toast.error("请填写平台名称");
    return;
  }
  saving.value = true;
  try {
    await updateUploadMark(m.id, {
      platform,
      url: editUrl.value.trim() || null,
      note: editNote.value.trim() || null,
    });
    editingId.value = null;
    // 成功不弹 toast：编辑结果直接显示在弹窗列表中
    emit("change");
    await load();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  } finally {
    saving.value = false;
  }
}

async function confirmDelete(): Promise<void> {
  try {
    await deleteUploadMark(pendingDeleteId.value);
    // 成功不弹 toast：弹窗内列表即时移除该条，页面徽章随 change 刷新
    emit("change");
    await load();
  } catch (err) {
    toast.error(err instanceof Error ? err.message : String(err));
  } finally {
    deleteOpen.value = false;
  }
}

const fmtTime = (iso: string): string => new Date(iso).toLocaleString("zh-CN");

const selectedIsCustom = computed(() => addPlatform.value === "其他");
const editIsCustom = computed(() => editPlatform.value === "其他");
</script>

<template>
  <DialogRoot :open="open" @update:open="onOpenChange">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-40 bg-black/40" />
      <DialogContent
        class="fixed left-1/2 top-1/2 z-50 w-[520px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-xl border bg-white p-5 shadow-lg"
      >
      <DialogTitle class="text-base font-semibold">上传标记</DialogTitle>
      <p class="mt-1 truncate text-xs text-gray-500">{{ filename }}</p>

      <!-- 标记列表 -->
      <div v-if="loading" class="py-6 text-center text-sm text-gray-400">加载中…</div>
      <ul v-else-if="marks.length > 0" class="mt-3 space-y-2">
        <li
          v-for="m in marks"
          :key="m.id"
          class="flex items-start justify-between gap-2 rounded-lg border p-3 text-sm"
        >
          <div v-if="editingId !== m.id" class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="rounded bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700">
                {{ m.platform }}
              </span>
              <a
                v-if="m.url"
                :href="m.url"
                target="_blank"
                rel="noopener noreferrer"
                class="truncate text-blue-600 underline"
              >
                {{ m.url }}
              </a>
            </div>
            <p v-if="m.note" class="mt-1 truncate text-xs text-gray-500">{{ m.note }}</p>
            <p class="mt-1 text-xs text-gray-400">{{ fmtTime(m.createdAt) }}</p>
          </div>
          <div v-else class="min-w-0 flex-1 space-y-1.5">
            <div class="flex gap-1.5">
              <select v-model="editPlatform" class="rounded border px-2 py-1 text-xs">
                <option v-for="p in PLATFORMS" :key="p" :value="p">{{ p }}</option>
              </select>
              <input
                v-if="editIsCustom"
                v-model="editCustomPlatform"
                placeholder="自定义平台名"
                class="w-32 rounded border px-2 py-1 text-xs"
              />
            </div>
            <input v-model="editUrl" placeholder="作品链接（可选）" class="w-full rounded border px-2 py-1 text-xs" />
            <div class="flex gap-1.5">
              <select v-model="editNotePresetSel" class="rounded border px-1.5 py-1 text-xs" @change="applyEditNotePreset(editNotePresetSel)">
                <option value="__custom__">备注预设</option>
                <option v-for="p in NOTE_PRESETS" :key="p" :value="p">{{ p }}</option>
              </select>
              <input v-model="editNote" placeholder="备注（可选）" class="min-w-0 flex-1 rounded border px-2 py-1 text-xs" />
            </div>
          </div>
          <div class="flex shrink-0 gap-1.5">
            <template v-if="editingId !== m.id">
              <button class="rounded border px-2 py-1 text-xs text-gray-600 hover:bg-gray-100" @click="startEdit(m)">
                编辑
              </button>
              <button
                class="rounded border px-2 py-1 text-xs text-red-500 hover:bg-red-50"
                @click="pendingDeleteId = m.id; deleteOpen = true"
              >
                删除
              </button>
            </template>
            <template v-else>
              <button
                class="rounded border px-2 py-1 text-xs text-blue-600 hover:bg-blue-50"
                :disabled="saving"
                @click="saveEdit(m)"
              >
                保存
              </button>
              <button class="rounded border px-2 py-1 text-xs text-gray-600 hover:bg-gray-100" @click="editingId = null">
                取消
              </button>
            </template>
          </div>
        </li>
      </ul>
      <p v-else class="mt-3 rounded-lg border border-dashed py-4 text-center text-sm text-gray-400">
        暂无上传标记
      </p>

      <!-- 添加表单 -->
      <div class="mt-4 border-t pt-3">
        <div class="flex gap-1.5">
          <select v-model="addPlatform" class="rounded border px-2 py-1.5 text-sm">
            <option v-for="p in PLATFORMS" :key="p" :value="p">{{ p }}</option>
          </select>
          <input
            v-if="selectedIsCustom"
            v-model="addCustomPlatform"
            placeholder="自定义平台名"
            class="w-36 rounded border px-2 py-1.5 text-sm"
          />
          <input
            v-model="addUrl"
            placeholder="作品链接（可选）"
            class="min-w-0 flex-1 rounded border px-2 py-1.5 text-sm"
          />
        </div>
        <div class="mt-1.5 flex gap-1.5">
          <select v-model="notePresetSel" class="rounded border px-2 py-1.5 text-sm" @change="applyNotePreset(notePresetSel)">
            <option value="__custom__">备注预设</option>
            <option v-for="p in NOTE_PRESETS" :key="p" :value="p">{{ p }}</option>
          </select>
          <input v-model="addNote" placeholder="备注（可选，序号 _ 改为数字）" class="min-w-0 flex-1 rounded border px-2 py-1.5 text-sm" />
          <button
            class="rounded-lg bg-blue-600 px-4 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
            :disabled="saving"
            @click="save"
          >
            添加
          </button>
        </div>
      </div>

      <div class="mt-4 flex justify-end">
        <DialogClose class="rounded-lg border px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-100">关闭</DialogClose>
      </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>

  <!-- 删除确认 -->
  <ConfirmDialog
    v-model:open="deleteOpen"
    title="删除上传标记"
    description="确定删除这个上传标记吗？仅移除标记，不影响视频文件。"
    confirm-text="删除"
    destructive
    @confirm="confirmDelete"
  />
</template>
