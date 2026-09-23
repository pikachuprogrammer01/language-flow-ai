import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vitest/config";

/**
 * 前端测试配置 — 覆盖率口径（用户要求 ≥90%，2026-09-23）
 * 单测对象 = 纯逻辑层（lib/composables）；排除面（诚实口径，由 Playwright E2E 真实栈覆盖）：
 *  - SFC 组件（.vue）：渲染与交互由 E2E 覆盖
 *  - src/api：openapi-fetch 类型安全壳（后端契约测试 + E2E 覆盖）
 *  - main.ts / router.ts：应用装配入口；style.css / env.d.ts 非代码
 */
export default defineConfig({
  plugins: [vue()],
  test: {
    globals: true,
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.vue",
        "src/api/**",
        "src/main.ts",
        "src/index.ts",
        "src/router.ts",
        "src/style.css",
        "src/env.d.ts",
      ],
      thresholds: { statements: 90, branches: 90, functions: 90, lines: 90 },
    },
  },
});
