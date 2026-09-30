import { type Page, expect, test } from "@playwright/test";
/**
 * 数据分析 E2E（Phase 2 看板）— 真实测试栈 5174 + seed fixture（test0001scene 双平台发布记录与指标）
 * 断言口径来自 docker/test-fixtures/test-data.sql：播放合计 12000+3000、2秒折算、快手无完播显示「—」、
 * 样本不足提示与「秒级留存不造假」诚实声明；非破坏性（只读 + 标签保存不在此覆盖）
 */

function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  return errors;
}

test.describe("数据分析看板", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(
      !(await healthOk(page)),
      "测试栈未就绪：请先 pnpm docker:test && pnpm docker:test:seed",
    );
  });

  async function healthOk(page: Page): Promise<boolean> {
    try {
      const res = await page.request.get("/health");
      return res.ok();
    } catch {
      return false;
    }
  }

  test("页面 A：视频观看漏斗（覆盖不一致诚实「—」与账号增长独立；审查批次 1）", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await page.goto("/insights");
    await expect(page.getByRole("heading", { name: "数据分析" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "视频观看漏斗" })).toBeVisible();
    // 窗口内播放合计 = 抖音 12000 + 快手 3000（fixture 均在 7 天窗口）
    await expect(page.getByText("15,000").first()).toBeVisible();
    await expect(page.getByText("2秒有效观看").first()).toBeVisible();
    // 口径诚实（批次 1）：快手无比例→ 2秒阶段与播放覆盖不同，给「—」+原因，绝不出现 114% 类截断/硬算
    // 覆盖计数随窗口内发布记录数变化（恢复真实数据后非 2），断言只钉「存在部分覆盖」语义不钉分母
    await expect(page.getByText(/覆盖 1\/\d+ 条记录/).first()).toBeVisible();
    await expect(page.getByText("与上一阶段覆盖的记录不同，不计算逐级转化").first()).toBeVisible();
    await expect(page.getByText("114.0%")).toHaveCount(0);
    // 关注（账号级）移出观看漏斗链路，独立分区展示
    await expect(page.getByText("账号增长（独立指标").first()).toBeVisible();
    await expect(page.getByText("关注", { exact: true }).first()).toBeVisible();
    // 来源诚实性：可见「创作者导入」标签，绝不出现「抖音 API」
    await expect(page.getByText("[创作者导入]").first()).toBeVisible();
    await expect(page.getByText("[抖音 API]")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("页面 B：视频表现列表（多平台逐行；缺失指标「—」；排序 button + aria-sort；行真链接）", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await page.goto("/insights/videos");
    await expect(page.getByRole("heading", { name: "视频表现" })).toBeVisible();
    await expect(page.getByText(/机场英语/).first()).toBeVisible();
    await expect(page.getByText("抖音").first()).toBeVisible();
    await expect(page.getByText("快手").first()).toBeVisible();
    // 批次 4A：可排序表头是真 button，键盘可达；aria-sort 播报排序状态
    const completionTh = page.getByRole("columnheader").filter({ hasText: "完播" });
    await expect(completionTh).toHaveAttribute("aria-sort", "none");
    await completionTh.getByRole("button", { name: /完播/ }).click();
    await expect(completionTh).toHaveAttribute("aria-sort", "descending");
    // 键盘：Tab 能聚焦到排序按钮并回车触发
    await completionTh.getByRole("button", { name: /完播/ }).focus();
    await page.keyboard.press("Enter");
    await expect(completionTh).toHaveAttribute("aria-sort", "ascending");
    // 行标题是真链接（可聚焦/可中键新开）
    await expect(page.locator("tbody a[href*='/insights/videos/']").first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("页面 C：生产参数×表现同屏 + 趋势 + 同类 Benchmark 诚实声明", async ({ page }) => {
    const errors = trackPageErrors(page);
    await page.goto("/insights/videos/test0001scene");
    // 左：生产参数（后端特征直取）
    await expect(page.getByRole("heading", { name: "生产参数" })).toBeVisible();
    await expect(page.getByText("知识点数")).toBeVisible();
    // 右：发布表现（12,000 播放 + 来源标签）与每日快照趋势（3 个快照日）
    await expect(page.getByText("12,000").first()).toBeVisible();
    await expect(page.getByText(/3 个快照日/).first()).toBeVisible();
    // 同类 Benchmark 样本量必须透明（需求 §十一）：小样本给「样本不足」横幅，达门槛给组内样本数+逐指标 n 标注
    await expect(
      page
        .getByText("样本不足")
        .or(page.getByText(/组内样本 \d+ 条/))
        .first(),
    ).toBeVisible();
    // 无秒级留存不造假曲线（需求 §二十二）
    await expect(page.getByRole("heading", { name: "秒级留存曲线为何不显示？" })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("页面 D：因子分析（分组统计必携样本数与低样本标记，非因果声明）", async ({ page }) => {
    const errors = trackPageErrors(page);
    await page.goto("/insights/factors");
    await expect(page.getByRole("heading", { name: "因子分析" })).toBeVisible();
    await expect(page.getByText("账号整体基准")).toBeVisible();
    // Hook 维度卡：fixture 未标注 → 「未标注」桶 + 样本数 2 + 「参考」低样本标
    const hookCard = page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: "Hook", exact: true }) });
    await expect(hookCard.getByText("未标注").first()).toBeVisible();
    await expect(hookCard.getByText("参考").first()).toBeVisible();
    // 诚实声明：相关性非因果
    await expect(page.getByText("不构成因果").first()).toBeVisible();
    // 批次 5B：留档显式化——页面装载为纯读，写快照必须经「重算并留档」按钮（只验存在不点击）
    await expect(page.getByRole("button", { name: "重算并留档" })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("页面 C：内容时间轴区块（未派生时给重建入口，不默认写库）", async ({ page }) => {
    const errors = trackPageErrors(page);
    await page.goto("/insights/videos/test0001scene");
    await expect(page.getByRole("heading", { name: "内容时间轴（生产口径派生）" })).toBeVisible();
    // 已派生（段落列表）与未派生（重建按钮）都是合法状态；默认套件不点击写操作
    const hasSegment = await page.getByText(/故事段|片头|单词卡|选择题/).count();
    const hasButton = await page.getByRole("button", { name: "按生产数据重建" }).count();
    expect(hasSegment + hasButton).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  test("页面 D 优化建议：样本不足时只给诚实的数据准备建议（不硬凑参数建议）", async ({ page }) => {
    const errors = trackPageErrors(page);
    await page.goto("/insights/factors");
    // 生成建议仅写 recommendations 派生表（测试栈隔离环境，幂等重建，非破坏性）
    await page.getByRole("button", { name: "按最新数据生成" }).click();
    await expect(page.getByText("继续导入创作者数据并标注场景/Hook")).toBeVisible();
    // 样本不足纪律（措辞随数据形态，只钉语义：无达门槛分组→不出参数建议）
    await expect(page.getByText(/无分组达到最小样本量 8|总样本不足 8 条/).first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("页面 C 复用此视频结构 → 预填进新建流程（§十七）", async ({ page }) => {
    const errors = trackPageErrors(page);
    await page.goto("/insights/videos/test0001scene");
    // 未派生先重建（幂等派生写入），已派生直接复用
    const rebuild = page.getByRole("button", { name: "按生产数据重建" });
    if (await rebuild.count()) {
      await rebuild.click();
      await expect(page.getByRole("button", { name: "复用此视频结构" })).toBeVisible({
        timeout: 10_000,
      });
    }
    await page.getByRole("button", { name: "复用此视频结构" }).click();
    await expect(page).toHaveURL(/\/create/);
    // 参考结构横幅：片头 + 正文段占比
    await expect(page.getByText("参考结构")).toBeVisible();
    await expect(page.getByText(/正文第 1 段/).first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("内容实验页：登记表单与描述统计纪律文案在位（只读，不提交）", async ({ page }) => {
    const errors = trackPageErrors(page);
    await page.goto("/insights/experiments");
    await expect(page.getByRole("heading", { name: "内容实验" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "登记新实验" })).toBeVisible();
    await expect(
      page.getByText("不足只给描述统计").or(page.getByText("样本不足")).first(),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("侧边栏「数据分析」入口存在且激活高亮", async ({ page }) => {
    await page.goto("/");
    const link = page.getByRole("link", { name: "数据分析" });
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/\/insights$/);
    await expect(link).toHaveClass(/bg-sidebar-item/);
  });

  test("分析域返回按钮：页面 A → 数据接入 → 返回回上一界面", async ({ page }) => {
    const errors = trackPageErrors(page);
    await page.goto("/insights");
    await page.getByRole("link", { name: "数据接入" }).click();
    await expect(page).toHaveURL(/\/insights\/data$/);
    await expect(page.getByTestId("insights-back")).toBeVisible();
    await page.getByTestId("insights-back").click();
    await expect(page).toHaveURL(/\/insights$/);
    // 工作台不显示返回（非分析域）
    await page.goto("/");
    await expect(page.getByTestId("insights-back")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  // 旧逐行下拉框向导的两条 E2E 已随组件删除（批次 H2）；四步精准匹配工作台的 E2E 在批次 I 重建

  test("数据接入页：新建发布记录走 reka Dialog/Select（非浏览器原生控件，只打开不提交）", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await page.goto("/insights/data");
    await page.getByRole("button", { name: "新建发布记录" }).click();
    const dialog = page.getByTestId("dialog-content");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/全局唯一/)).toBeVisible();
    // 平台下拉：reka Select 弹层（listbox），选项渲染在 portal 中
    await dialog.getByRole("combobox").first().waitFor();
    const platformTrigger = dialog.locator("[data-testid=select-trigger]").nth(1);
    await platformTrigger.click();
    await expect(page.getByRole("option", { name: "快手" })).toBeVisible();
    await page.keyboard.press("Escape");
    // 内容下拉存在（仅列已有成片的记录）
    await expect(dialog.getByText("绑定内容")).toBeVisible();
    await page.getByRole("button", { name: "取消" }).click();
    await expect(dialog).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
