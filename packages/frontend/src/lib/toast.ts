/**
 * 全局轻提示服务（唯一入口）— reka-ui Toast 底座 + lucide 图标
 * 调用侧：toast.success / error / warning / info（兼容原 vue-sonner 用法），
 * 渲染宿主为 App.vue 挂载一次的 <AppToaster>；本模块只持有状态，不含任何 DOM 副作用。
 */
import { ref } from "vue";

export type ToastVariant = "success" | "error" | "warning" | "info";

export interface ToastItem {
  id: number;
  title: string;
  description?: string;
  variant: ToastVariant;
  open: boolean;
  /** 同 key 去重合并（审查批次 4B：重复失败不再叠加多条同款 Toast） */
  key?: string;
}

export interface ToastOptions {
  description?: string;
  /** 自动关闭毫秒数（默认 success/info 4s、warning 6s、error 8s） */
  duration?: number;
  /** 同 key 的 Toast 只保留最新一条（重置文案与计时，不叠加） */
  key?: string;
}

/** 退场动画时长：open=false 后延迟移除（与 AppToaster 的 CSS 动画对齐） */
const EXIT_MS = 300;
const DEFAULT_DURATION: Record<ToastVariant, number> = {
  success: 4000,
  error: 8000,
  warning: 6000,
  info: 4000,
};

const toasts = ref<ToastItem[]>([]);
let seq = 0;
/** 每条 Toast 的自动关闭定时器（同 key 合并时重置换弹） */
const timers = new Map<number, number>();

function remove(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
  const timer = timers.get(id);
  if (timer !== undefined) window.clearTimeout(timer);
  timers.delete(id);
}

/** open=false 进入退场动画，动画后从列表移除 */
function close(id: number): void {
  const item = toasts.value.find((t) => t.id === id);
  if (!item || !item.open) return;
  item.open = false;
  window.setTimeout(() => remove(id), EXIT_MS);
}

function scheduleClose(id: number, duration: number): void {
  const prev = timers.get(id);
  if (prev !== undefined) window.clearTimeout(prev);
  timers.set(
    id,
    window.setTimeout(() => close(id), duration),
  );
}

function push(variant: ToastVariant, message: string, opts?: ToastOptions): number {
  const duration = opts?.duration ?? DEFAULT_DURATION[variant];
  if (opts?.key !== undefined) {
    const existing = toasts.value.find((t) => t.key === opts.key && t.open);
    if (existing) {
      // 同 key 就地替换：保留 id 与位置，刷新文案/颜色/计时
      existing.title = message;
      existing.description = opts.description;
      existing.variant = variant;
      scheduleClose(existing.id, duration);
      return existing.id;
    }
  }
  const id = ++seq;
  toasts.value = [
    ...toasts.value,
    { id, title: message, description: opts?.description, variant, open: true, key: opts?.key },
  ];
  scheduleClose(id, duration);
  return id;
}

export const toast = {
  success: (message: string, opts?: ToastOptions): number => push("success", message, opts),
  error: (message: string, opts?: ToastOptions): number => push("error", message, opts),
  warning: (message: string, opts?: ToastOptions): number => push("warning", message, opts),
  info: (message: string, opts?: ToastOptions): number => push("info", message, opts),
  /** 手动关闭（如动作完成后撤掉进行中的常驻提示） */
  dismiss: (id: number): void => close(id),
};

/** AppToaster 专用：共享状态 + 关闭回调 */
export function useToasts(): {
  toasts: typeof toasts;
  dismiss: (id: number) => void;
} {
  return { toasts, dismiss: close };
}
