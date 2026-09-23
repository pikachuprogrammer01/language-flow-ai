/**
 * db 连接层护栏单测 — 生产库（回环 :3306）写保护与放行（AGENTS.md 数据库写操作安全限制的执行点）
 * mysql2/drizzle 全 mock：只验证守卫逻辑，不建任何真实连接
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("mysql2/promise", () => ({ default: { createPool: vi.fn(() => ({})) } }));
vi.mock("drizzle-orm/mysql2", () => ({ drizzle: vi.fn(() => ({})) }));

type DbModule = typeof import("./index");

async function loadDb(url: string, allowProd?: string): Promise<DbModule> {
  vi.resetModules();
  vi.stubEnv("DATABASE_URL", url);
  vi.stubEnv("DB_ALLOW_PROD", allowProd ?? "");
  return await import("./index");
}

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("requireSafeWriteTarget", () => {
  it("缺 DATABASE_URL：模块加载即抛（fail fast）", async () => {
    await expect(loadDb("")).rejects.toThrow("DATABASE_URL is not set");
  });

  it("回环 :3306 未放行：写守卫抛错且信息含 DB_ALLOW_PROD 指引", async () => {
    const mod = await loadDb("mysql://dev:dev@localhost:3306/language_flow");
    expect(() => mod.requireSafeWriteTarget("db:migrate")).toThrow(/DB_ALLOW_PROD/);
  });

  it("回环 :3306 显式放行：可执行", async () => {
    const mod = await loadDb("mysql://dev:dev@127.0.0.1:3306/language_flow", "1");
    expect(() => mod.requireSafeWriteTarget("db:seed")).not.toThrow();
  });

  it("测试库 :3307 与容器服务名 mysql：不受限", async () => {
    const dev = await loadDb("mysql://dev:dev@localhost:3307/language_flow");
    expect(() => dev.requireSafeWriteTarget("db:migrate")).not.toThrow();
    const container = await loadDb("mysql://dev:dev@mysql:3306/language_flow");
    expect(() => container.requireSafeWriteTarget("db:migrate")).not.toThrow();
  });
});
