import { defineConfig } from "@playwright/test";
/**
 * E2E 配置 — 真实 Docker 测试栈（http://localhost:5174，UI 5174 / 测试库 3307）
 * 约定（用户决策 2026-09-22）：仅手动触发（pnpm e2e），不进 git hooks；
 * 默认套件非破坏性（读路径 + UI 交互 + 确认弹窗一律取消）；
 * 全链路（生成→配音→渲染）用例标 @full，需宿主机 Ollama 就绪，RUN_FULL=1 才跑。
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  workers: 1, // 共享同一测试栈与数据库，串行避免相互干扰
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5174",
    headless: true,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium" }],
});
