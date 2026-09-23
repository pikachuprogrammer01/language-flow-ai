/**
 * LLM 引擎状态机 + 事件发布（SSE 推送的单一事实源，替代前端定时轮询）
 * - phase 过渡态：idle / starting / stopping（带 progress 文案），失败原因放 error 即时广播；
 * - 有订阅者时服务端低频对账探测（30s，仅变化才推）；无订阅者不跑任何定时器；
 * - wake/sleep 复用 llm.service 的原子操作，异步链路编排（启动等待/加载看门狗）收敛在本模块。
 */
import { logger } from "../lib/logger";
import { type LlmStatus, probeLlm, sleepLlm, wakeLlm } from "./llm.service";

export type EnginePhase = "idle" | "starting" | "stopping";

export interface EngineSnapshot {
  phase: EnginePhase;
  /** 过渡态的人话进度（如「正在把模型加载进内存…」），idle 时省略 */
  progress?: string;
  status: LlmStatus;
  /** 最近一次操作失败原因（保留到下一次操作启动时清除） */
  error?: string;
  /** 非致命降级提示（如容器内只卸载了模型、停不了宿主服务）；随事件一次性，不残留进后续快照 */
  notice?: string;
}

/** 对账探测间隔：仅在 ≥1 个 SSE 订阅者时运行；变化检测只推差异 */
const RECONCILE_INTERVAL_MS = 30_000;
/** 模型冷加载看门狗：4s 间隔、5 分钟超时（7B 本机加载分钟级） */
const LOAD_WATCH_INTERVAL_MS = 4_000;
const LOAD_WATCH_TIMEOUT_MS = 300_000;

const UNKNOWN_STATUS: LlmStatus = {
  connected: false,
  model: process.env.LLM_MODEL ?? "",
  reason: "首次探测中",
};

let snapshot: EngineSnapshot = { phase: "idle", status: UNKNOWN_STATUS };
const listeners = new Set<(s: EngineSnapshot) => void>();
let reconcileTimer: ReturnType<typeof setInterval> | undefined;
let loadWatchTimer: ReturnType<typeof setInterval> | undefined;

/** 状态五字段浅比较（LlmStatus 为扁平结构，无需深比较） */
function sameStatus(a: LlmStatus, b: LlmStatus): boolean {
  return (
    a.connected === b.connected &&
    a.model === b.model &&
    a.installed === b.installed &&
    a.loaded === b.loaded &&
    a.reason === b.reason
  );
}

function emit(patch: Partial<EngineSnapshot>): void {
  // notice 为一次性提示：未在补丁中显式给出则随本次广播后消失
  snapshot = { ...snapshot, notice: undefined, ...patch };
  const frozen = getLlmEngineSnapshot();
  for (const l of listeners) {
    try {
      l(frozen);
    } catch (err) {
      logger.warn({ err }, "LLM 事件订阅者回调异常（不影响其他订阅者）");
    }
  }
}

/** 快照深拷贝语义导出（listeners 拿到的副本不会被后续 mutation 污染） */
export function getLlmEngineSnapshot(): EngineSnapshot {
  return {
    phase: snapshot.phase,
    progress: snapshot.progress,
    status: { ...snapshot.status },
    error: snapshot.error,
    notice: snapshot.notice,
  };
}

