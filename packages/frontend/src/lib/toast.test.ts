/**
 * 全局 toast 存储单测 — 入队/自动关闭/退场移除/手动 dismiss（reka-ui 宿主的纯状态侧）
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast, useToasts } from "./toast";

const { toasts, dismiss } = useToasts();

beforeEach(() => {
  vi.useFakeTimers();
  toasts.value = [];
});
afterEach(() => {
  vi.useRealTimers();
  toasts.value = [];
});

describe("toast", () => {
  it("success 入队即 open，默认 4s 后进入退场、动画窗口后移除", () => {
    toast.success("完成");
    expect(toasts.value).toHaveLength(1);
    expect(toasts.value[0]?.open).toBe(true);
    vi.advanceTimersByTime(4000);
    expect(toasts.value[0]?.open).toBe(false);
    vi.advanceTimersByTime(350);
    expect(toasts.value).toHaveLength(0);
  });

  it("error 默认 8s；显式 duration 覆盖", () => {
    toast.error("坏了", { description: "详情", duration: 1000 });
    expect(toasts.value[0]?.description).toBe("详情");
    vi.advanceTimersByTime(1000);
    expect(toasts.value[0]?.open).toBe(false);
  });

  it("dismiss：立即进入退场且幂等（二次调用不重复排程）", () => {
    const id = toast.info("提示");
    dismiss(id);
    dismiss(id);
    vi.advanceTimersByTime(350);
    expect(toasts.value).toHaveLength(0);
  });

  it("多条并存独立计时、各自移除", () => {
    toast.success("a", { duration: 1000 });
    toast.warning("b", { duration: 2000 });
    vi.advanceTimersByTime(1000);
    expect(toasts.value.map((t) => t.title)).toEqual(["a", "b"]);
    expect(toasts.value[0]?.open).toBe(false);
    vi.advanceTimersByTime(1350);
    expect(toasts.value).toHaveLength(0);
  });

  it("同 key 去重合并（批次 4B）：只保留最新一条并重置计时，不同 key/无 key 照常叠加", () => {
    const first = toast.error("查询失败：旧错误", { key: "k1", duration: 1000 });
    const again = toast.error("查询失败：新错误", { key: "k1", duration: 1000 });
    expect(toasts.value).toHaveLength(1);
    expect(again).toBe(first);
    expect(toasts.value[0]?.title).toBe("查询失败：新错误");
    // 合并后计时重置：退场点在第二次 push 起算 +1000ms（已前进 800ms，再推 200ms 到点）
    vi.advanceTimersByTime(800);
    expect(toasts.value[0]?.open).toBe(true);
    vi.advanceTimersByTime(200);
    expect(toasts.value[0]?.open).toBe(false);
    // 退场动画完成后彻底移除，之后已退场的同 key 不再参与合并
    vi.advanceTimersByTime(350);
    expect(toasts.value).toHaveLength(0);
    toast.error("第三次", { key: "k1", duration: 1000 });
    expect(toasts.value).toHaveLength(1);
    // 无 key / 异 key 叠加
    toast.success("x");
    toast.success("y", { key: "k2" });
    expect(toasts.value).toHaveLength(3);
  });
});
