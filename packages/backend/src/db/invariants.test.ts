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
import { and, count, eq, gt, like, sql } from "drizzle-orm";
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
let analysisResults: SchemaMod["analysisResults"];
let importBatch: SchemaMod["importBatch"];
let matchDecision: SchemaMod["matchDecision"];
let recommendationApplications: SchemaMod["recommendationApplications"];
let recommendations: SchemaMod["recommendations"];
let importRow: SchemaMod["importRow"];
let matchCandidate: SchemaMod["matchCandidate"];
let experiments: SchemaMod["experiments"];
let experimentAssignments: SchemaMod["experimentAssignments"];
let derivePublishIntent: DerivMod["derivePublishIntent"];
let importedPublishTimePatch: DerivMod["importedPublishTimePatch"];
let upsertPublishRecordFromMark: MetricsMod["upsertPublishRecordFromMark"];
let createPublishRecord: MetricsMod["createPublishRecord"];
type EvidenceMod = typeof import("../services/analytics-recommend-evidence.service");
type RecommendMod = typeof import("../services/analytics-recommend.service");
let recordApplication: EvidenceMod["recordRecommendationApplication"];
let bindApplication: EvidenceMod["bindRecommendationApplication"];
let generateRecommendations: RecommendMod["generateRecommendations"];
type AssignMod = typeof import("../services/analytics-experiment-assignment.service");
type ExpMod = typeof import("../services/analytics-experiment.service");
let createAssignment: AssignMod["createExperimentAssignment"];
let bindAssignment: AssignMod["bindExperimentAssignment"];
let listAssignments: AssignMod["listExperimentAssignments"];
let loadGroups: AssignMod["loadAssignmentGroups"];
let evaluateExperimentById: ExpMod["evaluateExperimentById"];
let backfillMissingPublishTime: MetricsMod["backfillMissingPublishTime"];
let analyticsRoute: RouteMod["analyticsRoute"];

