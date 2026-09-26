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
    await expect(page.getByText("覆盖 1/2 条记录").first()).toBeVisible();
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
    // 同类 Benchmark 小样本必须给样本不足提示（需求 §十一 页面 D 纪律）
    await expect(page.getByText("样本不足").first()).toBeVisible();
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
    // fixture 仅 2 样本：总样本不足横幅必须在位
    await expect(page.getByText("总样本不足 8 条").first()).toBeVisible();
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

  test("导入向导 · 逐视频粘贴路径（预匹配→可匹配预览→提交成功）", async ({ page }) => {
    const errors = trackPageErrors(page);
    await page.goto("/insights/data");
    await expect(page.getByRole("heading", { name: "数据接入" })).toBeVisible();
    // 真实性声明：抖音开放平台通道已砍除，导入即唯一入口
    await expect(page.getByText("抖音开放平台数据通道未接入")).toBeVisible();
    // fixture 发布记录（统一 ID 链路）
    await expect(page.getByText("7432123456789012345").first()).toBeVisible();
    // ① 粘贴 TSV → 自动判定为逐视频明细
    await page
      .getByTestId("wizard-textarea")
      .fill("作品ID\t播放量\t点赞量\n7432123456789012345\t12000\t500");
    await expect(page.getByText(/3 列/)).toBeVisible();
    await page.getByTestId("wizard-next-1").click();
    // ② 预匹配两列 + ID 列自动识别
    await expect(page.getByText(/已自动预匹配 2 列/)).toBeVisible();
    await expect(page.getByText("ID 列")).toBeVisible();
    await page.getByTestId("wizard-next-2").click();
    // ③ 可匹配性预览（不阻断只提醒）
    await expect(page.getByText("可匹配").first()).toBeVisible();
    await page.getByTestId("wizard-next-3").click();
    // ④ 提交（播放量与 fixture 同值幂等，不干扰页面 A 合计断言）
    await page.getByTestId("wizard-submit").click();
    await expect(page.getByText(/导入结果：成功 1 \/ 共 1/)).toBeVisible({ timeout: 10_000 });
    expect(errors).toEqual([]);
  });

  test("导入向导 · xlsx 上传账号日 7 天表（自动匹配+人工裁决+仅账号级混合落库）", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await page.goto("/insights/data");
    // ① 选文件（隐藏 input 由按钮唤起）
    const chooser = page.waitForEvent("filechooser");
    await page.getByTestId("wizard-xlsx-btn").click();
    (await chooser).setFiles("e2e/fixtures/creator-daily.xlsx");
    await expect(page.getByText("7 行 × 10 列（分隔：xlsx）")).toBeVisible();
    await page.getByTestId("wizard-next-1").click();
    // ② 自动判定账号日 + 日期列 + 预匹配（总播放量/2秒跳出率等真实表头）
    await expect(page.getByText("日期列")).toBeVisible();
    await expect(page.getByText(/已自动预匹配 [6-9] 列/)).toBeVisible();
    await page.getByTestId("wizard-next-2").click();
    // ③ 三态判定：发布日那行自动匹配，其余行当日无发布→仅账号级；采纳全部自动建议
    await expect(page.getByText("自动匹配").first()).toBeVisible();
    await expect(page.getByText("当日无发布").first()).toBeVisible();
    await page.getByTestId("wizard-adopt-all").click();
    await page.getByTestId("wizard-next-3").click();
    // ④ 提交 7 行全部成功（归属行播放量与 fixture 同值幂等）
    await page.getByTestId("wizard-submit").click();
    await expect(page.getByText(/导入结果：成功 7 \/ 共 7/)).toBeVisible({ timeout: 15_000 });
    expect(errors).toEqual([]);
    // API 断言：账号日行真实落库（15.08%/78.07%/3.94s 归一化）
    const resp = await page.request.get(
      "/api/analytics/creator-daily?dateFrom=2026-09-17&dateTo=2026-09-17",
    );
    const data = (await resp.json()) as {
      items: {
        playIncrement: number;
        bounceRate2s: number;
        watchRate5s: number;
        avgWatchTime: number;
        postCount: number;
      }[];
    };
    expect(data.items).toHaveLength(1);
    expect(data.items[0].playIncrement).toBe(708);
    expect(data.items[0].bounceRate2s).toBeCloseTo(0.7807, 4);
    expect(data.items[0].watchRate5s).toBeCloseTo(0.1508, 4);
    expect(data.items[0].avgWatchTime).toBeCloseTo(3.94, 2);
    expect(data.items[0].postCount).toBe(1);
  });

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
