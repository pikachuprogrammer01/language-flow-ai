import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AnalyticsMeta,
  SAVE_STATE_LABEL,
  type SaveState,
  mergeServerAnalyticsMeta,
  pendingSaveIds,
  publishTitleOf,
  reconcileSelectedId,
  safeWriteStorage,
  scheduleDebouncedSave,
  shouldApplyServer,
  updateAnalyticsMeta,
} from "./analytics-state";

const base = (topic: string): AnalyticsMeta => ({
  storyTopic: topic,
  cover: "",
  voice: "voice-a",
  bgm: "",
  publishAt: "2026-09-19T10:00",
  allowSave: true,
  customFields: [],
});

describe("analytics state", () => {
  afterEach(() => vi.useRealTimers());

  it("reconciles a removed selection to the first task", () => {
    expect(reconcileSelectedId(["b", "c"], "a")).toBe("b");
    expect(reconcileSelectedId([], "a")).toBe("");
    expect(reconcileSelectedId(["a", "b"], "b")).toBe("b");
  });

  it("keeps custom fields isolated by content id", () => {
    const first = updateAnalyticsMeta({}, "a", base("A"), {
      customFields: [{ key: "a", label: "A", type: "text", value: "one" }],
    });
    const second = updateAnalyticsMeta(first, "b", base("B"), {
      customFields: [{ key: "b", label: "B", type: "text", value: "two" }],
    });
    expect(second.a.customFields[0].value).toBe("one");
    expect(second.b.customFields[0].value).toBe("two");
  });

  it("uses server data as the authoritative saved state", () => {
    const merged = mergeServerAnalyticsMeta(
      {
        ...base("local"),
        customFields: [{ key: "old", label: "Old", type: "text", value: "old" }],
      },
      {
        storyTopic: "server",
        coverUrl: "cover.png",
        voice: "voice-b",
        bgm: "/files/bgm/new.mp3",
        publishAt: "2026-09-19T11:00:00.000Z",
        allowSave: false,
        customParams: [{ key: "new", label: "New", type: "image", value: "image.png" }],
      },
    );
    expect(merged).toMatchObject({
      storyTopic: "server",
      voice: "voice-b",
      bgm: "/files/bgm/new.mp3",
      allowSave: false,
    });
    expect(merged.customFields[0].key).toBe("new");
  });

  it("keeps a null server topic as 「无覆盖」instead of a frozen value", () => {
    const merged = mergeServerAnalyticsMeta(base("不该被固化"), {
      storyTopic: null,
      coverUrl: null,
      voice: null,
      bgm: null,
      publishAt: null,
      allowSave: false,
      customParams: [],
    });
    expect(merged.storyTopic).toBe("");
  });

  it("follows the generated title unless the user overrode it", () => {
    const task = { id: "cnt_20261002_469bc3", title: "线上学习的新支持" };
    expect(publishTitleOf(task, "")).toBe("线上学习的新支持");
    expect(publishTitleOf(task, null)).toBe("线上学习的新支持");
    expect(publishTitleOf(task, "选修课翻车")).toBe("选修课翻车");
  });

  it("surfaces the content id rather than 「未命名」 when a title is genuinely missing", () => {
    expect(publishTitleOf({ id: "cnt_x", title: "" }, "")).toBe("cnt_x");
  });

  it("only invokes the final value for each video after debounce", () => {
    vi.useFakeTimers();
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const calls: string[] = [];
    let value = "first";
    scheduleDebouncedSave(timers, "a", () => calls.push(value));
    value = "final";
    scheduleDebouncedSave(timers, "a", () => calls.push(value));
    scheduleDebouncedSave(timers, "b", () => calls.push("other"));
    vi.advanceTimersByTime(400);
    expect(calls).toEqual(["final", "other"]);
  });

  it("does not overwrite an unsaved local draft with server hydration (E6)", () => {
    expect(shouldApplyServer("dirty")).toBe(false);
    expect(shouldApplyServer("failed")).toBe(false);
    expect(shouldApplyServer("idle")).toBe(true);
    expect(shouldApplyServer("saving")).toBe(true);
    expect(shouldApplyServer(undefined)).toBe(true);
  });

  it("collects only dirty pending ids for unmount flush (E7)", () => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>([
      ["a", 1 as unknown as ReturnType<typeof setTimeout>],
      ["b", 2 as unknown as ReturnType<typeof setTimeout>],
      ["c", 3 as unknown as ReturnType<typeof setTimeout>],
    ]);
    const states: Record<string, SaveState> = { a: "dirty", b: "saved", c: "failed" };
    // dirty 需 flush；failed 无待发 timer（已失败）；saved 无需
    expect(pendingSaveIds(timers, (id) => states[id]).sort()).toEqual(["a"]);
  });

  it("survives a throwing storage setter (quota / privacy mode)", () => {
    let wrote = false;
    expect(
      safeWriteStorage(() => {
        wrote = true;
      }),
    ).toBe(true);
    expect(wrote).toBe(true);
    expect(
      safeWriteStorage(() => {
        throw new Error("quota");
      }),
    ).toBe(false);
  });

  it("labels the failed state so the local draft is communicated as recoverable", () => {
    expect(SAVE_STATE_LABEL.failed).toContain("本地草稿");
    expect(SAVE_STATE_LABEL.saving).toBe("保存中…");
    expect(SAVE_STATE_LABEL.saved).toBe("已保存");
  });
});
