import { type Page, expect, test } from "@playwright/test";
/**
 * 四步精准匹配导入工作台 E2E（/insights/import）— 真实测试栈 5174
 * 用例自包含：动态读发布记录锚定日期（不猜时钟，吸取 2026-09-27 静态日期漂移脆性教训）；
 * 结束清理批次与补建发布记录；红线断言：账号日级无归属按钮、回滚精确恢复。
 */

const BASE = "http://127.0.0.1:5174";

function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  return errors;
}

async function api<T>(page: Page, method: string, path: string, body?: unknown): Promise<T> {
  const res = await page.request.fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json" },
    data: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok()) throw new Error(`${method} ${path} -> ${res.status()} ${await res.text()}`);
  return (await res.json()) as T;
}

interface RecordItem {
  id: string;
  contentId: string;
  platformVideoId: string | null;
  publishTime: string | null;
  createdAt: string;
  publishTitle: string | null;
}

async function healthOk(page: Page): Promise<boolean> {
  try {
    return (await page.request.get("/health")).ok();
  } catch {
    return false;
  }
}

/** 注入 CSV 文件到隐藏 input（Playwright setInputFiles 支持 hidden） */
async function uploadCsv(page: Page, name: string, csv: string): Promise<void> {
  await page.setInputFiles('[data-testid="import-file-input"]', {
    name,
    mimeType: "text/csv",
    buffer: Buffer.from(csv, "utf-8"),
  });
}

