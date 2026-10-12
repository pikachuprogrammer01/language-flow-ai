import { expect, test } from "@playwright/test";
import { generateAndWait, trackPageErrors } from "./helpers";
/**
 * 数据分析 E2E（Phase 2 看板）— 真实测试栈 5174 + seed fixture（test0001scene 双平台发布记录与指标）
 * 断言口径来自 docker/test-fixtures/test-data.sql：播放合计 12000+3000、2秒折算、快手无完播显示「—」、
 * 样本不足提示与「秒级留存不造假」诚实声明；非破坏性（只读 + 标签保存不在此覆盖）
 */

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

  test("页面 B：统一内容主视图（一内容一行；平台指标只在各平台明细里；不相加、缺值不补 0）", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await page.goto("/insights/videos");
    await expect(page.getByRole("heading", { name: "视频表现" })).toBeVisible();
    await expect(page.getByText(/机场英语/).first()).toBeVisible();
    // fixture 的 test0001scene 有抖音+快手两条发布记录：新口径必须只占一行（一内容一行）
    const sceneRow = page.locator("tbody tr").filter({
      has: page.locator("a[href*='/insights/videos/test0001scene']"),
    });
    await expect(sceneRow).toHaveCount(1);
    // 多平台内容的主行不显示任何指标数值：整段合并成一句引导展开（相加就是假数据）
    await expect(sceneRow.getByTestId("multi-platform-guard")).toBeVisible();
    // 12,000（抖音）+ 3,000（快手）= 15,000 这种跨平台合计不得出现在这一行
    await expect(sceneRow.getByText("15,000")).toHaveCount(0);
    // 平台名只在展开后的明细里出现：收起时不应在行集里看到快手
    await expect(page.getByText("快手")).toHaveCount(0);
    await page.getByRole("button", { name: "展开 测试：机场英语 错过登机 的平台明细" }).click();
    const detail = page.getByTestId("platform-detail");
    await expect(detail).toHaveCount(2);
    const douyin = detail.filter({ hasText: "抖音" }).first();
    const kuaishou = detail.filter({ hasText: "快手" }).first();
    await expect(douyin).toBeVisible();
    await expect(kuaishou).toBeVisible();
    // 各平台各自读数：抖音 12,000 / 快手 3,000 分别在自己的明细里，没有合并
    await expect(douyin.getByText("12,000")).toBeVisible();
    await expect(kuaishou.getByText("3,000")).toBeVisible();
    await expect(douyin.getByText("3,000")).toHaveCount(0);
    // 快手只导入了播放量：其余指标显示「—」（缺失），绝不折算成 0.0%
    await expect(kuaishou.getByText("0.0%")).toHaveCount(0);
    await expect(kuaishou.getByText("—").first()).toBeVisible();
    // 发布时间来源如实标注（fixture 未回填来源 → 判不出就说「来源未知」，不假称人工填写）
    await expect(douyin.getByText(/来源未知|兜底|人工填写|平台导入/)).toBeVisible();
    // 批次 4A：可排序表头仍是真 button + aria-sort，键盘可达
    const completionTh = page.getByRole("columnheader").filter({ hasText: "完播" });
    await expect(completionTh).toHaveAttribute("aria-sort", "none");
    await completionTh.getByRole("button", { name: /完播/ }).click();
    await expect(completionTh).toHaveAttribute("aria-sort", "descending");
    await completionTh.getByRole("button", { name: /完播/ }).focus();
    await page.keyboard.press("Enter");
    await expect(completionTh).toHaveAttribute("aria-sort", "ascending");
    expect(errors).toEqual([]);
  });

  test("页面 B：状态筛选可扩大行集（失败/未发布的集也在内容视图里可见）", async ({ page }) => {
    const errors = trackPageErrors(page);
    await page.goto("/insights/videos");
    // 默认口径=已完成且有成片；fixture 的 failed 内容不在默认行集里
    await expect(page.getByRole("button", { name: "生成失败" })).toBeVisible();
    await page.getByRole("button", { name: "生成失败" }).click();
    await expect(
      page.getByTestId("content-status").filter({ hasText: "生成失败" }).first(),
    ).toBeVisible();
    await page.getByRole("button", { name: "全部" }).click();
    await expect(page.getByRole("heading", { name: "视频表现" })).toBeVisible();
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
    await generateAndWait(page);
    // 建议按平台分别生成（跨平台样本不可比），每张卡点名自己的平台与窗口
    await expect(page.getByText(/继续导入创作者数据并标注场景\/Hook/).first()).toBeVisible();
    // 样本不足纪律（措辞随数据形态，只钉语义：无达门槛分组→不出参数建议）
    await expect(page.getByText(/无分组达到最小真实样本量 8|不计入行动门槛/).first()).toBeVisible();
    await expect(page.getByText(/(抖音|快手) · (近 \d+ 天|全部历史)/).first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("页面 D 建议证据链：展开可追到快照口径与参与样本（追不到就明说，不拼假证据）", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await page.goto("/insights/factors");
    await generateAndWait(page);
    const firstEvidence = page.getByRole("button", { name: "查看证据" }).first();
    await expect(firstEvidence).toBeVisible();
    await firstEvidence.click();
    const panel = page.getByTestId("evidence-panel");
    await expect(panel).toBeVisible();
    // 两种合法终态：追到快照（含平台/窗口口径）或如实说明缺哪一环
    await expect(
      panel
        .getByText(/快照 #factors:|近 \d+ 天|全部历史/)
        .or(panel.getByText(/证据不完整|未留档|不存在/))
        .first(),
    ).toBeVisible();
    // 门槛纪律的可证形式：样本不足的那张卡上不得出现任何「使用推荐参数创建」入口
    const lowSampleCard = page
      .getByTestId("rec-card")
      .filter({ hasText: /无分组达到最小真实样本量 8/ })
      .first();
    await expect(lowSampleCard).toBeVisible();
    await expect(lowSampleCard.getByRole("button", { name: "使用推荐参数创建" })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("页面 D 达门槛建议的证据链能追到导入原始行（不是只停在字段名）", async ({ page }) => {
    const errors = trackPageErrors(page);
    await page.goto("/insights/factors");
    await generateAndWait(page);
    const card = page.getByTestId("rec-card").filter({ hasText: "推荐语速" }).first();
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "查看证据" }).click();
    const panel = page.getByTestId("evidence-panel");
    await expect(panel.getByTestId("evidence-import-row").first()).toBeVisible();
    // 批次文件 + 行号 + 裁决方式：这一环成立才说明「建议 → 原始数据」真的接上了
    await expect(panel).toContainText("小红书创作者后台_导入夹具.csv");
    await expect(panel).toContainText("裁决 operator_confirm");
    await expect(panel).toContainText("参与样本 8 条");
    expect(errors).toEqual([]);
  });

  test("页面 D 采纳参数建议：先登记采纳再预填，创建页点名来源与口径（docs/22 §4.2 / §7.2）", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    await page.goto("/insights/factors");
    await generateAndWait(page);
    // 夹具里 8 条同平台样本的语速组达门槛 → 这张卡应当可以给参数；
    // 预填值必须是创建页能表示的档位（快 = 1.2）
    const card = page.getByTestId("rec-card").filter({ hasText: "推荐语速" }).first();
    await expect(card).toBeVisible();
    const adopted = page.waitForResponse(
      (res) =>
        res.request().method() === "POST" &&
        /\/recommendations\/[^/]+\/applications$/.test(res.url()),
      { timeout: 30000 },
    );
    await card.getByRole("button", { name: "使用推荐参数创建" }).click();
    const record = await (await adopted).json();
    expect(record.id).toMatch(/^recapp_/);
    expect(record.targetMetric).toBe("completion_rate");
    await expect(page).toHaveURL(/\/create/);
    const banner = page.getByTestId("adoption-source");
    await expect(banner).toBeVisible();
    // 来源可回放：点名平台/窗口/样本量，并保留「不是因果结论」的原始措辞
    await expect(banner).toContainText("小红书 · 近 90 天");
    await expect(banner).toContainText("真实样本 n=8");
    await expect(banner).toContainText("不是因果结论");
    await expect(banner).toContainText("你实际提交的参数");
    // 预填真的装进了表单：语速档位高亮的是「快」（控件在第二步，DOM 里始终存在）
    const pressedRate = page.locator('[aria-pressed="true"]').filter({ hasText: /^(慢|正常|快)$/ });
    await expect(pressedRate).toHaveText("快");
    expect(errors).toEqual([]);
  });

  test("页面 D：完播率无导入数据时提示可换 2 秒有效播放率，但不自动换", async ({ page }) => {
    const errors = trackPageErrors(page);
    await page.goto("/insights/factors");
    await expect(page.getByRole("heading", { name: "因子分析" })).toBeVisible();
    const hint = page.getByTestId("metric-switch-hint");
    // 该提示只在完播率零样本时出现；有数据时钉另一侧：默认指标就是完播率
    if (await hint.count()) {
      await expect(hint.getByText(/2 秒有效播放率|effective_play_rate_2s/)).toBeVisible();
      await expect(hint.getByText("系统不会自动替你换指标")).toBeVisible();
      const active = page
        .getByRole("button", { name: "完播率" })
        .or(page.getByRole("button", { name: /完播/ }));
      await expect(active.first()).toHaveClass(/bg-brand-soft/);
    } else {
      await expect(page.getByText("账号整体基准")).toBeVisible();
    }
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

  test("内容实验台账：分配与未绑定条数如实呈现（评估以它为准，不是登记清单）", async ({ page }) => {
    const errors = trackPageErrors(page);
    await page.goto("/insights/experiments");
    const card = page.locator("section").filter({ hasText: "提问 vs 平铺" }).first();
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "分配台账" }).click();
    const ledger = card.getByTestId("assignment-ledger");
    await expect(ledger).toBeVisible();
    await expect(ledger).toContainText("共 3 条分配 · 已绑定 1 条 · 未绑定 2 条");
    await expect(ledger.getByTestId("assignment-row")).toHaveCount(3);
    await expect(ledger.getByText("test0001scene")).toBeVisible();
    await expect(ledger.getByText(/未绑定内容/).first()).toBeVisible();
    await expect(ledger.getByText(/不计入样本/).first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("新建页参与实验：只列可分配的实验，选定后点名变体与登记时机", async ({ page }) => {
    const errors = trackPageErrors(page);
    await page.goto("/create");
    const picker = page.getByTestId("experiment-picker");
    await expect(picker).toBeVisible();
    const select = page.getByTestId("experiment-select");
    // 折叠的原生 select 里 option 不可见，钉存在与文案而不是可见性
    await expect(select.locator("option", { hasText: "提问 vs 平铺" })).toHaveCount(1);
    // 已取消的实验不在可参与列表里（服务端也只接受 draft/running 的分配）
    await expect(select.locator("option", { hasText: "情景背词 vs 单词卡片" })).toHaveCount(0);
    await select.selectOption("testexpdraft1");
    const variantB = picker.getByRole("button", { name: /B 组/ });
    await expect(variantB).toHaveAttribute("aria-pressed", "false");
    await variantB.click();
    await expect(variantB).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("experiment-note")).toContainText(
      "生成开始时登记为 B 组（平铺）",
    );
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
