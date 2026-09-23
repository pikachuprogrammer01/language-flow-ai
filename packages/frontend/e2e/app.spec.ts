import { type Page, expect, test } from "@playwright/test";
/**
 * E2E 默认套件 — 真实 Docker 测试栈（5174，UI + 后端 + 测试库 3307），非破坏性
 * 覆盖批注 FDD 第四~七轮关键交互：向导校验 / 停止二次确认 / 继续生产入口 /
 * 删除确认（一律取消）/ 保存策略回显 / 文件管理页可达（nginx 301 回归）/ 缓存头回归
 * 前置：pnpm docker:test 已启动测试栈（webServer 不代管基础设施，仅前置断言给出引导）
 */

/** 收集页面未捕获异常（组件级错误必须为零） */
function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  return errors;
}

test.beforeEach(async ({ page }) => {
  test.skip(!(await healthOk(page)), "测试栈未就绪：请先 pnpm docker:test");
});

async function healthOk(page: Page): Promise<boolean> {
  try {
    const res = await page.request.get("/health");
    return res.ok();
  } catch {
    return false;
  }
}

test.describe("工作台", () => {
  test("指标卡与流水线渲染（中文口径 + 卡点拆解）", async ({ page }) => {
    const errors = trackPageErrors(page);
    await page.goto("/");
    await expect(page.getByText("待推进任务")).toBeVisible();
    // 卡点拆解行（前端派生）：待配音 X · 待渲染 Y
    await expect(page.getByText(/待配音 \d+ · 待渲染 \d+/)).toBeVisible();
    // 模板分布过中文映射（不允许裸枚举名 scene_word）
    await expect(page.getByText(/模板分布：(情景背词|单词卡片|选择题)/)).toBeVisible();
    // 流水线五个阶段限定在「生产流水线」section 内（避免与最近任务状态胶囊文本冲突命中 strict-mode）
    const pipeline = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "生产流水线" }) });
    await expect(pipeline).toBeVisible();
    for (const stage of ["内容生成", "内容就绪", "TTS 配音", "视频渲染", "可发布"]) {
      await expect(pipeline.locator("b", { hasText: stage })).toBeVisible();
    }
    expect(errors).toEqual([]);
  });
});

