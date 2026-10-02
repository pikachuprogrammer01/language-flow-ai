export type AnalyticsCustomField = {
  key: string;
  label: string;
  type: "text" | "image";
  value: string;
};

export type AnalyticsMeta = {
  storyTopic: string;
  cover: string;
  voice: string;
  bgm: string;
  publishAt: string;
  allowSave: boolean;
  customFields: AnalyticsCustomField[];
};

export type ServerAnalyticsMeta = {
  storyTopic: string | null;
  coverUrl: string | null;
  voice: string | null;
  bgm: string | null;
  publishAt: string | null;
  allowSave: boolean;
  customParams: AnalyticsCustomField[];
};

export function reconcileSelectedId(ids: readonly string[], selectedId: string): string {
  if (ids.includes(selectedId)) return selectedId;
  return ids[0] ?? "";
}

/** 单条记录的持久化状态机（DS1：消除保存假成功） */
export type SaveState = "idle" | "dirty" | "saving" | "saved" | "failed";

export const SAVE_STATE_LABEL: Record<SaveState, string> = {
  idle: "",
  dirty: "未保存",
  saving: "保存中…",
  saved: "已保存",
  failed: "保存失败，本地草稿已保留",
};

/** 服务端水合是否应覆盖本地值：本地有未保存草稿（dirty/failed）时保留草稿（E6，免离线编辑被覆盖） */
export function shouldApplyServer(saveState: SaveState | undefined): boolean {
  return saveState !== "dirty" && saveState !== "failed";
}

/** 卸载/切页前需立即落盘的待发任务 id（E7：原仅 flush 选中项，其余 timer 丢失） */
export function pendingSaveIds(
  timers: Map<string, ReturnType<typeof setTimeout>>,
  saveStateOf: (id: string) => SaveState | undefined,
): string[] {
  return [...timers.keys()].filter((id) => saveStateOf(id) === "dirty");
}

/** localStorage.setItem 守卫（DS1：quota / 隐私模式抛错不致整个保存链崩溃） */
export function safeWriteStorage(setter: () => void): boolean {
  try {
    setter();
    return true;
  } catch {
    return false;
  }
}

export function scheduleDebouncedSave(
  timers: Map<string, ReturnType<typeof setTimeout>>,
  id: string,
  callback: () => void,
  delayMs = 400,
): void {
  const previous = timers.get(id);
  if (previous) clearTimeout(previous);
  timers.set(id, setTimeout(callback, delayMs));
}

export function updateAnalyticsMeta(
  store: Record<string, AnalyticsMeta>,
  id: string,
  fallback: AnalyticsMeta,
  patch: Partial<AnalyticsMeta>,
): Record<string, AnalyticsMeta> {
  return { ...store, [id]: { ...(store[id] ?? fallback), ...patch } };
}

export function mergeServerAnalyticsMeta(
  local: AnalyticsMeta,
  saved: ServerAnalyticsMeta,
): AnalyticsMeta {
  return {
    ...local,
    /** 服务端只回传显式覆盖值；null = 跟随生成标题（见 publishTitleOf），固化为 "" 而非本地值 */
    storyTopic: saved.storyTopic ?? "",
    cover: saved.coverUrl ?? "",
    voice: saved.voice ?? "",
    bgm: saved.bgm ?? "",
    publishAt: saved.publishAt ?? "",
    allowSave: saved.allowSave,
    customFields: saved.customParams,
  };
}

/**
 * 发布标题口径：用户在发布管理里显式改过的「故事主题」优先，未改过则跟随生成后的标题。
 * 两者皆空时露出内容 ID 而不是「未命名」——空标题是异常，露 ID 才能定位，写兜底文案只会掩盖。
 */
export function publishTitleOf(
  task: { id: string; title: string },
  override: string | null | undefined,
): string {
  return override || task.title || task.id;
}