test.describe("四步精准匹配导入", () => {
  test.beforeEach(async ({ page }) => {
    test.skip(
      !(await healthOk(page)),
      "测试栈未就绪：请先 pnpm docker:test && pnpm docker:test:seed",
    );
  });

  test("作品级全链路：粒度→规则→预匹配→批量确认/冲突裁决/忽略→preflight→提交→刷新→回滚", async ({
    page,
  }) => {
    const errors = trackPageErrors(page);
    // ── 锚定数据：fixture 抖音记录（固定 VID1）+ 补建同日相似标题记录（冲突目标，时间拉开 7h 避免落入容差） ──
    const records = await api<{ items: RecordItem[] }>(
      page,
      "GET",
      "/api/analytics/publish-records?pageSize=100",
    );
    const douyin = records.items.find((r) => r.platformVideoId === "7432123456789012345");
    expect(douyin, "fixture 应有固定作品 ID 的抖音记录（先 pnpm docker:test:seed）").toBeDefined();
    const vid1 = douyin?.platformVideoId ?? "";
    const anchorIso = (douyin?.publishTime ?? douyin?.createdAt ?? "").slice(0, 10);
    const vidConflict = `9${Date.now()}`; // 导入行里不存在的 ID（保证走弱证据）
    const created = await api<{ id: string }>(page, "POST", "/api/analytics/publish-records", {
      contentId: douyin?.contentId ?? "test0001scene",
      platform: "抖音",
      platformVideoId: vidConflict,
      publishTitle: "机场英语：错过登机怎么办理赔",
      publishTime: `${anchorIso}T11:50:10.000Z`,
    });
    let batchId = "";
    try {
      // 提交前基线（回滚断言用，不假设 fixture 干净：上一轮失败残留也能自洽）
      const baseline = await api<{
        records: { recordId: string; latest: { metricName: string; metricValue: number }[] }[];
      }>(page, "GET", "/api/analytics/videos/test0001scene/metrics");
      const basePlay =
        baseline.records
          .find((r) => r.recordId === douyin?.id)
          ?.latest.find((m) => m.metricName === "play_count")?.metricValue ?? null;
      const csv = [
        "作品ID,发布时间,作品标题,账号,播放量,点赞量",
        // 行1：作品 ID 精确一致 + 时间容差内 → unique
        `${vid1},${anchorIso} 12:49:40,机场英语 错过登机怎么办,E2E账号,12345,300`,
        // 行2：ID 对不上、标题非完全一致但发布时间容差内吻合 → account_publish_time 弱证据单候选 → conflict
        // （标题故意与补建记录不完全相同，避免双证据 title_exact_plus_time 把它升级为 unique）
        `8${vidConflict},${anchorIso} 19:50:32,机场英语：错过登机怎么办理赔攻略,E2E账号,800,20`,
        // 行3：完全无关 → unmatched
        `9${vidConflict},${anchorIso} 18:00:00,E2E 无关作品,E2E账号,50,1`,
      ].join("\n");

      await page.goto("/insights/import");
      await uploadCsv(page, "e2e-work.csv", csv);
      await expect(page).toHaveURL(/batch=imp_/); // 等异步写 URL 后再取批次号
      batchId = new URL(page.url()).searchParams.get("batch") ?? "";
      // ── STEP1：强标识判定 + 概要 ──
      const banner = page.getByTestId("granularity-banner");
      await expect(banner).toContainText("作品级 · 强唯一标识");
      await expect(banner).toContainText("非空占比 100.0%");
      await expect(page.getByTestId("import-page")).toContainText("E2E账号"); // 账号数量卡
      await page.getByTestId("import-confirm-granularity").click();
      // ── STEP2：规则 + 预估 + 预匹配 ──
      await expect(page.getByRole("heading", { name: "② 匹配规则" })).toBeVisible();
      await page.getByTestId("rules-save").click();
      await expect(page.getByTestId("estimate-strong")).toHaveText("1");
      await expect(page.getByTestId("estimate-manual")).toHaveText("1");
      await expect(page.getByTestId("estimate-unmatched")).toHaveText("1");
      await page.getByTestId("rules-prematch").click();
      // ── STEP3：五类统计 + 三种裁决 ──
      await expect(page.getByRole("heading", { name: "③ 匹配校验" })).toBeVisible();
      await expect(page.getByTestId("stat-card-unique_match")).toContainText("1");
      await page.getByTestId("review-confirm-all").click();
      await expect(page.getByTestId("stat-card-unique_match")).toContainText("0");
      // 冲突行：候选证据 checklist（行2 时间距冲突目标 22s → 发布容差证据）+ 显式选择
      await page.getByTestId("row-2").click();
      await expect(page.getByTestId(`assign-${created.id}`)).toBeVisible();
      await expect(page.getByTestId("detail-panel")).toContainText("发布时间相差 22 秒");
      await page.getByTestId(`assign-${created.id}`).click();
      await expect(page.getByTestId("stat-card-conflict")).toContainText("0");
      // 未匹配行：忽略
      await page.getByTestId("row-3").click();
      await page.getByTestId("act-ignore").click();
      await expect(page.getByTestId("stat-card-unmatched")).toContainText("0");
      // 刷新恢复：回 STEP3，裁决结果仍在（服务端持久化）
      await page.reload();
      await expect(page.getByRole("heading", { name: "③ 匹配校验" })).toBeVisible();
      await expect(page.getByTestId("row-3")).toContainText("已忽略");
      // ── STEP4：preflight → 提交 → 落库断言 ──
      await page.getByTestId("review-next").click();
      await expect(page.getByTestId("commit-pass")).toBeVisible();
      await expect(page.getByTestId("commit-submit")).toBeEnabled();
      await page.getByTestId("commit-submit").click();
      await expect(page.getByTestId("commit-done")).toBeVisible();
      await expect(page.getByTestId("commit-result")).toContainText("作品级 2");
      expect(batchId).not.toBe("");
      // 落库溯源：fixture 记录播放量被改为 12345
      const metrics = await api<{
        records: { recordId: string; latest: { metricName: string; metricValue: number }[] }[];
      }>(page, "GET", "/api/analytics/videos/test0001scene/metrics");
      const playOf =
        (src: typeof metrics) =>
        (recordId: string): number | undefined =>
          src.records
            .find((r) => r.recordId === recordId)
            ?.latest.find((m) => m.metricName === "play_count")?.metricValue;
      expect(playOf(metrics)(douyin?.id ?? "")).toBe(12345);
      expect(playOf(metrics)(created.id)).toBe(800);
      // ── 回滚：精确恢复到提交前基线（基线值在提交后、回滚前重读，不假设 fixture 干净） ──
      // 注：preimage 是提交瞬间快照，此处基线即提交前库内实际值（首次干净环境为 fixture 12000）
      await page.getByTestId("commit-rollback").click();
      await page.getByRole("button", { name: "确认回滚" }).click();
      await expect(page.getByTestId("commit-rolledback")).toBeVisible();
      const after = await api<{
        records: { recordId: string; latest: { metricName: string; metricValue: number }[] }[];
      }>(page, "GET", "/api/analytics/videos/test0001scene/metrics");
      // 回滚后：新补建记录指标清空（提交前无数据）；fixture 记录恢复到提交前基线
      expect(playOf(after)(created.id)).toBeUndefined();
      expect(playOf(after)(douyin?.id ?? "")).toBe(basePlay);
    } finally {
      // 失败也清理：不留残留数据污染后续运行（2026-09-28 实跑教训）
      if (batchId !== "")
        await api(page, "DELETE", `/api/analytics/import-batches/${batchId}`).catch(
          () => undefined,
        );
      await api(page, "DELETE", `/api/analytics/publish-records/${created.id}`).catch(
        () => undefined,
      );
    }
    expect(errors).toEqual([]);
  });

  test("账号日级红线：判定警示→不进作品匹配→无归属按钮→仅账号级落库与回滚", async ({ page }) => {
    const errors = trackPageErrors(page);
    const records = await api<{ items: RecordItem[] }>(
      page,
      "GET",
      "/api/analytics/publish-records?pageSize=100",
    );
    const bound = records.items.find((r) => r.platformVideoId === "7432123456789012345");
    expect(bound, "fixture 应有固定作品 ID 的抖音记录（先 pnpm docker:test:seed）").toBeDefined();
    const anchorIso = (bound?.publishTime ?? bound?.createdAt ?? "").slice(0, 10);
    const day2 = new Date(`${anchorIso}T00:00:00Z`);
    day2.setUTCDate(day2.getUTCDate() - 1);
    const csv = [
      "日期,账号,播放量,点赞量,评论量",
      `${anchorIso},E2E账号,777001,300,20`,
      `${day2.toISOString().slice(0, 10)},E2E账号,777002,250,18`,
    ].join("\n");
    let batchId = "";
    try {
      await page.goto("/insights/import");
      await uploadCsv(page, "e2e-daily.csv", csv);
      await expect(page).toHaveURL(/batch=imp_/);
      batchId = new URL(page.url()).searchParams.get("batch") ?? "";
      // 红线文案：账号日汇总 + 禁止归属
      const banner = page.getByTestId("granularity-banner");
      await expect(banner).toContainText("账号日汇总");
      await expect(page.getByTestId("account-day-warning")).toContainText("禁止拆分给单个视频");
      await page.getByTestId("import-confirm-granularity").click();
      await expect(page.getByTestId("rules-account-day-note")).toBeVisible();
      await page.getByTestId("rules-save").click();
      await page.getByTestId("rules-prematch").click();
      // 全部行账号日级；批量确认按钮不出现
      await expect(page.getByTestId("stat-card-account_day_level")).toContainText("2");
      await expect(page.getByTestId("review-confirm-all")).toHaveCount(0);
      // 详情面板：绝无 assign/confirm，只有存账号级/忽略
      await page.getByTestId("row-1").click();
      await expect(page.getByTestId("detail-panel")).toContainText("无法精确归属到单条作品");
      await expect(page.locator('[data-testid^="assign-"]')).toHaveCount(0);
      await expect(page.getByTestId("act-confirm")).toHaveCount(0);
      // 服务端第二道闸：API 直接 assign 账号日级行 → 400
      const rows = await api<{ items: { rowId: number }[] }>(
        page,
        "GET",
        `/api/analytics/import-batches/${new URL(page.url()).searchParams.get("batch")}/rows?pageSize=5`,
      );
      const denied = await page.request.fetch(
        `${BASE}/api/analytics/import-batches/${new URL(page.url()).searchParams.get("batch")}/decisions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          data: JSON.stringify({
            action: "assign",
            rowId: rows.items[0]?.rowId,
            videoId: bound?.id,
          }),
        },
      );
      expect(denied.status()).toBe(400);
      // 两行存账号级 → preflight → 提交 → creator_daily 断言
      await page.getByTestId("act-account-day").click();
      await page.getByTestId("row-2").click();
      await page.getByTestId("act-account-day").click();
      await page.getByTestId("review-next").click();
      await expect(page.getByTestId("commit-pass")).toBeVisible();
      await page.getByTestId("commit-submit").click();
      await expect(page.getByTestId("commit-result")).toContainText("账号级 2");
      const daily = await api<{
        items: { date: string; playIncrement: number | null }[];
      }>(page, "GET", `/api/analytics/creator-daily?dateFrom=${day2.toISOString().slice(0, 10)}`);
      expect(daily.items.find((d) => d.date === anchorIso)?.playIncrement).toBe(777001);
      // 回滚 + 清理
      await page.getByTestId("commit-rollback").click();
      await page.getByRole("button", { name: "确认回滚" }).click();
      await expect(page.getByTestId("commit-rolledback")).toBeVisible();
      const afterRollback = await api<{ items: { date: string; playIncrement: number | null }[] }>(
        page,
        "GET",
        `/api/analytics/creator-daily?dateFrom=${anchorIso}`,
      );
      expect(afterRollback.items.find((d) => d.date === anchorIso)?.playIncrement).not.toBe(777001);
    } finally {
      if (batchId !== "")
        await api(page, "DELETE", `/api/analytics/import-batches/${batchId}`).catch(
          () => undefined,
        );
    }
    expect(errors).toEqual([]);
  });
});