async function loadModules(): Promise<void> {
  const dbMod = await import("./index");
  const schema = await import("./schema");
  const metrics = await import("../services/analytics-metrics.service");
  const derivation = await import("../lib/publish-derivation");
  const routes = await import("../routes/analytics");
  const evidence = await import("../services/analytics-recommend-evidence.service");
  const recommend = await import("../services/analytics-recommend.service");
  generateRecommendations = recommend.generateRecommendations;
  const assign = await import("../services/analytics-experiment-assignment.service");
  const exp = await import("../services/analytics-experiment.service");
  createAssignment = assign.createExperimentAssignment;
  bindAssignment = assign.bindExperimentAssignment;
  listAssignments = assign.listExperimentAssignments;
  loadGroups = assign.loadAssignmentGroups;
  evaluateExperimentById = exp.evaluateExperimentById;
  recordApplication = evidence.recordRecommendationApplication;
  bindApplication = evidence.bindRecommendationApplication;
  db = dbMod.db;
  requireSafeWriteTarget = dbMod.requireSafeWriteTarget;
  contents = schema.contents;
  contentFeatures = schema.contentFeatures;
  publishRecords = schema.publishRecords;
  uploadMarks = schema.uploadMarks;
  videoAnalytics = schema.videoAnalytics;
  videoMetrics = schema.videoMetrics;
  analysisResults = schema.analysisResults;
  importBatch = schema.importBatch;
  matchDecision = schema.matchDecision;
  recommendationApplications = schema.recommendationApplications;
  recommendations = schema.recommendations;
  importRow = schema.importRow;
  matchCandidate = schema.matchCandidate;
  experiments = schema.experiments;
  experimentAssignments = schema.experimentAssignments;
  derivePublishIntent = derivation.derivePublishIntent;
  importedPublishTimePatch = derivation.importedPublishTimePatch;
  upsertPublishRecordFromMark = metrics.upsertPublishRecordFromMark;
  createPublishRecord = metrics.createPublishRecord;
  backfillMissingPublishTime = metrics.backfillMissingPublishTime;
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

/** 带真实成片的内容（统一内容视图默认只放行有产物的行） */
async function seedContentWithVideo(id: string, createdOffsetDays = 0): Promise<void> {
  const at = new Date(Date.UTC(2026, 8, 20 - createdOffsetDays, 10, 0, 0));
  await db.insert(contents).values({
    id,
    template: "scene_word",
    title: `统一视图夹具 ${id}`,
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
    video: { url: `/files/video/${id}.mp4` },
    status: "completed",
    createdAt: at,
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

/**
 * 因子/建议生成链路的样本夹具：一条有发布记录、有生产特征、有完播率的真实行。
 * 时间取 45 天前：落在推荐默认 90 天窗口内，同时远离看板 7/30 天窗口（不影响其他用例的合计）。
 */
async function seedFactorSample(
  key: string,
  platform: string,
  hook: string,
  completion: number,
): Promise<void> {
  const cid = `${PREFIX}-${key}`;
  const rid = `${PREFIX}-${key}r`;
  const at = new Date(Date.now() - 45 * 86_400_000);
  await db.insert(contents).values({
    id: cid,
    template: "scene_word",
    title: `因子夹具 ${key}`,
    level: "CET4",
    targetDuration: 45,
    content: [],
    words: [],
    style: {},
    voice: {},
    status: "completed",
    createdAt: at,
    updatedAt: at,
  });
  await db.insert(publishRecords).values({
    id: rid,
    contentId: cid,
    platform,
    platformVideoId: `${PREFIX}-${key}-work`,
    publishTitle: `因子夹具 ${key}`,
    publishTime: at,
    publishStatus: "published",
  });
  await db.insert(contentFeatures).values({
    contentId: cid,
    template: "scene_word",
    level: "CET4",
    duration: 45,
    segmentCount: 6,
    speechRate: 1,
    hook,
  });
  await db.insert(videoMetrics).values({
    publishRecordId: rid,
    metricName: "completion_rate",
    metricValue: completion,
    sourceType: "CREATOR_IMPORT",
    sourceField: "完播率",
    dataDate: at.toISOString().slice(0, 10),
  });
}

/** analysis_result 是自增主键、没有前缀可匹配：用「本次之前的最大 id」划出本次范围 */
async function latestSnapshotId(): Promise<number> {
  const [row] = await db
    .select({ m: sql<number>`coalesce(max(${analysisResults.id}), 0)` })
    .from(analysisResults);
  return Number(row?.m ?? 0);
}

function recValue(recommendation: unknown): string {
  if (typeof recommendation === "object" && recommendation !== null && "value" in recommendation) {
    return String(recommendation.value);
  }
  return "";
}

function snapshotPlatform(result: unknown): string {
  if (typeof result !== "object" || result === null || !("scope" in result)) return "";
  const scope = result.scope;
  if (typeof scope !== "object" || scope === null || !("platform" in scope)) return "";
  return String(scope.platform);
}

/** 只清自己的行：按 invtest 前缀删，不触碰夹具数据（test0001scene 等）与真实数据 */
async function cleanup(): Promise<void> {
  await db.delete(videoMetrics).where(like(videoMetrics.publishRecordId, `${PREFIX}-%`));
  // 批次夹具的冲突候选：match_candidate → import_row → import_batch 是 cascade，
  // 但按前缀显式删一遍更稳（不依赖删除顺序）
  await db.delete(matchCandidate).where(like(matchCandidate.videoId, `${PREFIX}-%`));
  await db.delete(importRow).where(like(importRow.batchId, `${PREFIX}-%`));
  await db.delete(importBatch).where(like(importBatch.id, `${PREFIX}-%`));
  // 批次二：采纳记录按它归属的建议清（它的 id 是随机 recapp_ 前缀，没法按 id 前缀删）；
  // 建议行本身按前缀删。analysis_result 是自增主键、没有前缀，由用例自己收尾。
  await db
    .delete(recommendationApplications)
    .where(like(recommendationApplications.recommendationId, `${PREFIX}-%`));
  await db.delete(recommendations).where(like(recommendations.id, `${PREFIX}-%`));
  // 批次三：experiment_assignments 没有外键（理由见 schema.ts），必须显式删，不能指望级联
  await db
    .delete(experimentAssignments)
    .where(like(experimentAssignments.experimentId, `${PREFIX}-%`));
  await db.delete(experiments).where(like(experiments.id, `${PREFIX}-%`));
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
    // 上面的用例跑过 generateRecommendations()，它开头就会删掉全部未处理建议；夹具删完再不管，
    // 共享测试栈的页面 D 就空了（而且留下的建议引用的样本行已被删）。按剩余真实数据重新生成一次，
    // 让留下的派生数据与库内事实一致。
    await generateRecommendations();
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

  // ── 批次一：发布时间来源（docs/22 §4.1）在真库上的实际行为 ──

  it("新建发布记录未填时间 → 用 contents.created_at 兜底并标 LOCAL_GENERATED", async () => {
    const cid = `${PREFIX}-pt1`;
    await seedContentWithVideo(cid);
    const result = await createPublishRecord({ contentId: cid, platform: "抖音" });
    expect(result.kind).toBe("created");
    const [row] = await db
      .select()
      .from(publishRecords)
      .where(eq(publishRecords.contentId, cid))
      .limit(1);
    const [contentRow] = await db
      .select({ createdAt: contents.createdAt })
      .from(contents)
      .where(eq(contents.id, cid))
      .limit(1);
    // 兜底值必须逐字等于生成事实，不接受「现在」或猜测时间
    expect(row?.publishTime?.toISOString()).toBe(contentRow?.createdAt?.toISOString());
    expect(row?.publishTimeSource).toBe("LOCAL_GENERATED");
  });

  it("人工填的时间标 USER_EDITED，导入的平台真实时间可覆盖 LOCAL_GENERATED 但不覆盖 USER_EDITED", async () => {
    const manualCid = `${PREFIX}-pt2`;
    const localCid = `${PREFIX}-pt3`;
    await seedContentWithVideo(manualCid);
    await seedContentWithVideo(localCid, 1);
    const manual = await createPublishRecord({
      contentId: manualCid,
      platform: "抖音",
      publishTime: "2026-09-10T01:00:00.000Z",
    });
    const local = await createPublishRecord({ contentId: localCid, platform: "抖音" });
    expect(manual.kind).toBe("created");
    expect(local.kind).toBe("created");
    const [manualRow] = await db
      .select()
      .from(publishRecords)
      .where(eq(publishRecords.id, manual.kind === "created" ? manual.id : ""))
      .limit(1);
    expect(manualRow?.publishTimeSource).toBe("USER_EDITED");

    const importedAt = new Date("2026-09-11T05:30:00.000Z");
    // LOCAL_GENERATED 那条：判据走生产同一纯函数，真库只验它落到列上的结果
    const localId = local.kind === "created" ? local.id : "";
    const [localBefore] = await db
      .select()
      .from(publishRecords)
      .where(eq(publishRecords.id, localId))
      .limit(1);
    const patch = importedPublishTimePatch(
      {
        publishTime: localBefore?.publishTime ?? null,
        publishTimeSource: localBefore?.publishTimeSource ?? null,
      },
      importedAt,
    );
    expect(patch).not.toBeNull();
    await db
      .update(publishRecords)
      .set({ ...patch })
      .where(eq(publishRecords.id, localId));
    const [localAfter] = await db
      .select()
      .from(publishRecords)
      .where(eq(publishRecords.id, localId))
      .limit(1);
    expect(localAfter?.publishTime?.toISOString()).toBe(importedAt.toISOString());
    expect(localAfter?.publishTimeSource).toBe("PLATFORM_IMPORTED");

    // 同一条导入时间打到 USER_EDITED 记录上：不覆盖
    const manualId = manual.kind === "created" ? manual.id : "";
    const [manualCurrent] = await db
      .select()
      .from(publishRecords)
      .where(eq(publishRecords.id, manualId))
      .limit(1);
    expect(
      importedPublishTimePatch(
        {
          publishTime: manualCurrent?.publishTime ?? null,
          publishTimeSource: manualCurrent?.publishTimeSource ?? null,
        },
        importedAt,
      ),
    ).toBeNull();
  });

  it("历史空发布时间回填只补空值，且第二次执行零变更（幂等；整体回滚不留副作用）", async () => {
    const cid = `${PREFIX}-pt4`;
    const otherCid = `${PREFIX}-pt5`;
    await seedContentWithVideo(cid);
    await seedContentWithVideo(otherCid, 1);
    await db.insert(publishRecords).values([
      { id: `${PREFIX}-pt4r`, contentId: cid, platform: "抖音", publishStatus: "published" },
      {
        id: `${PREFIX}-pt5r`,
        contentId: otherCid,
        platform: "快手",
        publishStatus: "published",
        publishTime: new Date("2026-09-01T00:00:00.000Z"),
        publishTimeSource: "USER_EDITED",
      },
    ]);

    const dry = await backfillMissingPublishTime(false);
    expect(dry.applied).toBe(false);
    expect(dry.updated).toBe(0);
    expect(dry.nullTimeRecords).toBeGreaterThanOrEqual(1);
    expect(dry.backfillable).toBe(dry.nullTimeRecords);

    // 回填会碰到库里其他人的历史空值行，所以整段放在一个回滚的事务里：
    // 断言真实 SQL 行为，但不给测试库留下副作用（脚本级演练见 docs/22 §4.4 的交付记录）
    const ROLLBACK = "invtest-backfill-rollback";
    await expect(
      db.transaction(async (tx) => {
        const first = await backfillMissingPublishTime(true, tx);
        expect(first.updated).toBe(first.backfillable);
        expect(first.updated).toBeGreaterThanOrEqual(1);
        const [filled] = await tx
          .select()
          .from(publishRecords)
          .where(eq(publishRecords.id, `${PREFIX}-pt4r`))
          .limit(1);
        expect(filled?.publishTimeSource).toBe("LOCAL_GENERATED");
        expect(filled?.publishTime).not.toBeNull();
        // 已有人工时间的那条不被改写
        const [kept] = await tx
          .select()
          .from(publishRecords)
          .where(eq(publishRecords.id, `${PREFIX}-pt5r`))
          .limit(1);
        expect(kept?.publishTime?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
        expect(kept?.publishTimeSource).toBe("USER_EDITED");

        // 幂等：回填后不再满足 IS NULL，第二次零变更
        const second = await backfillMissingPublishTime(true, tx);
        expect(second.updated).toBe(0);
        throw new Error(ROLLBACK);
      }),
    ).rejects.toThrow(ROLLBACK);

    // 事务已回滚：夹具那条空时间记录仍是 NULL（证明上面的写入没逃逸到库里）
    const [after] = await db
      .select()
      .from(publishRecords)
      .where(eq(publishRecords.id, `${PREFIX}-pt4r`))
      .limit(1);
    expect(after?.publishTime).toBeNull();
  });

  // ── 批次一：统一内容主视图（docs/22 §5.1）在真库上的行集行为 ──

  const contentVideosSchema = z.object({
    items: z.array(
      z.object({
        contentId: z.string(),
        status: z.string(),
        localStatus: z.string(),
        platformCount: z.number(),
        metricCoverage: z.object({
          platforms: z.number(),
          records: z.number(),
          recordsWithMetrics: z.number(),
        }),
        platforms: z.array(
          z.object({
            recordId: z.string(),
            platform: z.string(),
            publishTimeSource: z.string().nullable(),
            metricCount: z.number(),
            hasImportConflict: z.boolean(),
            metrics: z.record(
              z.object({ value: z.number(), sourceType: z.string(), isEstimated: z.boolean() }),
            ),
          }),
        ),
      }),
    ),
    total: z.number(),
    page: z.number(),
    pageSize: z.number(),
  });

  async function fetchContentVideos(qs = ""): Promise<z.infer<typeof contentVideosSchema>> {
    const res = await analyticsRoute.request(`/content-videos${qs}`);
    expect(res.status).toBe(200);
    return contentVideosSchema.parse(await res.json());
  }

  it("有成片但没有发布记录 → 仍有一行，platforms=[]，状态 unpublished（不造 local 伪平台）", async () => {
    const cid = `${PREFIX}-cv1`;
    await seedContentWithVideo(cid);
    const page = await fetchContentVideos("?platform=抖音&pageSize=100&sort=created_time");
    const row = page.items.find((i) => i.contentId === cid);
    expect(row).toBeDefined();
    expect(row?.platforms).toEqual([]);
    expect(row?.status).toBe("unpublished");
    expect(row?.platformCount).toBe(0);
    // platforms 是严格对象：任何 local 伪平台记录都只会以多一条明细的形式出现，这里必须是空数组
    expect(row?.metricCoverage).toEqual({ platforms: 0, records: 0, recordsWithMetrics: 0 });
  });

  it("同一内容两个平台 → 只有一行，两个平台在明细里各自带指标，主行不做相加", async () => {
    const cid = `${PREFIX}-cv2`;
    await seedContentWithVideo(cid);
    await seedPublishRecord(`${PREFIX}-cv2a`, cid, "抖音");
    await seedPublishRecord(`${PREFIX}-cv2b`, cid, "快手");
    await db.insert(videoMetrics).values([
      {
        publishRecordId: `${PREFIX}-cv2a`,
        metricName: "play_count",
        metricValue: 1000,
        sourceType: "CREATOR_IMPORT",
      },
      {
        publishRecordId: `${PREFIX}-cv2b`,
        metricName: "play_count",
        metricValue: 300,
        sourceType: "CREATOR_IMPORT",
      },
    ]);
    const page = await fetchContentVideos("?pageSize=100&sort=created_time");
    const matched = page.items.filter((i) => i.contentId === cid);
    // 一内容一行：两平台不得拆成两行
    expect(matched).toHaveLength(1);
    const row = matched[0];
    expect(row?.platforms).toHaveLength(2);
    expect(row?.platformCount).toBe(2);
    expect(row?.metricCoverage.recordsWithMetrics).toBe(2);
    const byPlatform = new Map(row?.platforms.map((p) => [p.platform, p.metrics.play_count]));
    expect(byPlatform.get("抖音")).toMatchObject({ value: 1000 });
    expect(byPlatform.get("快手")).toMatchObject({ value: 300 });
    // 主行严格对象（schema .strict() 已拒任何多余字段），因此不存在 1300 这个合计值
    expect(JSON.stringify(row)).not.toContain("1300");
  });

  it("内容没有任何导入指标 → metrics 是空对象，不补 0", async () => {
    const cid = `${PREFIX}-cv3`;
    await seedContentWithVideo(cid);
    await seedPublishRecord(`${PREFIX}-cv3a`, cid, "视频号");
    const page = await fetchContentVideos("?pageSize=100&sort=created_time");
    const row = page.items.find((i) => i.contentId === cid);
    expect(row?.status).toBe("published_unimported");
    expect(row?.platforms[0]?.metrics).toEqual({});
    expect(row?.platforms[0]?.metricCount).toBe(0);
  });

  it("默认列表只放已完成且有成片的内容；status=failed 可扩大行集", async () => {
    const draftCid = `${PREFIX}-cv4`;
    const failedCid = `${PREFIX}-cv5`;
    await seedContent(draftCid);
    await db.insert(contents).values({
      id: failedCid,
      template: "scene_word",
      title: "失败夹具",
      level: "CET4",
      targetDuration: 60,
      content: [],
      words: [],
      style: {},
      voice: {},
      status: "failed",
    });
    const def = await fetchContentVideos("?pageSize=100");
    expect(def.items.some((i) => i.contentId === draftCid)).toBe(false);
    expect(def.items.some((i) => i.contentId === failedCid)).toBe(false);
    const failed = await fetchContentVideos("?status=failed&pageSize=100");
    const row = failed.items.find((i) => i.contentId === failedCid);
    expect(row?.status).toBe("failed");
    expect(row?.localStatus).toBe("failed");
  });

  it("导入冲突判据来自中间层：conflict 行把该记录列为候选 → status=import_conflict", async () => {
    const cid = `${PREFIX}-cv6`;
    await seedContentWithVideo(cid);
    await seedPublishRecord(`${PREFIX}-cv6a`, cid, "抖音");
    // 判据不许是猜的：冲突只存在于 import_row.match_status + match_candidate，
    // 因此这里真造一条待裁决的冲突行与候选，再验筛选命中（不新增冲突列、不靠 LLM 判归属）
    await db.insert(importBatch).values({
      id: `${PREFIX}-cv6b`,
      filename: "conflict.csv",
      fileSize: 10,
      fileHash: `${PREFIX}-hash`,
      platform: "抖音",
      rowCount: 1,
      dataGranularity: "work_level_strong",
      granularityEvidence: { note: "不变量夹具" },
      headers: ["作品ID"],
      fieldDetection: [],
      status: "prematched",
    });
    await db.insert(importRow).values({
      batchId: `${PREFIX}-cv6b`,
      rowNumber: 1,
      rawData: { 作品ID: "x" },
      normalizedData: { platformWorkId: "x" },
      dataGranularity: "work_level_strong",
      matchStatus: "conflict",
    });
    // MySQL 的 insert 没有 returning，按 (batch_id,row_number) 唯一键把自增 id 取回来
    const [seededRow] = await db
      .select({ id: importRow.id })
      .from(importRow)
      .where(and(eq(importRow.batchId, `${PREFIX}-cv6b`), eq(importRow.rowNumber, 1)))
      .limit(1);
    expect(seededRow).toBeDefined();
    await db.insert(matchCandidate).values({
      importRowId: seededRow?.id ?? 0,
      videoId: `${PREFIX}-cv6a`,
      matchMethod: "platform_work_id_exact",
      matchScore: 1,
      evidence: { platformWorkIdExact: true },
      rank: 1,
    });

    const conflicted = await fetchContentVideos("?status=import_conflict&pageSize=100");
    expect(conflicted.items.map((i) => i.contentId)).toContain(cid);
    const row0 = conflicted.items.find((i) => i.contentId === cid);
    expect(row0?.status).toBe("import_conflict");
    expect(row0?.platforms[0]?.hasImportConflict).toBe(true);
    // 未筛冲突时，同一行仍按「已有指标/待导入」如实展示，不因为冲突就从默认口径里消失
    const all = await fetchContentVideos("?pageSize=100");
    expect(all.items.some((i) => i.contentId === cid)).toBe(true);
  });

  it("统一内容视图 total 与库内符合口径的内容数一致，翻页不丢内容", async () => {
    const page1 = await fetchContentVideos("?pageSize=1&sort=created_time&order=desc");
    const [dbRow] = await db
      .select({ n: count() })
      .from(contents)
      .where(and(eq(contents.status, "completed"), sql`${contents.video} is not null`));
    expect(page1.total).toBe(Number(dbRow?.n ?? -1));
    expect(page1.items).toHaveLength(1);
  });

  // ── 批次二：建议证据链与采纳记录（docs/22 §4.2 / §5.2）在真库上贯通 ──

  it("建议证据可追到因子快照 → 参与视频 → 指标 provenance → 导入原始行与字段名", async () => {
    const cid = `${PREFIX}-ev1`;
    const recordId = `${PREFIX}-ev1r`;
    const batchId = `${PREFIX}-ev1b`;
    await seedContentWithVideo(cid);
    await seedPublishRecord(recordId, cid, "抖音");
    await db.insert(importBatch).values({
      id: batchId,
      filename: "抖音导出.csv",
      fileSize: 128,
      fileHash: `${PREFIX}-evhash`,
      platform: "抖音",
      rowCount: 1,
      dataGranularity: "work_level_strong",
      granularityEvidence: { note: "不变量夹具" },
      headers: ["视频名称", "播放量"],
      fieldDetection: [],
      status: "committed",
    });
    await db.insert(importRow).values({
      batchId,
      rowNumber: 7,
      rawData: { 视频名称: "不变量夹具", 播放量: "1234" },
      normalizedData: { views: 1234 },
      dataGranularity: "work_level_strong",
      matchStatus: "confirmed",
    });
    // 自增 id 回查（match_decision 主键需要它）
    const [seededImportRow] = await db
      .select({ id: importRow.id })
      .from(importRow)
      .where(and(eq(importRow.batchId, batchId), eq(importRow.rowNumber, 7)))
      .limit(1);
    await db.insert(matchDecision).values({
      importRowId: seededImportRow?.id ?? 0,
      batchId,
      matchStatus: "confirmed",
      matchedVideoId: recordId,
      matchMethod: "platform_work_id_exact",
      decisionType: "operator_confirm",
    });
    await db.insert(videoMetrics).values({
      publishRecordId: recordId,
      metricName: "completion_rate",
      metricValue: 0.42,
      sourceType: "CREATOR_IMPORT",
      sourceField: "完播率",
      dataDate: "2026-10-01",
      metadata: { batch_id: batchId, import_row: 7, matched_by: "operator_confirm" },
    });
    await db.insert(analysisResults).values({
      analysisType: "factors:completion_rate",
      subjectId: null,
      result: {
        metric: "completion_rate",
        accountMedian: 0.42,
        accountSampleCount: 1,
        accountRealSampleCount: 1,
        scope: { platform: "抖音", windowDays: 90 },
        mixedPlatform: false,
        platforms: ["抖音"],
        dimensions: [
          {
            dimension: "hook",
            groups: [
              {
                value: "mistake",
                sampleCount: 1,
                realSampleCount: 1,
                median: 0.42,
                mean: 0.42,
                diff: 0,
                lowSample: true,
                recordIds: [recordId],
              },
            ],
          },
        ],
        note: "夹具",
      },
      evidence: { totalRecords: 1, scope: { platform: "抖音", windowDays: 90 } },
      modelVersion: "group-stats-v1",
    });
    // MySQL 的 drizzle insert 没有 returning：按自增 id 回查本次快照
    const [snapshot] = await db
      .select({ id: analysisResults.id })
      .from(analysisResults)
      .where(eq(analysisResults.analysisType, "factors:completion_rate"))
      .orderBy(sql`${analysisResults.id} desc`)
      .limit(1);
    const recId = `${PREFIX}-ev1rec`;
    await db.insert(recommendations).values({
      id: recId,
      recommendationType: "hook",
      recommendation: { value: "mistake", label: "错误示范", kindLabel: "推荐 Hook" },
      reason: "抖音 · 近 90 天 · 夹具建议",
      sourceSampleCount: 1,
      sourceMetric: "completion_rate",
      analysisResultId: snapshot?.id ?? null,
    });

    const res = await analyticsRoute.request(`/recommendations/${recId}/evidence`);
    expect(res.status).toBe(200);
    const evidence = await res.json();
    expect(evidence.status).toBe("traceable");
    expect(evidence.analysisResultId).toBe(snapshot?.id);
    expect(evidence.groups[0]).toMatchObject({
      dimension: "hook",
      value: "mistake",
      sampleCount: 1,
    });
    const video = evidence.videos.find((v: { recordId: string }) => v.recordId === recordId);
    expect(video).toBeDefined();
    // 追到字段名层级
    expect(video.metrics.completion_rate).toMatchObject({
      value: 0.42,
      sourceType: "CREATOR_IMPORT",
      sourceField: "完播率",
      batchId,
      importRowNumber: 7,
    });
    // 追到原始行
    expect(evidence.importRows).toHaveLength(1);
    expect(evidence.importRows[0]).toMatchObject({
      batchId,
      rowNumber: 7,
      filename: "抖音导出.csv",
      decisionType: "operator_confirm",
    });
    expect(evidence.importRows[0].rawData).toMatchObject({ 播放量: "1234" });
    // analysis_result 是自增主键、没有 invtest 前缀可匹配，用例内自行收尾
    if (snapshot?.id !== undefined) {
      await db.delete(analysisResults).where(eq(analysisResults.id, snapshot.id));
    }
  });

  it("建议不存在 → 404；无快照的历史建议 → evidence_unavailable（不拼一份看起来完整的证据）", async () => {
    const missing = await analyticsRoute.request("/recommendations/rec_does_not_exist/evidence");
    expect(missing.status).toBe(404);
    const legacyId = `${PREFIX}-ev2rec`;
    await db.insert(recommendations).values({
      id: legacyId,
      recommendationType: "hook",
      recommendation: { value: "mistake", label: "错误示范", kindLabel: "推荐 Hook" },
      reason: "历史建议（本列引入前产出，没有快照锚点）",
      sourceSampleCount: 9,
      sourceMetric: "completion_rate",
    });
    const res = await analyticsRoute.request(`/recommendations/${legacyId}/evidence`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("evidence_unavailable");
    expect(body.unavailableReasons.join(" ")).toContain("未留档");
    expect(body.videos).toEqual([]);
    expect(body.importRows).toEqual([]);
  });

  it("采纳记录分开存建议值与用户最终值；绑定只允许一次，内容不存在时不绑定", async () => {
    const cid = `${PREFIX}-app1`;
    const recId = `${PREFIX}-app1rec`;
    await seedContentWithVideo(cid);
    await db.insert(recommendations).values({
      id: recId,
      recommendationType: "speech_rate",
      recommendation: { value: "慢（<0.9×）", label: "慢语速", kindLabel: "推荐语速" },
      reason: "夹具建议",
      sourceSampleCount: 9,
      sourceMetric: "completion_rate",
    });
    const created = await recordApplication({
      recommendationId: recId,
      // 用户把建议的 0.85 改成了 1.05：最终值必须是 1.05
      prefillParams: { rate: 0.85 },
    });
    expect(created.kind).toBe("created");
    if (created.kind !== "created") return;
    expect(created.targetMetric).toBe("completion_rate");

    const bound = await bindApplication(created.id, {
      contentId: cid,
      finalParams: { generation: { topic: "机场英语" }, media: { rate: 1.05 } },
    });
    expect(bound).toBe("bound");
    const [row] = await db
      .select()
      .from(recommendationApplications)
      .where(eq(recommendationApplications.id, created.id))
      .limit(1);
    expect(row?.suggestedParams).toMatchObject({ value: "慢（<0.9×）" });
    expect(row?.prefillParams).toEqual({ rate: 0.85 });
    expect(row?.finalParams).toMatchObject({ media: { rate: 1.05 } });
    expect(row?.contentId).toBe(cid);
    expect(row?.appliedAt).not.toBeNull();

    // 重复绑定拒绝，不静默改写首次事实
    expect(await bindApplication(created.id, { contentId: cid, finalParams: {} })).toBe(
      "already-bound",
    );
    // 内容不存在 → 不绑定（记录保持未绑定，不伪造归属）
    const orphan = await recordApplication({ recommendationId: recId, prefillParams: {} });
    expect(orphan.kind).toBe("created");
    if (orphan.kind !== "created") return;
    expect(await bindApplication(orphan.id, { contentId: "不存在的内容", finalParams: {} })).toBe(
      "content-not-found",
    );
    const [kept] = await db
      .select()
      .from(recommendationApplications)
      .where(eq(recommendationApplications.id, orphan.id))
      .limit(1);
    expect(kept?.contentId).toBeNull();
    expect(kept?.appliedAt).toBeNull();
  });

  it("生成链路在真库上按平台分开统计：8 条同平台真实样本才出参数建议，3 条的组与别的平台都不算", async () => {
    const before = await latestSnapshotId();
    for (let i = 0; i < 8; i++) await seedFactorSample(`q${i}`, "抖音", "question", 0.5);
    for (let i = 0; i < 3; i++) await seedFactorSample(`m${i}`, "抖音", "mistake", 0.2);
    // 跨平台的高值样本不得混进抖音的分组：它只会让自己那侧因不足 8 条而给数据准备建议
    await seedFactorSample("k0", "快手", "question", 0.99);
    try {
      expect(await generateRecommendations()).toBeGreaterThan(0);

      const [snapshots, recs] = await Promise.all([
        db.select().from(analysisResults).where(gt(analysisResults.id, before)),
        db.select().from(recommendations).where(gt(recommendations.analysisResultId, before)),
      ]);
      const platformOf = new Map(snapshots.map((s) => [s.id, snapshotPlatform(s.result)]));
      // 每个平台各写一份快照；测试库里可能还有别的历史平台数据，只钉本次涉及的两个平台
      expect([...new Set(platformOf.values())]).toEqual(expect.arrayContaining(["抖音", "快手"]));

      const douyinHook = recs.find(
        (r) =>
          r.recommendationType === "hook" && platformOf.get(r.analysisResultId ?? -1) === "抖音",
      );
      expect(recValue(douyinHook?.recommendation)).toBe("question");
      expect(douyinHook?.sourceSampleCount).toBe(8);
      // 措辞本身必须是「关联」而非「因果」（§3 不变量落在真实生成路径上）
      expect(douyinHook?.reason).toContain("不是因果结论");
      // 3 条的组不足门槛：不得出现 mistake 的参数建议
      expect(recs.find((r) => recValue(r.recommendation) === "mistake")).toBeUndefined();
      // 快手只有 1 条样本（哪怕值最高）：只给数据准备建议
      const kuaishouRecs = recs.filter((r) => platformOf.get(r.analysisResultId ?? -1) === "快手");
      expect(kuaishouRecs.length).toBeGreaterThan(0);
      expect(kuaishouRecs.every((r) => r.recommendationType === "data_readiness")).toBe(true);

      // 累计口径：必须等于库内「真的回写过 appliedToContentId」的条数（曾经写成 total-applied，
      // 于是一条都没产出的新建议被显示成「已产出 N 条」）
      const listRes = await analyticsRoute.request("/recommendations?limit=100");
      const listed = await listRes.json();
      const [appliedInDb] = await db
        .select({ c: count() })
        .from(recommendations)
        .where(sql`${recommendations.appliedToContentId} is not null`);
      expect(listed.summary.applied).toBe(Number(appliedInDb?.c ?? 0));
      expect(listed.summary.applied).toBeLessThan(listed.summary.total);

      if (!douyinHook) return;
      const evidenceRes = await analyticsRoute.request(
        `/recommendations/${douyinHook.id}/evidence`,
      );
      expect(evidenceRes.status).toBe(200);
      const evidence = await evidenceRes.json();
      expect(evidence.status).toBe("traceable");
      expect(evidence.groups[0].recordIds).toHaveLength(8);
      expect(evidence.videos).toHaveLength(8);
      // 这批指标没有导入留痕：如实说「只能追到字段名层级」，而不是假装追到了原始行
      expect(evidence.importRows).toEqual([]);
      expect(evidence.unavailableReasons.join(" ")).toContain("只能追到字段名层级");
    } finally {
      // 生成链路写的是派生数据（随机 rec_ id + 自增快照 id），按本次范围收尾，不留给下一个用例
      await db.delete(recommendations).where(gt(recommendations.analysisResultId, before));
      await db.delete(analysisResults).where(gt(analysisResults.id, before));
    }
  });

  it("实验分配是评估的事实来源：生成前登记 → 绑定 → 未绑定条数如实报，旧两组清单不再冒充对照", async () => {
    const expId = `${PREFIX}-x1`;
    const contentA = `${PREFIX}-x1ca`;
    const contentB = `${PREFIX}-x1cb`;
    const recordA = `${PREFIX}-x1ar`;
    const recordB = `${PREFIX}-x1br`;
    await seedContentWithVideo(contentA);
    await seedContentWithVideo(contentB);
    await seedPublishRecord(recordA, contentA, "抖音");
    await seedPublishRecord(recordB, contentB, "抖音");
    await db.insert(videoMetrics).values([
      {
        publishRecordId: recordA,
        metricName: "completion_rate",
        metricValue: 0.6,
        sourceType: "CREATOR_IMPORT",
        dataDate: "2026-10-01",
      },
      {
        publishRecordId: recordB,
        metricName: "completion_rate",
        metricValue: 0.2,
        sourceType: "CREATOR_IMPORT",
        dataDate: "2026-10-01",
      },
    ]);
    // 旧账本两组故意指向不存在的内容：评估若还读它就会得到 0/0，读分配才得到 1/1
    await db.insert(experiments).values({
      id: expId,
      variable: "hook",
      variantA: { label: "提问", contentIds: ["不存在的内容A"] },
      variantB: { label: "平铺", contentIds: ["不存在的内容B"] },
      targetMetric: "completion_rate",
      status: "draft",
    });

    const a = await createAssignment({
      experimentId: expId,
      variant: "A",
      assignedParams: { variantLabel: "提问" },
    });
    const b = await createAssignment({
      experimentId: expId,
      variant: "B",
      assignedParams: { variantLabel: "平铺" },
    });
    const c = await createAssignment({
      experimentId: expId,
      variant: "B",
      assignedParams: { variantLabel: "平铺" },
    });
    if (a.kind !== "created" || b.kind !== "created" || c.kind !== "created") {
      throw new Error("draft 实验的三条分配都应登记成功");
    }
    const aId = a.assignment.id;
    const bId = b.assignment.id;
    const cId = c.assignment.id;

    expect(
      await bindAssignment(expId, aId, {
        contentId: contentA,
        finalParams: { template: "scene_word" },
      }),
    ).toBe("bound");
    expect(
      await bindAssignment(expId, bId, { contentId: contentB, finalParams: { template: "quiz" } }),
    ).toBe("bound");
    // 一次分配对应一次生成：二次绑定拒绝，不改写首次事实
    expect(await bindAssignment(expId, aId, { contentId: contentB, finalParams: {} })).toBe(
      "already-bound",
    );
    // 内容不存在就不绑定（不伪造归属）
    expect(await bindAssignment(expId, cId, { contentId: "不存在的内容", finalParams: {} })).toBe(
      "content-not-found",
    );
    // 同一条内容不能占两个变体位：否则 A/B 里出现同一个视频，等于自己跟自己比
    expect(await bindAssignment(expId, cId, { contentId: contentA, finalParams: {} })).toBe(
      "content-already-assigned",
    );

    expect(await loadGroups(expId)).toEqual({
      a: [contentA],
      b: [contentB],
      unbound: 1,
      total: 3,
    });

    const evaluated = await evaluateExperimentById(expId);
    if (evaluated.kind !== "ok") throw new Error("评估应完成");
    const result = evaluated.experiment.result;
    if (!result) throw new Error("评估结果应落库");
    expect(result.sampleA).toBe(1);
    expect(result.sampleB).toBe(1);
    expect(result.note).toContain("生成前登记的变体分配");
    expect(result.note).toContain("1 条未绑定");
    // 两组各 1 条：既不能假装够样本，也不能说成「没有数据」
    expect(result.verdict).toContain("样本不足（A n=1 / B n=1");
    expect(result.note).toContain("不构成因果");

    // 已归档的实验不再接受新分配（事后追加等于挑数据）
    expect(
      await createAssignment({ experimentId: expId, variant: "A", assignedParams: {} }),
    ).toEqual({ kind: "not-assignable", status: "completed" });

    const ledger = await listAssignments(expId);
    expect(ledger).toHaveLength(3);
    const boundA = ledger.find((r) => r.id === aId);
    expect(boundA?.contentId).toBe(contentA);
    expect(boundA?.finalParams).toMatchObject({ template: "scene_word" });
    expect(boundA?.boundAt).not.toBeNull();
    expect(ledger.find((r) => r.id === cId)?.boundAt).toBeNull();
  });
});
