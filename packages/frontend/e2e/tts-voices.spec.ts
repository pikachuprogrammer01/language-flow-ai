import { type Page, expect, test } from "@playwright/test";
/**
 * 配音音色管理页 E2E（docs/24）— 真实测试栈 5174 + 夹具 tts_voices 种子
 *
 * 故意不点「测一次」：那个按钮会真打微软端点，外网抖动会把门禁染成不稳定红灯。
 * 这里只钉机制：界面上下架 → 可选列表与合成入口必须同步变化，
 * 且已下架音色打到合成接口是 400（参数不合法），不是 500（服务坏了）。
 */
import { trackPageErrors } from "./helpers";

const DISABLED = "zh-CN-XiaohanNeural"; // 晓涵：夹具里就是 enabled=0 + no_audio

async function stackReady(page: Page): Promise<boolean> {
  try {
    return (await page.request.get("/health")).ok();
  } catch {
    return false;
  }
}

test.beforeEach(async ({ page }) => {
  test.skip(!(await stackReady(page)), "测试栈未就绪：请先 pnpm docker:test");
});

test("音色页如实显示上下架状态与实测结论", async ({ page }) => {
  const errors = trackPageErrors(page);
  await page.goto("/tts-voices");
  await expect(page.getByRole("heading", { name: "配音音色" })).toBeVisible();

  const xiaoxiao = page.getByRole("row").filter({ hasText: "zh-CN-XiaoxiaoNeural" });
  await expect(xiaoxiao.getByText("可选")).toBeVisible();
  await expect(xiaoxiao.getByText(/· 可出音频$/)).toBeVisible();

  const xiaohan = page.getByRole("row").filter({ hasText: DISABLED });
  await expect(xiaohan.getByText("已下架")).toBeVisible();
  await expect(xiaohan.getByText(/· 端点不提供该音色$/)).toBeVisible();
  expect(errors).toEqual([]);
});

test("下架与上架成对生效：可选列表与合成入口同步", async ({ page }) => {
  await page.goto("/tts-voices");
  const row = page.getByRole("row").filter({ hasText: DISABLED });
  await expect(row.getByText("已下架")).toBeVisible();

  /** 已下架音色直接打合成接口 → 400 + 结构化 code，且不产生任何远端调用 */
  const rejected = await page.request.post("/api/tts/generate", {
    data: { text: "测试", voice: DISABLED },
  });
  expect(rejected.status()).toBe(400);
  expect((await rejected.json()).code).toBe("VOICE_UNAVAILABLE");

  // 上架 → 出现在可选列表
  await row.getByRole("button", { name: "上架" }).click();
  await expect(row.getByText("可选")).toBeVisible();
  let voices = (await (await page.request.get("/api/tts/voices")).json()).voices.map(
    (v: { id: string }) => v.id,
  );
  expect(voices).toContain(DISABLED);

  // 再下架 → 回到夹具声明的状态（不留残留给后面的用例）
  await row.getByRole("button", { name: "下架" }).click();
  await expect(row.getByText("已下架")).toBeVisible();
  voices = (await (await page.request.get("/api/tts/voices")).json()).voices.map(
    (v: { id: string }) => v.id,
  );
  expect(voices).not.toContain(DISABLED);
});
