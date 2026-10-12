import { type Page, expect, test } from "@playwright/test";
import { generateAndWait, trackPageErrors } from "./helpers";
/**
 * @full 全链路套件 — 生成 → 配音 → 渲染真实跑通（真实 Ollama + Edge TTS + 容器内渲染）
 * 默认跳过：需宿主机 Ollama 就绪且能接受分钟级耗时；触发：RUN_FULL=1 pnpm e2e
 * 会在测试库产生一条新记录（测试栈隔离区，可事后到生成记录删除）
 *
 * 已知不稳定来源（不是本套件的缺陷）：本地 qwen2.5:7b 可能连续 3 轮都过不了词库验收
 * （「有效词不足」/输出 JSON 被截断），此时后端如实回 HTTP 500。实测同一用例
 * 2026-10-04 三次里两次成功一次失败。因此这里等的是「成功或明确失败」两种终态，
 * 失败时立刻带原因红，不再干等 10 分钟超时。
 */
const RUN_FULL = process.env.RUN_FULL === "1";

/**
 * 等「② 内容已生成」或「生成失败（HTTP …）」任一终态。
 * 只等成功的那句会在模型验收失败时白等 10 分钟，且报出来的是超时而不是原因。
 */
async function expectGeneratedOrFail(page: Page): Promise<void> {
  // 钉那个错误回显块本身：toast 会在 sr-only 活动区域放一份同文案副本，
  // 按文案匹配会撞 strict mode（实测 3 个命中，白等 10 分钟才报超时）
  const failed = page.getByTestId("create-error");
  await expect(page.getByText("② 内容已生成").or(failed)).toBeVisible({ timeout: 600_000 });
  const reason = await failed.textContent().catch(() => null);
  expect(reason, reason ? `生成被拒：${reason}` : "生成未成功").toBeNull();
}

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
      // 配置里 timeout 是 30s，用例级 details 的 timeout 不生效（实测被 30s 打断），必须显式放宽
      test.setTimeout(10 * 60_000);
      await page.goto("/create");
      // ① 内容设置 → ② AI 生成
      await page.getByRole("button", { name: "下一步：AI 生成 →" }).click();
      await page.getByRole("button", { name: /AI 生成内容/ }).click();
      await expectGeneratedOrFail(page);
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

  /**
   * 真实闭环批次二 + 批次三的效果回路：
   * 采纳参数建议 → 选定实验变体 → 真实生成内容 → 两条回路都在生成成功后落库。
   * 这是常规门禁唯一没覆盖的一段（需要真实 Ollama），绑定语义本身另有真库不变量兜底。
   */
  test(
    "采纳建议 + 选定实验变体 → 真实生成 → 采纳回写与分配绑定都落库",
    {
      timeout: 12 * 60_000,
      tag: "@full",
      annotation: {
        type: "precondition",
        description:
          "需 Ollama 就绪 + 夹具的 8 样本建议与实验；台账条数是精确断言，跑前先 pnpm docker:test:seed 复位夹具",
      },
    },
    async ({ page }) => {
      test.skip(!RUN_FULL, "全链路用例默认跳过：RUN_FULL=1 触发（需 Ollama 与外网 Edge TTS）");
      // 同上：真实生成本身就要几分钟
      test.setTimeout(12 * 60_000);
      const errors = trackPageErrors(page);
      // ① 因子页：达门槛的语速建议（夹具 8 条同平台样本）→ 点采纳
      await page.goto("/insights/factors");
      await generateAndWait(page);
      const card = page.getByTestId("rec-card").filter({ hasText: "推荐语速" }).first();
      await expect(card).toBeVisible();
      await card.getByRole("button", { name: "使用推荐参数创建" }).click();
      await expect(page).toHaveURL(/\/create/);
      await expect(page.getByTestId("adoption-source")).toContainText("真实样本 n=8");
      // ② 同一次生成再选定实验的 B 组（分配在生成开始时登记，此时还没有内容）
      await page.getByTestId("experiment-select").selectOption("testexpdraft1");
      await page.getByTestId("experiment-picker").getByRole("button", { name: /B 组/ }).click();
      // ③ 真实生成内容：绑定动作发生在内容成功之后
      await page.getByRole("button", { name: "下一步：AI 生成 →" }).click();
      await page.getByRole("button", { name: /AI 生成内容/ }).click();
      await expectGeneratedOrFail(page);
      // ④ 实验台账：夹具的 1 绑定 + 2 未绑定，加上本次新分配并绑定 → 共 4 条、已绑定 2、未绑定 2
      await page.goto("/insights/experiments");
      const expCard = page.locator("section").filter({ hasText: "提问 vs 平铺" }).first();
      await expect(expCard).toBeVisible();
      await expCard.getByRole("button", { name: "分配台账" }).click();
      const ledger = expCard.getByTestId("assignment-ledger");
      await expect(ledger).toContainText("共 4 条分配 · 已绑定 2 条 · 未绑定 2 条");
      await expect(ledger.getByTestId("assignment-row")).toHaveCount(4);
      // ⑤ 采纳回路：建议卡转为已采纳，且「已产出新内容」按真实回写计数（批次二修的那口径）
      await page.goto("/insights/factors");
      const adopted = page
        .getByTestId("rec-card")
        .filter({ hasText: "推荐语速" })
        .filter({ hasText: "已采纳" })
        .first();
      await expect(adopted).toBeVisible();
      await expect(
        page.getByText(/累计 采纳 \d+ \/ 忽略 \d+ \/ 已产出新内容 [1-9]/).first(),
      ).toBeVisible();
      expect(errors).toEqual([]);
    },
  );
});
