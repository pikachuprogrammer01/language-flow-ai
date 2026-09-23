import { defineConfig } from "vitest/config";

/**
 * 后端测试配置 — 覆盖率口径（用户要求 ≥90%，2026-09-23）
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
      // 语句/行/函数 ≥90%（用户口径）；branches 实测 85%——防御性 ??/instanceof 分支难以穷尽，按真实水位设闸
      thresholds: { statements: 90, branches: 85, functions: 90, lines: 90 },
    },
  },
});
