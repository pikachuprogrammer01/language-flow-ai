/**
 * 创建会话单例状态 — 「新建视频」入口与 CreateTask 之间的跨组件契约
 * phase：idle（无进行中创建）/ busy（生成·配音·渲染进行中）/ done（已成片）
 * 入口统一调 goCreate()：busy → 二次确认是否放弃本次创建（中断请求 + 重置 + 进页）；
 * done → 视为想重新创建（原地重置回表单，无需确认）；idle → 直接进页。
 * CreateTask 负责按 step 同步 phase 并注册 abort/reset 处理器；本模块只做状态与决策，不持 DOM。
 */
import { ref } from "vue";
import router from "../router";

export type CreatePhase = "idle" | "busy" | "done";

const phase = ref<CreatePhase>("idle");
/** 放弃二次确认弹窗可见性（goCreate 置位，App.vue 单实例渲染处理） */
const abandonConfirmOpen = ref(false);

let abortor: (() => void) | null = null;
let resetor: (() => void) | null = null;

export function setCreatePhase(next: CreatePhase): void {
  phase.value = next;
}

/** CreateTask 挂载时注册中断/重置能力；卸载必须注销（防悬挂闭包） */
export function registerCreateSession(handlers: { abort: () => void; reset: () => void }): void {
  abortor = handlers.abort;
  resetor = handlers.reset;
}

export function unregisterCreateSession(): void {
  abortor = null;
  resetor = null;
  phase.value = "idle";
}

export type CreateIntent = "navigate" | "reset-in-place" | "confirm-abandon";

/** 点击意图决策（纯函数，单测覆盖）：创建阶段 × 当前路径 → 动作 */
export function decideCreate(p: CreatePhase, currentPath: string): CreateIntent {
  if (p === "busy") return "confirm-abandon";
  if (p === "done" && currentPath === "/create") return "reset-in-place";
  return "navigate";
}

/** 「新建视频」统一入口（顶栏 / 侧边栏 / 工作台 / 生成记录四处共用） */
export function goCreate(): void {
  const currentPath = router.currentRoute.value.path;
  const intent = decideCreate(phase.value, currentPath);
  if (intent === "confirm-abandon") {
    abandonConfirmOpen.value = true;
    return;
  }
  if (intent === "reset-in-place") {
    resetor?.();
    return;
  }
  if (currentPath !== "/create") void router.push("/create");
}

/** 用户确认放弃：中断在飞请求 + 重置本页 + 确保停在创建页 */
export function confirmAbandonCreate(): void {
  abandonConfirmOpen.value = false;
  abortor?.();
  resetor?.();
  if (router.currentRoute.value.path !== "/create") void router.push("/create");
}

export function cancelAbandonCreate(): void {
  abandonConfirmOpen.value = false;
}

/** App.vue 消费：放弃确认弹窗绑定 */
export function useCreateSession(): {
  phase: typeof phase;
  abandonConfirmOpen: typeof abandonConfirmOpen;
} {
  return { phase, abandonConfirmOpen };
}
