/**
 * 真库不变量测试（docs/21 决策 7）
 *
 * 与 mock 型路由测试的分工：路由测试钉 handler 接线与响应形状，这里钉**真实 SQL 行为**——
 * 外键、级联、唯一键、datetime 精度、派生写入的实际结果。本项目反复出的问题
 * （发布记录没派生、删内容留孤儿、列表超 100 行丢数据）都落在这一层，mock 看不见。
 *
 * 运行前提：DATABASE_URL 指向非生产实例。
 *   pnpm --filter @ai-english/backend test:invariants   （脚本内置 :3307 默认值）
 * 会真写库：夹具 id 统一带 `invtest` 前缀，beforeAll/afterAll 各清一次，进程崩了下次自愈。
 */
import { count, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

/**
 * 依赖 DATABASE_URL 的模块一律延迟加载：`./index` 缺 env 时 fail-fast 抛错，
 * 静态 import 会让不带 env 的 `pnpm test` 整文件变红（而不是干净 skip），连带弄坏 pre-push。
 */
type DbMod = typeof import("./index");
type SchemaMod = typeof import("./schema");
type MetricsMod = typeof import("../services/analytics-metrics.service");
type DerivMod = typeof import("../lib/publish-derivation");
type RouteMod = typeof import("../routes/analytics");

let db: DbMod["db"];
let requireSafeWriteTarget: DbMod["requireSafeWriteTarget"];
let contents: SchemaMod["contents"];
let contentFeatures: SchemaMod["contentFeatures"];
let publishRecords: SchemaMod["publishRecords"];
let uploadMarks: SchemaMod["uploadMarks"];
let videoAnalytics: SchemaMod["videoAnalytics"];
let videoMetrics: SchemaMod["videoMetrics"];
let derivePublishIntent: DerivMod["derivePublishIntent"];
let upsertPublishRecordFromMark: MetricsMod["upsertPublishRecordFromMark"];
let analyticsRoute: RouteMod["analyticsRoute"];

async function loadModules(): Promise<void> {
  const dbMod = await import("./index");
  const schema = await import("./schema");
  const metrics = await import("../services/analytics-metrics.service");
  const derivation = await import("../lib/publish-derivation");
  const routes = await import("../routes/analytics");
  db = dbMod.db;
  requireSafeWriteTarget = dbMod.requireSafeWriteTarget;
  contents = schema.contents;
  contentFeatures = schema.contentFeatures;
  publishRecords = schema.publishRecords;
  uploadMarks = schema.uploadMarks;
  videoAnalytics = schema.videoAnalytics;
  videoMetrics = schema.videoMetrics;
  derivePublishIntent = derivation.derivePublishIntent;
  upsertPublishRecordFromMark = metrics.upsertPublishRecordFromMark;
  analyticsRoute = routes.analyticsRoute;
}

const url = process.env.DATABASE_URL ?? "";
/** 回环 :3306 是生产实例（AGENTS.md 端口口径）；本套件会 INSERT/DELETE，绝不放行 */
const targetsProd = /@(localhost|127\.0\.0\.1|\[::1\]):3306\b/.test(url);
const runnable = url !== "" && !targetsProd;
const dbSuite = runnable ? describe : describe.skip;
const PREFIX = "invtest";

if (targetsProd) {
  describe("生产库保护", () => {
    it("DATABASE_URL 指向生产回环 :3306 —— 本套件拒绝写库", () => {
      expect(runnable).toBe(true);
    });
  });
}

async function seedContent(id: string, title = "不变量夹具"): Promise<void> {
  await db.insert(contents).values({
    id,
    template: "scene_word",
    title,
    level: "CET4",
    targetDuration: 60,
    content: [
      {
        text: "A sample sentence about sample.",
        words: [{ word: "sample", meaning: "示例", level: "CET4" }],
      },
    ],
    words: [{ word: "sample", meaning: "示例", level: "CET4" }],
    style: {},
    voice: {},
    status: "completed",
  });
}

async function seedPublishRecord(id: string, contentId: string, platform = "抖音"): Promise<void> {
  await db.insert(publishRecords).values({
    id,
    contentId,
    platform,
    platformVideoId: `${id}-work`,
    publishTitle: "夹具标题",
    publishTime: new Date("2026-09-20T10:00:00Z"),
    publishStatus: "published",
  });
}

/** 只清自己的行：按 invtest 前缀删，不触碰夹具数据（test0001scene 等）与真实数据 */
async function cleanup(): Promise<void> {
  await db.delete(videoMetrics).where(like(videoMetrics.publishRecordId, `${PREFIX}-%`));
  await db.delete(uploadMarks).where(like(uploadMarks.videoFilename, `${PREFIX}%`));
  await db.delete(publishRecords).where(like(publishRecords.id, `${PREFIX}-%`));
  await db.delete(contents).where(like(contents.id, `${PREFIX}-%`));
}

dbSuite("真库不变量", () => {
  beforeAll(async () => {
    await loadModules();
    expect(() => requireSafeWriteTarget("test:invariants")).not.toThrow();
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("上传标记同事务派生发布记录，字段与标记一致", async () => {
    const cid = `${PREFIX}-c1`;
    const filename = `${PREFIX}-v1.mp4`;
    await seedContent(cid);
    await db.transaction(async (tx) => {
      await tx.insert(uploadMarks).values({
        id: `${PREFIX}-m1`,
        taskId: cid,
        videoFilename: filename,
        platform: "抖音",
        url: "https://www.douyin.com/video/9900000000000000099",
        note: "情景英语四级词汇-第 99 集",
      });
      const outcome = await upsertPublishRecordFromMark(
        tx,
        derivePublishIntent({
          contentId: cid,
          platform: "抖音",
          url: "https://www.douyin.com/video/9900000000000000099",
          videoFilename: filename,
          markedAt: new Date("2026-09-30T10:00:00Z"),
          contentTitle: "不变量夹具",
        }),
      );
      expect(outcome).toBe("created");
    });
    const rows = await db.select().from(publishRecords).where(eq(publishRecords.contentId, cid));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.platform).toBe("抖音");
    expect(rows[0]?.platformVideoId).toBe("9900000000000000099");
    expect(rows[0]?.videoAssetId).toBe(filename);
    expect(rows[0]?.publishTitle).toBe("不变量夹具");
    expect(rows[0]?.publishStatus).toBe("published");
  });

  it("作品 ID 已被别的记录占用时不抢占，也不新增行", async () => {
    const ownerCid = `${PREFIX}-c10`;
    const claimerCid = `${PREFIX}-c11`;
    await seedContent(ownerCid);
    await seedContent(claimerCid);
    await db.insert(publishRecords).values({
      id: `${PREFIX}-p10`,
      contentId: ownerCid,
      platform: "抖音",
      platformVideoId: "9900000000000000088",
      publishStatus: "published",
    });
    const outcome = await upsertPublishRecordFromMark(
      db,
      derivePublishIntent({
        contentId: claimerCid,
        platform: "抖音",
        url: "https://www.douyin.com/video/9900000000000000088",
        videoFilename: `${PREFIX}-v10.mp4`,
        markedAt: new Date("2026-09-30T10:00:00Z"),
        contentTitle: "抢占者",
      }),
    );
    expect(outcome).toBe("conflict-work-id-owned");
    const owner = await db
      .select()
      .from(publishRecords)
      .where(eq(publishRecords.id, `${PREFIX}-p10`));
    expect(owner[0]?.contentId).toBe(ownerCid);
    const claimed = await db
      .select({ id: publishRecords.id })
      .from(publishRecords)
      .where(eq(publishRecords.contentId, claimerCid));
    expect(claimed).toHaveLength(0);
  });

  it("重复派生不新增行，也不把人工登记的值覆盖掉", async () => {
    const cid = `${PREFIX}-c2`;
    await seedContent(cid);
    await db.insert(publishRecords).values({
      id: `${PREFIX}-p2`,
      contentId: cid,
      platform: "快手",
      platformVideoId: "HUMAN-999",
      publishTitle: "人工登记标题",
      publishTime: new Date("2026-09-01T00:00:00Z"),
      publishStatus: "published",
    });
    await upsertPublishRecordFromMark(
      db,
      derivePublishIntent({
        contentId: cid,
        platform: "快手",
        url: "https://www.kuaishou.com/short-video/AUTO-111",
        videoFilename: `${PREFIX}-v2.mp4`,
        markedAt: new Date("2026-09-25T08:00:00Z"),
        contentTitle: "不变量夹具",
      }),
    );
    const rows = await db.select().from(publishRecords).where(eq(publishRecords.contentId, cid));
    expect(rows).toHaveLength(1);
    // 派生只补空位：作品 ID 与人工标题是事实性字段，不许被推导值改写
    expect(rows[0]?.platformVideoId).toBe("HUMAN-999");
    expect(rows[0]?.publishTitle).toBe("人工登记标题");
  });

  it("未绑定生成记录的标记不派生（不造 contentId 孤儿记录）", async () => {
    const intent = derivePublishIntent({
      contentId: null,
      platform: "B站",
      url: null,
      videoFilename: `${PREFIX}-v3.mp4`,
      markedAt: new Date(),
      contentTitle: null,
    });
    expect(intent).toBeNull();
    const outcome = await upsertPublishRecordFromMark(db, intent);
    expect(outcome).toBe("skipped-no-content");
    const rows = await db
      .select({ id: publishRecords.id })
      .from(publishRecords)
      .where(like(publishRecords.platform, "B站"));
    expect(rows.filter((r) => r.id.startsWith(PREFIX))).toHaveLength(0);
  });

  it("FK 拒绝指向不存在内容的发布记录", async () => {
    await expect(
      db.insert(publishRecords).values({
        id: `${PREFIX}-p4`,
        contentId: `${PREFIX}-不存在的內容`,
        platform: "抖音",
        publishStatus: "published",
      }),
    ).rejects.toMatchObject({ code: "ER_NO_REFERENCED_ROW_2" });
  });

  it("删除内容级联带走发布记录、指标与配置", async () => {
    const cid = `${PREFIX}-c5`;
    await seedContent(cid);
    await seedPublishRecord(`${PREFIX}-p5`, cid);
    await db.insert(videoMetrics).values({
      publishRecordId: `${PREFIX}-p5`,
      metricName: "play_count",
      metricValue: 12000,
      sourceType: "CREATOR_IMPORT",
    });
    await db.insert(videoAnalytics).values({ contentId: cid, storyTopic: "级联", allowSave: 1 });
    await db
      .insert(contentFeatures)
      .values({ contentId: cid, template: "scene_word", level: "CET4" });

    await db.delete(contents).where(eq(contents.id, cid));

    await expect(
      db.select().from(publishRecords).where(eq(publishRecords.contentId, cid)),
    ).resolves.toHaveLength(0);
    await expect(
      db
        .select()
        .from(videoMetrics)
        .where(eq(videoMetrics.publishRecordId, `${PREFIX}-p5`)),
    ).resolves.toHaveLength(0);
    await expect(
      db.select().from(videoAnalytics).where(eq(videoAnalytics.contentId, cid)),
    ).resolves.toHaveLength(0);
    await expect(
      db.select().from(contentFeatures).where(eq(contentFeatures.contentId, cid)),
    ).resolves.toHaveLength(0);
  });

  it("同一发布记录的同一指标只有一条（唯一键，不静默覆盖）", async () => {
    const cid = `${PREFIX}-c6`;
    await seedContent(cid);
    await seedPublishRecord(`${PREFIX}-p6`, cid);
    await db.insert(videoMetrics).values({
      publishRecordId: `${PREFIX}-p6`,
      metricName: "completion_rate",
      metricValue: 0.36,
      sourceType: "CREATOR_IMPORT",
    });
    await expect(
      db.insert(videoMetrics).values({
        publishRecordId: `${PREFIX}-p6`,
        metricName: "completion_rate",
        metricValue: 0.99,
        sourceType: "CREATOR_IMPORT",
      }),
    ).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
    const rows = await db
      .select()
      .from(videoMetrics)
      .where(eq(videoMetrics.publishRecordId, `${PREFIX}-p6`));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metricValue).toBe(0.36);
  });

  it("未回填作品 ID 的记录可同平台多条并存（唯一键不去重）", async () => {
    const cid = `${PREFIX}-c7`;
    await seedContent(cid);
    await db.insert(publishRecords).values([
      { id: `${PREFIX}-p7a`, contentId: cid, platform: "视频号", publishStatus: "published" },
      { id: `${PREFIX}-p7b`, contentId: cid, platform: "视频号", publishStatus: "published" },
    ]);
    const rows = await db.select().from(publishRecords).where(eq(publishRecords.contentId, cid));
    expect(rows).toHaveLength(2);
    // 钉住这条陷阱：对账/导入匹配都不许依赖 (platform, platform_video_id) 唯一键去重
    expect(rows.every((r) => r.platformVideoId === null)).toBe(true);
  });

  it("publish_at 走 datetime：>2038 的时间原样往返", async () => {
    const cid = `${PREFIX}-c8`;
    await seedContent(cid);
    const at = new Date("2039-06-15T10:20:00Z");
    await db.insert(videoAnalytics).values({ contentId: cid, publishAt: at, allowSave: 0 });
    const rows = await db.select().from(videoAnalytics).where(eq(videoAnalytics.contentId, cid));
    expect(rows[0]?.publishAt?.toISOString()).toBe(at.toISOString());
  });

  it("contents.id 事实不可变（子表 FK 无 ON UPDATE CASCADE）", async () => {
    const cid = `${PREFIX}-c9`;
    await seedContent(cid);
    await seedPublishRecord(`${PREFIX}-p9`, cid);
    await expect(
      db
        .update(contents)
        .set({ id: `${PREFIX}-c9x` })
        .where(eq(contents.id, cid)),
    ).rejects.toMatchObject({ code: "ER_ROW_IS_REFERENCED_2" });
  });

  it("视频表现列表：服务端 total 与库内计数一致，超过一页不丢行", async () => {
    for (let i = 0; i < 120; i += 1) {
      await seedContent(`${PREFIX}-cb${i}`, `分页夹具 ${i}`);
      await seedPublishRecord(`${PREFIX}-pb${i}`, `${PREFIX}-cb${i}`);
    }
    const [dbRow] = await db.select({ c: count() }).from(publishRecords);
    const realTotal = Number(dbRow?.c ?? -1);

    const bodySchema = z.object({
      items: z.array(z.object({ recordId: z.string() })),
      total: z.number(),
      page: z.number(),
      pageSize: z.number(),
      unregisteredContentCount: z.number(),
    });
    const page1 = bodySchema.parse(
      await (await analyticsRoute.request("/videos?page=1&pageSize=100")).json(),
    );
    const page2 = bodySchema.parse(
      await (await analyticsRoute.request("/videos?page=2&pageSize=100")).json(),
    );
    // 历史缺陷：列表硬顶 100 条，超出的行被静默吞掉；total 与逐页条数之和都要对得上库
    expect(realTotal).toBeGreaterThan(100);
    expect(page1.total).toBe(realTotal);
    expect(page1.items).toHaveLength(100);
    expect(page1.items.length + page2.items.length).toBe(realTotal);
  });
});