test.describe("新建页向导", () => {
  test("步进器前进跳转被前置校验拦截并 toast 播报", async ({ page }) => {
    const errors = trackPageErrors(page);
    await page.goto("/create");
    // 面板挂载完成再操作（避免首帧竞态：步进器点击早于校验逻辑就绪）
    await expect(page.getByRole("heading", { name: "选择模板" })).toBeVisible();
    // 清空主题 → 点步进器 02：应被拦截（主题必填）
    await page.locator("#topic").fill("");
    await page.locator('button[title="点击跳转到「AI 生成」"]').click();
    await expect(page.getByText("请先填写/选择视频主题")).toBeVisible();
    // 恢复主题 → 点步进器 04：应被拦截（未生成内容）
    await page.locator("#topic").fill("森林探险");
    await page.locator('button[title="点击跳转到「渲染确认」"]').click();
    await expect(page.getByText("请先在 02 AI 生成 步骤生成内容")).toBeVisible();
    // 拦截即不跳步：仍停留在内容设置面板
    await expect(page.getByRole("heading", { name: "选择模板" })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("AI 推荐按钮与预设主题同区（批注：离得太远）", async ({ page }) => {
    await page.goto("/create");
    const aiBtn = page.getByRole("button", { name: /AI 推荐/ });
    await expect(aiBtn).toBeVisible();
    // 与预设 chips 同属主题框容器（含「校园生活」chip 的祖先）
    await expect(
      aiBtn.locator("xpath=ancestor::*[.//button[contains(.,'校园生活')]]").last(),
    ).toBeVisible();
  });

  test("生成中点顶栏「新建视频」：放弃二次确认（取消继续 / 确认中断重置）", async ({ page }) => {
    const errors = trackPageErrors(page);
    await page.route("**/api/content/generate", (route) => {
      setTimeout(() => void route.abort("connectionreset").catch(() => {}), 30_000);
    });
    await page.goto("/create");
    await page.getByRole("button", { name: "下一步：AI 生成 →" }).click();
    await page.getByRole("button", { name: /AI 生成内容/ }).click();
    await expect(page.getByRole("button", { name: /■ 停止/ })).toBeVisible();
    // 点顶栏「新建视频」→ 弹放弃确认；选「继续创建」→ 不中断，仍在生成
    await page.getByRole("button", { name: "新建视频" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByText("放弃当前创建？")).toBeVisible();
    await dialog.getByRole("button", { name: "继续创建" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: /■ 停止/ })).toBeVisible();
    // 再点一次选「放弃并新建」→ 中断在飞请求 + 回到内容设置面板
    await page.getByRole("button", { name: "新建视频" }).click();
    await dialog.getByRole("button", { name: "放弃并新建" }).click();
    await expect(page.getByText("已停止生成，可重新发起")).toBeVisible();
    await expect(page.getByRole("heading", { name: "选择模板" })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("生成中可停止：■ 停止 → 二次确认 → 中断 toast（不视为失败）", async ({ page }) => {
    const errors = trackPageErrors(page);
    // 挂起生成请求 20s（真实栈行为，仅注入网络延迟），留出停止操作窗口
    await page.route("**/api/content/generate", (route) => {
      setTimeout(() => void route.abort("connectionreset").catch(() => {}), 20_000);
    });
    await page.goto("/create");
    await page.getByRole("button", { name: "下一步：AI 生成 →" }).click();
    await page.getByRole("button", { name: /AI 生成内容/ }).click();
    const stop = page.getByRole("button", { name: /■ 停止/ });
    await expect(stop).toBeVisible();
    await stop.click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("清理无引用文件")).toBeVisible(); // 弹窗内含磁盘回收引导
    await dialog.getByRole("button", { name: "停止" }).click();
    await expect(page.getByText("已停止生成，可重新发起")).toBeVisible();
    // 停止不是失败：错误框不得出现
    await expect(page.getByText("内容生成失败")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test.describe("生成记录", () => {
  test("操作列按状态渲染：继续生产入口 + 视频行三按钮；删除确认取消后行保留", async ({ page }) => {
    const errors = trackPageErrors(page);
    await page.goto("/tasks");
    // fixture 行排序依赖存量数据量，切到每页 100 条消除分页漂移
    await page.locator('label:has-text("每页") select').selectOption("100");
    // 配音完成（audio_ready）fixture 行 → 继续生产入口存在（不点击，避免真实渲染）
    const audioRow = page.getByRole("row").filter({ hasText: "配音完成" });
    await expect(audioRow.getByRole("button", { name: /继续生产/ })).toBeVisible();
    // 已完成行：打开 / 标记 / 复制视频名称（批注文案）
    const doneRow = page.getByRole("row").filter({ hasText: "已完成" }).first();
    await expect(doneRow.getByRole("button", { name: /复制视频名称/ })).toBeVisible();
    await expect(doneRow.getByRole("button", { name: /打开/ })).toBeVisible();
    // 删除 → 二次确认（含磁盘引导）→ 取消 → 行仍在（非破坏）
    const rowCountBefore = await page.getByRole("row").count();
    await doneRow.getByRole("button", { name: "删除" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByText("清理无引用文件")).toBeVisible();
    await dialog.getByRole("button", { name: "取消" }).click();
    await expect(dialog).toBeHidden();
    expect(await page.getByRole("row").count()).toBe(rowCountBefore);
    expect(errors).toEqual([]);
  });

  test("详情页保存策略徽章回显（与发布管理同源）", async ({ page }) => {
    await page.goto("/tasks");
    await page.getByRole("row").filter({ hasText: "已完成" }).first().click();
    await expect(page.getByText("保存策略：")).toBeVisible();
    await expect(page.getByRole("button", { name: /允许观众保存|已禁止观众保存/ })).toBeVisible();
  });
});

test.describe("文件管理", () => {
  test("/files 直达可达（nginx 301 丢端口回归）+ 清理入口在位", async ({ page }) => {
    const errors = trackPageErrors(page);
    const res = await page.goto("/files");
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "文件管理" })).toBeVisible();
    await expect(page.getByText("可清理")).toBeVisible();
    const cleanup = page.getByRole("button", { name: /清理无引用文件/ });
    await expect(cleanup).toBeVisible();
    // 点击后若有确认弹窗一律取消；无孤儿则 toast 提示（两种都接受，不产生删除）
    await cleanup.click();
    const dialog = page.getByRole("alertdialog");
    if (await dialog.isVisible().catch(() => false)) {
      await dialog.getByRole("button", { name: "取消" }).click();
    }
    expect(errors).toEqual([]);
  });
});

test.describe("部署回归", () => {
  test("index.html 响应头 no-cache（重建发版即生效的缓存策略）", async ({ page }) => {
    const res = await page.goto("/");
    expect(res?.headers()["cache-control"] ?? "").toContain("no-cache");
  });
});
