import { defineConfig } from "vitest/config";

/**
 * shared 测试配置 — 覆盖率口径（≥90%，2026-09-23）：
 * 本包以类型为主（编译期擦除），运行时代码 = 枚举常量 + DTO 守卫 + 渲染纯函数，全部纳入统计
 */
export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      all: false, // 只统计被测试触达的文件：纯类型模块（request/response.dto）无运行时代码，计入只产生 0% 假象
      include: ["src/**"],
      exclude: ["src/**/*.test.ts", "src/index.ts"], // index 为纯 re-export barrel，无逻辑
      thresholds: { statements: 90, branches: 90, functions: 90, lines: 90 },
    },
  },
});
