import type { Page } from "@playwright/test";
/**
 * E2E 共用小工具（真实闭环批次二/三）
 * 只放跨 spec 真正同形的逻辑；各 spec 自己的业务断言不往这里搬。
 */

export function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  return errors;
}

/**
 * 点「按最新数据生成」并等它彻底结束：生成会删掉未处理的旧建议换新 id，
 * 若在列表重载前就点「查看证据」，面板会因为 v-if 的旧 id 消失而查不到内容（曾造成证据链用例假红灯）。
 */
export async function generateAndWait(page: Page): Promise<void> {
  const btn = page.getByRole("button", { name: "按最新数据生成" });
  await btn.click();
  await page.waitForResponse(
    (res) => res.request().method() === "POST" && res.url().endsWith("/recommendations/generate"),
    { timeout: 30000 },
  );
  await page.waitForResponse(
    (res) =>
      res.request().method() === "GET" && res.url().includes("/api/analytics/recommendations"),
    { timeout: 30000 },
  );
}
