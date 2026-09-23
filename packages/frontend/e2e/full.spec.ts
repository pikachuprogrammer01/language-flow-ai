import { expect, test } from "@playwright/test";
/**
 * @full 全链路套件 — 生成 → 配音 → 渲染真实跑通（真实 Ollama + Edge TTS + 容器内渲染）
 * 默认跳过：需宿主机 Ollama 就绪且能接受分钟级耗时；触发：RUN_FULL=1 pnpm e2e
 * 会在测试库产生一条新记录（测试栈隔离区，可事后到生成记录删除）
 */
const RUN_FULL = process.env.RUN_FULL === "1";

test.describe("全链路 @full", () => {
  test(
    "生成内容 → 配音 → 渲染出片",
    {
      timeout: 10 * 60_000,
      tag: "@full",
      annotation: { type: "precondition", description: "需 Ollama 就绪" },
    },
    async ({ page }) => {
      test.skip(!RUN_FULL, "全链路用例默认跳过：RUN_FULL=1 触发（需 Ollama 与外网 Edge TTS）");
      await page.goto("/create");
      // ① 内容设置 → ② AI 生成
      await page.getByRole("button", { name: "下一步：AI 生成 →" }).click();
      await page.getByRole("button", { name: /AI 生成内容/ }).click();
      await expect(page.getByText("② 内容已生成", { exact: false })).toBeVisible({
        timeout: 600_000,
      });
      // ③ 配音设置 → 生成配音
      await page.getByRole("button", { name: "下一步：配音设置 →" }).click();
      await page.getByRole("button", { name: /生成配音/ }).click();
      await expect(page.getByText(/配音完成 · \d+\.\d+s/)).toBeVisible({ timeout: 300_000 });
      // ④ 渲染确认 → 渲染视频 → 播放器出现
      await page.getByRole("button", { name: "下一步：渲染确认 →" }).click();
      await page.getByRole("button", { name: /渲染视频/ }).click();
      await expect(page.locator("video")).toBeVisible({ timeout: 600_000 });
    },
  );
});
