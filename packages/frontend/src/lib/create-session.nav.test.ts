/**
 * 创建会话导航分支单测 — goCreate/confirmAbandonCreate 的路由副作用（mock router 实例）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import router from "../router";
import {
  confirmAbandonCreate,
  goCreate,
  registerCreateSession,
  setCreatePhase,
  unregisterCreateSession,
  useCreateSession,
} from "./create-session";

vi.mock("../router", () => ({
  default: {
    currentRoute: { value: { path: "/" } },
    push: vi.fn(),
  },
}));

const { abandonConfirmOpen } = useCreateSession();
const currentRoute = vi.mocked(router, true).currentRoute as unknown as { value: { path: string } };

function at(path: string): void {
  currentRoute.value = { path };
}

beforeEach(() => {
  unregisterCreateSession();
  abandonConfirmOpen.value = false;
  vi.mocked(router.push).mockClear();
  at("/");
});

describe("goCreate 导航分支", () => {
  it("idle 且在其他页：直接进 /create", () => {
    at("/tasks");
    goCreate();
    expect(router.push).toHaveBeenCalledWith("/create");
  });

  it("idle 且已在 /create：不重复导航", () => {
    at("/create");
    goCreate();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("done 且在 /create：原地 reset 处理器，不导航", () => {
    const reset = vi.fn();
    registerCreateSession({ abort: vi.fn(), reset });
    setCreatePhase("done");
    at("/create");
    goCreate();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(router.push).not.toHaveBeenCalled();
  });

  it("busy：只弹放弃确认；确认后中断+重置，且不在 /create 时导航过去", () => {
    const abort = vi.fn();
    const reset = vi.fn();
    registerCreateSession({ abort, reset });
    setCreatePhase("busy");
    at("/tasks");
    goCreate();
    expect(abandonConfirmOpen.value).toBe(true);
    expect(abort).not.toHaveBeenCalled();
    confirmAbandonCreate();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(abandonConfirmOpen.value).toBe(false);
    expect(router.push).toHaveBeenCalledWith("/create");
  });

  it("确认放弃时已在 /create：不再导航", () => {
    registerCreateSession({ abort: vi.fn(), reset: vi.fn() });
    setCreatePhase("busy");
    at("/create");
    goCreate();
    confirmAbandonCreate();
    expect(router.push).not.toHaveBeenCalled();
  });
});
