import { defineConfig } from "vitest/config";

/**
 * 后端测试配置 — 覆盖率口径
 *
 * 阈值是 **2026-10-03 实测水位下沿**（语句 80.55 / 分支 83.76 / 函数 72.39 / 行 80.55），
 * 不是目标值：它的唯一作用是「不得低于现状」，防止新代码不带测试落地。
 * 历史备注：原设 90/90/90/85 但从未被任何自动环节执行（`test` 脚本不带 --coverage），
 * 属于假承诺；现由 `scripts/stack.sh release` 的质量门禁执行一次（docs/21 决策 9）。
 *
 * 排除面（诚实口径，均为「单测测不到/不该测」，由其他层覆盖）：
 *  - renderer/vendor：三方 three.js 产物
 *  - openapi.json：生成物
 *  - db/migrate.ts / db/seed.ts：运维脚本，由测试栈启动链路（entrypoint + docker:test）覆盖
 *  - index.ts：进程装配入口（serve/中间件挂载），由 E2E 真实栈覆盖
 *  - 测试文件自身
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**"],
      exclude: [
        "src/**/*.test.ts",
        "src/openapi.json",
        "src/renderer/vendor/**",
        "src/renderer/renderer.interface.ts",
        "src/db/migrate.ts",
        "src/db/seed.ts",
        "src/index.ts",
      ],
      // 实测水位下沿，见文件头；branches 原本就按真实水位设 85，此处随整体下调保持余量一致
      thresholds: { statements: 78, branches: 82, functions: 70, lines: 78 },
    },
  },
});
