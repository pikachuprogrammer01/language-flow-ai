/**
 * logger 单测 — 开发/生产两种 transport 分支均可装配（进程启动可观测性底座）
 */
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("logger", () => {
  it("development：pretty 彩色流装配成功，info 可用", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { logger } = await import("./logger");
    expect(typeof logger.info).toBe("function");
    expect(() => logger.info({ probe: true }, "dev transport ok")).not.toThrow();
  });

  it("production：JSON 结构化流装配成功（pino 默认）", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { logger } = await import("./logger");
    expect(() => logger.warn({ probe: true }, "prod transport ok")).not.toThrow();
  });
});