/** 探测失败不炸：对账/收尾路径统一容错 */
async function safeProbe(): Promise<LlmStatus> {
  try {
    return await probeLlm();
  } catch (err) {
    return { ...UNKNOWN_STATUS, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** 低频对账：phase 为 idle 时校准真实状态，仅变化才广播；引擎自己恢复就绪则顺带清掉陈旧失败提示 */
async function reconcile(): Promise<void> {
  if (snapshot.phase !== "idle") return;
  const status = await safeProbe();
  if (sameStatus(status, snapshot.status)) return;
  const recovered = status.connected && status.loaded !== false;
  emit(recovered ? { status, error: undefined } : { status });
}

/**
 * 订阅引擎事件（SSE 连接调用）：首个订阅者拉起对账，最后一个退订停表。
 * 返回退订函数——连接断开必须调用，否则服务端白白养着定时器。
 */
export function subscribeLlmEvents(cb: (s: EngineSnapshot) => void): () => void {
  listeners.add(cb);
  if (!reconcileTimer) {
    void reconcile();
    reconcileTimer = setInterval(() => void reconcile(), RECONCILE_INTERVAL_MS);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && reconcileTimer) {
      clearInterval(reconcileTimer);
      reconcileTimer = undefined;
    }
  };
}

/** 一键启动（路由即时返回，后续进展全走 SSE）：两段式——先起引擎服务，再把模型加载进内存 */
export async function wakeEngine(): Promise<LlmStatus> {
  if (snapshot.phase !== "idle") return snapshot.status; // 已在启动/关闭中：幂等回当前状态
  emit({
    phase: "starting",
    progress: "1/2 正在启动 Ollama 服务（本机进程拉起，通常几秒）…",
    error: undefined,
  });
  let status: LlmStatus;
  try {
    status = await wakeLlm(); // 含 brew 拉起 + 最多 10s 等服务 + 触发模型加载（fire-and-forget）
  } catch (err) {
    status = await safeProbe();
    emit({
      phase: "idle",
      status,
      progress: undefined,
      error: `启动流程异常：${err instanceof Error ? err.message : String(err)}`,
    });
    return status;
  }
  if (!status.connected) {
    emit({
      phase: "idle",
      status,
      progress: undefined,
      error: `Ollama 服务启动失败：${status.reason ?? "原因未知"}`,
    });
    return status;
  }
  if (status.loaded === true) {
    emit({ phase: "idle", status, progress: undefined });
    return status;
  }
  emit({
    status,
    progress: `2/2 正在把 ${status.model} 加载进内存（本地大模型冷启动，7B 约 1-3 分钟，磁盘越慢越久）…`,
  });
  watchModelLoaded();
  return status;
}

/** 冷加载看门狗：轮询探测直至 loaded 或 5 分钟超时（超时/成功都回到 idle 并广播） */
function watchModelLoaded(): void {
  if (loadWatchTimer) clearInterval(loadWatchTimer);
  const deadline = Date.now() + LOAD_WATCH_TIMEOUT_MS;
  loadWatchTimer = setInterval(async () => {
    const status = await safeProbe();
    if (status.loaded === true) {
      clearIntervalAndNull();
      emit({ phase: "idle", status, progress: undefined });
      return;
    }
    if (!status.connected) {
      clearIntervalAndNull();
      emit({
        phase: "idle",
        status,
        error: `模型加载途中引擎失联：${status.reason ?? "原因未知"}`,
      });
      return;
    }
    if (Date.now() >= deadline) {
      clearIntervalAndNull();
      emit({
        phase: "idle",
        status,
        progress: undefined,
        error: `模型 ${status.model} 加载超时（${LOAD_WATCH_TIMEOUT_MS / 60_000} 分钟），可重试或检查 Ollama 日志`,
      });
    }
  }, LOAD_WATCH_INTERVAL_MS);
}

function clearIntervalAndNull(): void {
  if (loadWatchTimer) clearInterval(loadWatchTimer);
  loadWatchTimer = undefined;
}

/** 一键关闭（wake 的镜像）：卸载模型 + 停服务，结果全走 SSE；容器内停不掉宿主服务时降级为「已卸载模型」 */
export async function sleepEngine(): Promise<LlmStatus> {
  if (snapshot.phase !== "idle") return snapshot.status;
  emit({ phase: "stopping", progress: "正在卸载模型并停止 Ollama 服务…", error: undefined });
  let status: LlmStatus;
  try {
    status = await sleepLlm();
  } catch (err) {
    status = await safeProbe();
    emit({
      phase: "idle",
      status,
      progress: undefined,
      error: `关闭流程异常：${err instanceof Error ? err.message : String(err)}`,
    });
    return status;
  }
  if (!status.connected) {
    emit({ phase: "idle", status, progress: undefined });
    return status;
  }
  if (status.loaded === true) {
    emit({
      phase: "idle",
      status,
      progress: undefined,
      error: "关闭失败：模型仍在内存中（可能有进行中的生成请求占用）",
    });
    return status;
  }
  // 仍连着但模型不在内存：卸载成功但停服务那步没生效（典型：容器内无 brew，或 Ollama 由桌面端启动）
  // —— 如实呈现黄灯待机 + 降级提示（notice 非失败，前端用警示态 toast 展示）
  emit({
    phase: "idle",
    status,
    progress: undefined,
    notice:
      "模型已卸载；Ollama 服务跑在宿主机（容器无法代停），如需彻底退出请在宿主机菜单栏 Quit Ollama",
  });
  return status;
}

/**
 * 仅供单测：停掉全部定时器、清空订阅者并回到初始快照（跨用例不串状态）。
 * 业务代码禁止调用；运行时无 reset 语义，状态机终身单例。
 */
export function resetLlmEngineForTest(): void {
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = undefined;
  clearIntervalAndNull();
  listeners.clear();
  snapshot = { phase: "idle", status: { ...UNKNOWN_STATUS } };
}
