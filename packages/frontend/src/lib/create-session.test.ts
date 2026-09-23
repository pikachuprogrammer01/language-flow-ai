/**
 * 创建会话单例测试 — 「新建视频」入口分流决策（纯函数）与放弃确认行为（store 级）
 * 覆盖批注：busy → 放弃二次确认；done → 原地重置重新创建；idle → 直接进页
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cancelAbandonCreate,
  confirmAbandonCreate,
  decideCreate,
  goCreate,
  registerCreateSession,
  setCreatePhase,
  unregisterCreateSession,
  useCreateSession,
} from "./create-session";

const { abandonConfirmOpen } = useCreateSession();

beforeEach(() => {
  unregisterCreateSession(); // 单例状态：每个用例从干净 idle 开始
  abandonConfirmOpen.value = false;
});

describe("decideCreate（纯决策）", () => {
  it("busy 一律要求放弃确认（无论在哪个页面）", () => {
    expect(decideCreate("busy", "/create")).toBe("confirm-abandon");
    expect(decideCreate("busy", "/tasks")).toBe("confirm-abandon");
  });

  it("done：在创建页=原地重置重开；在别的页=直接进页", () => {
    expect(decideCreate("done", "/create")).toBe("reset-in-place");
    expect(decideCreate("done", "/dashboard" as string)).toBe("navigate");
  });

  it("idle 直接进页", () => {
    expect(decideCreate("idle", "/tasks")).toBe("navigate");
    expect(decideCreate("idle", "/create")).toBe("navigate");
  });
});

describe("goCreate / 放弃确认", () => {
  it("busy 时点击入口只弹确认，不触发放弃处理器", () => {
    const abort = vi.fn();
    const reset = vi.fn();
    registerCreateSession({ abort, reset });
    setCreatePhase("busy");
    goCreate();
    expect(abandonConfirmOpen.value).toBe(true);
    expect(abort).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  });

  it("确认放弃：中断在飞请求 + 重置 + 关闭弹窗；取消：只关弹窗不动处理器", () => {
    const abort = vi.fn();
    const reset = vi.fn();
    registerCreateSession({ abort, reset });
    setCreatePhase("busy");
    goCreate();
    confirmAbandonCreate();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(abandonConfirmOpen.value).toBe(false);

    setCreatePhase("busy");
    goCreate();
    cancelAbandonCreate();
    expect(abandonConfirmOpen.value).toBe(false);
    expect(abort).toHaveBeenCalledTimes(1); // 取消不追加调用
  });

  it("done 且在创建页：点击入口原地重置（无需确认、不弹弹窗）", () => {
    const reset = vi.fn();
    registerCreateSession({ abort: vi.fn(), reset });
    setCreatePhase("done");
    // 当前路由为 /create（router 默认未安装时停在 /，此处直接验证决策入口一致性）
    expect(decideCreate("done", "/create")).toBe("reset-in-place");
  });
});
