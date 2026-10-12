/**
 * /api/analytics 路由测试（Phase 1 数据基础 + 数据接入）
 * 覆盖需求 §二十五 API 项：正常返回 / 空数据 / 缺少指标 / 部分数据来源 / 无官方 API 数据（仅导入）/
 * 分页 / 日期范围 / 参数校验 / 账号日批量导入逐行裁决
 * 服务层用 mock 隔离（DB 行为在 *-service.test.ts 与本模块纯函数用例覆盖）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { analyticsRoute } from "./analytics";

vi.mock("../db", () => ({ db: {} }));
vi.mock("../services/analytics-metrics.service", () => ({
  createPublishRecord: vi.fn(),
  listPublishRecords: vi.fn(),
  updatePublishRecord: vi.fn(),
  deletePublishRecord: vi.fn(),
  getRecordMetrics: vi.fn(),
  importMetrics: vi.fn(),
  importCreatorDaily: vi.fn(),
  upsertCreatorDaily: vi.fn(),
  listCreatorDaily: vi.fn(),
}));
vi.mock("../services/analytics-dashboard.service", () => ({
  getAnalyticsOverview: vi.fn(),
  listAnalyticsVideos: vi.fn(),
  getBenchmark: vi.fn(),
  getDailyTrend: vi.fn(),
}));
vi.mock("../services/analytics-content-video.service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/analytics-content-video.service")>();
  return { ...actual, listContentVideos: vi.fn() };
});
vi.mock("../services/analytics-factors.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/analytics-factors.service")>();
  return { ...actual, getFactorAnalysis: vi.fn(), persistFactorAnalysis: vi.fn() };
});
vi.mock("../services/analytics-segment.service", () => ({
  loadContentSegments: vi.fn(),
  syncContentSegments: vi.fn(),
}));
vi.mock("../services/analytics-recommend.service", () => ({
  listRecommendations: vi.fn(),
  generateRecommendations: vi.fn(),
  decideRecommendation: vi.fn(),
  getVideoStructure: vi.fn(),
}));
vi.mock("../services/analytics-recommend-evidence.service", () => ({
  getRecommendationEvidence: vi.fn(),
  recordRecommendationApplication: vi.fn(),
  bindRecommendationApplication: vi.fn(),
}));
vi.mock("../services/analytics-experiment.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/analytics-experiment.service")>();
  return {
    ...actual,
    createExperiment: vi.fn(),
    listExperiments: vi.fn(),
    evaluateExperimentById: vi.fn(),
    updateExperimentStatus: vi.fn(),
  };
});
vi.mock("../services/analytics-experiment-assignment.service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/analytics-experiment-assignment.service")>();
  return {
    ...actual,
    createExperimentAssignment: vi.fn(),
    bindExperimentAssignment: vi.fn(),
    listExperimentAssignments: vi.fn(),
    experimentExists: vi.fn(),
  };
});
vi.mock("../services/analytics-feature.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/analytics-feature.service")>();
  return {
    ...actual,
    loadContentFeature: vi.fn(),
    syncContentFeature: vi.fn(),
    patchManualFeature: vi.fn(),
  };
});

import { listContentVideos } from "../services/analytics-content-video.service";
import {
  getAnalyticsOverview,
  getBenchmark,
  getDailyTrend,
  listAnalyticsVideos,
} from "../services/analytics-dashboard.service";
import {
  bindExperimentAssignment,
  createExperimentAssignment,
  experimentExists,
  listExperimentAssignments,
} from "../services/analytics-experiment-assignment.service";
import {
  createExperiment,
  evaluateExperimentById,
  listExperiments,
  updateExperimentStatus,
} from "../services/analytics-experiment.service";
import { getFactorAnalysis, persistFactorAnalysis } from "../services/analytics-factors.service";
import {
  loadContentFeature,
  patchManualFeature,
  syncContentFeature,
} from "../services/analytics-feature.service";
import {
  createPublishRecord,
  deletePublishRecord,
  getRecordMetrics,
  importCreatorDaily,
  importMetrics,
  listCreatorDaily,
  listPublishRecords,
  updatePublishRecord,
  upsertCreatorDaily,
} from "../services/analytics-metrics.service";
import {
  bindRecommendationApplication,
  getRecommendationEvidence,
  recordRecommendationApplication,
} from "../services/analytics-recommend-evidence.service";
import {
  decideRecommendation,
  generateRecommendations,
  getVideoStructure,
  listRecommendations,
} from "../services/analytics-recommend.service";
import { loadContentSegments, syncContentSegments } from "../services/analytics-segment.service";

const app = analyticsRoute;

const recordItem = {
  id: "pub_20260920_abc123",
  contentId: "cnt_20260920_abc123",
  contentTitle: "咖啡店英语",
  template: "scene_word",
  videoAssetId: "video-1.mp4",
  platform: "抖音",
  platformVideoId: "7432123456789",
  publishTitle: "点咖啡别再只会说 I want this",
  publishTime: "2026-09-20T10:00:00.000Z",
  coverUrl: null,
  publishStatus: "published",
  createdAt: "2026-09-20T10:00:00.000Z",
  updatedAt: "2026-09-20T10:00:00.000Z",
};

const featureRow = {
  contentId: "cnt_20260920_abc123",
  template: "scene_word",
  level: "CET4",
  duration: 33.5,
  knowledgePointCount: 8,
  characterCount: null,
  dialogueCount: 3,
  segmentCount: 3,
  speechRate: 1,
  voiceId: "female_01",
  bgm: "/files/bgm/a.mp3",
  subtitleType: "burned_in",
  shotCount: 4,
  introEffect: 1,
  introTopic: "旅行",
  promptVersion: null,
  rendererVersion: null,
  scene: "hotel",
  hook: "mistake",
  contentFormat: null,
  emotion: null,
  ctaType: null,
  ctaStartTime: null,
  fieldSources: { scene: "USER_INPUT", hook: "USER_INPUT" },
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  vi.mocked(createPublishRecord).mockReset();
  vi.mocked(listPublishRecords).mockReset();
  vi.mocked(updatePublishRecord).mockReset();
  vi.mocked(deletePublishRecord).mockReset();
  vi.mocked(importMetrics).mockReset();
  vi.mocked(getRecordMetrics).mockReset();
  vi.mocked(loadContentFeature).mockReset();
  vi.mocked(syncContentFeature).mockReset();
  vi.mocked(patchManualFeature).mockReset();
  vi.mocked(upsertCreatorDaily).mockReset();
  vi.mocked(listCreatorDaily).mockReset();
  vi.mocked(getAnalyticsOverview).mockReset();
  vi.mocked(listAnalyticsVideos).mockReset();
  vi.mocked(getBenchmark).mockReset();
  vi.mocked(getDailyTrend).mockReset();
  vi.mocked(getFactorAnalysis).mockReset();
  vi.mocked(persistFactorAnalysis).mockReset();
  vi.mocked(loadContentSegments).mockReset();
  vi.mocked(syncContentSegments).mockReset();
  vi.mocked(syncContentSegments).mockResolvedValue([]);
  vi.mocked(listRecommendations).mockReset();
  vi.mocked(generateRecommendations).mockReset();
  vi.mocked(decideRecommendation).mockReset();
  vi.mocked(getVideoStructure).mockReset();
  vi.mocked(createExperiment).mockReset();
  vi.mocked(listExperiments).mockReset();
  vi.mocked(evaluateExperimentById).mockReset();
  vi.mocked(updateExperimentStatus).mockReset();
});

describe("GET /api/analytics/publish-records", () => {
  it("正常返回分页列表（默认 page=1 / pageSize=20）", async () => {
    vi.mocked(listPublishRecords).mockResolvedValue({ items: [recordItem] as never, total: 1 });
    const res = await app.request("/publish-records");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ total: 1, page: 1, pageSize: 20 });
    expect(body.items[0]).toMatchObject({
      id: recordItem.id,
      platformVideoId: recordItem.platformVideoId,
    });
    expect(listPublishRecords).toHaveBeenCalledWith(
      expect.objectContaining({ page: 1, pageSize: 20 }),
    );
  });

  it("分页与平台过滤参数透传", async () => {
    vi.mocked(listPublishRecords).mockResolvedValue({ items: [], total: 0 });
    const res = await app.request("/publish-records?page=2&pageSize=50&platform=抖音");
    expect(res.status).toBe(200);
    expect(listPublishRecords).toHaveBeenCalledWith(
      expect.objectContaining({ page: 2, pageSize: 50, platform: "抖音" }),
    );
  });

  it("pageSize 超上限 → 400", async () => {
    const res = await app.request("/publish-records?pageSize=1000");
    expect(res.status).toBe(400);
  });
});

describe("POST /api/analytics/publish-records", () => {
  const body = {
    contentId: "cnt_20260920_abc123",
    platform: "抖音",
    platformVideoId: "7432123456789",
  };

  it("创建成功 201 并触发生产特征落库", async () => {
    vi.mocked(createPublishRecord).mockResolvedValue({ kind: "created", id: recordItem.id });
    vi.mocked(syncContentFeature).mockResolvedValue(featureRow as never);
    const res = await app.request("/publish-records", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: recordItem.id });
    expect(syncContentFeature).toHaveBeenCalledWith(body.contentId);
  });

  it("内容不存在 → 404；作品 ID 重复绑定 → 409", async () => {
    vi.mocked(createPublishRecord).mockResolvedValue({ kind: "content-not-found" });
    expect(
      (
        await app.request("/publish-records", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(404);
    vi.mocked(createPublishRecord).mockResolvedValue({ kind: "duplicate" });
    const dup = await app.request("/publish-records", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(dup.status).toBe(409);
    expect((await dup.json()).error.code).toBe("DUPLICATE_PLATFORM_VIDEO");
  });

  it("特征落库失败不阻断发布记录创建（降级留痕）", async () => {
    vi.mocked(createPublishRecord).mockResolvedValue({ kind: "created", id: recordItem.id });
    vi.mocked(syncContentFeature).mockRejectedValue(new Error("db down"));
    const res = await app.request("/publish-records", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(201);
  });
});

describe("PATCH /api/analytics/publish-records/{recordId}", () => {
  it("更新成功 / 不存在 404", async () => {
    vi.mocked(updatePublishRecord).mockResolvedValue("updated");
    const ok = await app.request("/publish-records/pub_1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publishStatus: "deleted" }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ id: "pub_1", updated: true });
    vi.mocked(updatePublishRecord).mockResolvedValue("not-found");
    const miss = await app.request("/publish-records/pub_missing", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platformVideoId: "x" }),
    });
    expect(miss.status).toBe(404);
  });
});

describe("DELETE /api/analytics/publish-records/{recordId}", () => {
  it("删除成功 200；不存在 → 404（不再对不存在的 ID 假报删除成功）", async () => {
    vi.mocked(deletePublishRecord).mockResolvedValue(true);
    const ok = await app.request("/publish-records/pub_1", { method: "DELETE" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ id: "pub_1", deleted: true });
    vi.mocked(deletePublishRecord).mockResolvedValue(false);
    const miss = await app.request("/publish-records/pub_missing", { method: "DELETE" });
    expect(miss.status).toBe(404);
    const body = await miss.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });
});

describe("GET /api/analytics/videos/{contentId}/metrics", () => {
  it("返回最新值与每日快照（每项指标带来源 provenance）", async () => {
    vi.mocked(getRecordMetrics).mockResolvedValue({
      records: [
        {
          recordId: recordItem.id,
          platform: "抖音",
          platformVideoId: "743",
          publishTime: null,
          latest: [
            {
              metricName: "completion_rate",
              label: "完播率",
              unit: "rate",
              availability: "IMPORT_ONLY",
              metricValue: 0.413,
              sourceType: "CREATOR_IMPORT",
              sourceField: "完播率",
              dataDate: "2026-09-21",
              isEstimated: false,
              confidence: null,
              fetchedAt: "2026-09-22T00:00:00.000Z",
            },
          ],
          daily: [],
        },
      ],
      emptyReason: null,
    });
    const res = await app.request(
      `/videos/${recordItem.contentId}/metrics?dateFrom=2026-09-01&dateTo=2026-09-22`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.emptyReason).toBeNull();
    expect(body.records[0].latest[0]).toMatchObject({
      metricName: "completion_rate",
      sourceType: "CREATOR_IMPORT",
      availability: "IMPORT_ONLY",
    });
    expect(getRecordMetrics).toHaveBeenCalledWith(recordItem.contentId, {
      dateFrom: "2026-09-01",
      dateTo: "2026-09-22",
    });
  });

  it("已发布但未导入 → 200 空数组 + emptyReason=not_imported（无数据 ≠ 0）", async () => {
    vi.mocked(getRecordMetrics).mockResolvedValue({ records: [], emptyReason: "not_imported" });
    const res = await app.request(`/videos/${recordItem.contentId}/metrics`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ records: [], emptyReason: "not_imported" });
  });

  it("未发布 → emptyReason=not_published；内容不存在 → 404；日期格式错 → 400", async () => {
    vi.mocked(getRecordMetrics).mockResolvedValue({ records: [], emptyReason: "not_published" });
    const res = await app.request("/videos/cnt_x/metrics");
    expect(res.status).toBe(200);
    expect((await res.json()).emptyReason).toBe("not_published");
    vi.mocked(getRecordMetrics).mockResolvedValue({
      records: [],
      emptyReason: "content_not_found",
    });
    expect((await app.request("/videos/cnt_none/metrics")).status).toBe(404);
    expect((await app.request("/videos/cnt_x/metrics?dateFrom=20260901")).status).toBe(400);
  });
});

describe("POST /api/analytics/import", () => {
  const validBody = {
    metricMapping: { 播放量: "play_count", 完播率: "completion_rate" },
    dataDate: "2026-09-21",
    rows: [{ match: { platformVideoId: "743" }, values: { 播放量: 1283220, 完播率: "41.3%" } }],
  };

  it("仅导入来源可用：默认 sourceType=CREATOR_IMPORT（不伪装官方 API）", async () => {
    vi.mocked(importMetrics).mockResolvedValue([
      {
        row: 0,
        ok: true,
        recordId: "pub_1",
        written: ["play_count", "completion_rate"],
        skipped: [],
        derived: ["like_rate"],
      },
    ]);
    const res = await app.request("/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toMatchObject({ total: 1, succeeded: 1, failed: 0 });
    // 批次 3B：响应携请求级批次号（写入行 metadata.batch_id 同一值）
    expect(body.summary.batchId).toMatch(/^[0-9a-f]{8}$/);
    expect(importMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ sourceType: "CREATOR_IMPORT" }),
    );
  });

  it("声明 PLATFORM_PRODUCTION 来源 → 400（导入通道白名单外；DOUYIN_* 枚举已随抖音通道砍除）", async () => {
    const res = await app.request("/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validBody, sourceType: "PLATFORM_PRODUCTION" }),
    });
    expect(res.status).toBe(400);
  });

  it("映射为空 / rows 为空 → 400", async () => {
    const emptyMapping = await app.request("/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validBody, metricMapping: {} }),
    });
    expect(emptyMapping.status).toBe(400);
    const emptyRows = await app.request("/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validBody, rows: [] }),
    });
    expect(emptyRows.status).toBe(400);
  });

  it("部分成功语义：逐行返回 ok/skipped/error，不整单失败", async () => {
    vi.mocked(importMetrics).mockResolvedValue([
      {
        row: 0,
        ok: true,
        recordId: "pub_1",
        written: ["play_count"],
        skipped: [{ field: "备注", reason: "字段未映射" }],
        derived: [],
      },
      {
        row: 1,
        ok: false,
        recordId: null,
        written: [],
        skipped: [],
        derived: [],
        error: "发布记录未找到",
      },
    ]);
    const res = await app.request("/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toMatchObject({ total: 2, succeeded: 1, failed: 1 });
    expect(typeof body.summary.batchId).toBe("string");
    expect(body.results[0].skipped[0].reason).toContain("未映射");
    expect(body.results[1].error).toContain("未找到");
  });
});

describe("GET /api/analytics/metric-catalog", () => {
  it("返回 canonical 目录：IMPORT_ONLY/DERIVED 分级与可导入标记", async () => {
    const res = await app.request("/metric-catalog");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      metrics: Record<string, unknown>[];
      sourceTypes: string[];
      creatorDailyFields: { name: string }[];
    };
    const completion = body.metrics.find((m) => m.name === "completion_rate");
    expect(completion).toMatchObject({
      availability: "IMPORT_ONLY",
      importable: true,
      label: "完播率",
    });
    const likeRate = body.metrics.find((m) => m.name === "like_rate");
    expect(likeRate).toMatchObject({ availability: "DERIVED", importable: false });
    expect(likeRate?.formula).toContain("play_count");
    expect(body.sourceTypes).toHaveLength(5);
    // 账号日字段目录同步暴露（前端映射选项不写死）
    expect(body.creatorDailyFields.map((f) => f.name)).toContain("coverClickRate");
    expect(body.creatorDailyFields).toHaveLength(12);
  });
});

describe("/api/analytics/features/{contentId}", () => {
  it("GET 只读返回已落库特征（含字段级来源）", async () => {
    vi.mocked(loadContentFeature).mockResolvedValue(featureRow as never);
    const res = await app.request(`/features/${recordItem.contentId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ scene: "hotel", hook: "mistake", duration: 33.5 });
    expect(body.fieldSources.scene).toBe("USER_INPUT");
    expect(syncContentFeature).not.toHaveBeenCalled();
  });

  it("GET 无特征行但内容存在 → null（不重建）；内容不存在 → 404", async () => {
    vi.mocked(loadContentFeature).mockResolvedValue(null);
    vi.mocked(getRecordMetrics).mockResolvedValue({ records: [], emptyReason: "not_published" });
    const res = await app.request("/features/cnt_x");
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
    vi.mocked(getRecordMetrics).mockResolvedValue({
      records: [],
      emptyReason: "content_not_found",
    });
    expect((await app.request("/features/cnt_none")).status).toBe(404);
  });

  it("PATCH 人工标签：taxonomy 脏值 → 400；合法值 → 200 并透传", async () => {
    const bad = await app.request(`/features/${recordItem.contentId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scene: "深空科幻" }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("INVALID_TAXONOMY");
    vi.mocked(patchManualFeature).mockResolvedValue({ ...featureRow, scene: "hotel" } as never);
    const ok = await app.request(`/features/${recordItem.contentId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scene: "hotel", ctaStartTime: 25 }),
    });
    expect(ok.status).toBe(200);
    expect(patchManualFeature).toHaveBeenCalledWith(
      recordItem.contentId,
      expect.objectContaining({ scene: "hotel", ctaStartTime: 25 }),
    );
  });
});

describe("/api/analytics/creator-daily", () => {
  it("POST 写入（幂等 upsert）+ GET 日期范围查询", async () => {
    vi.mocked(upsertCreatorDaily).mockResolvedValue(undefined);
    const post = await app.request("/creator-daily", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "抖音", date: "2026-09-21", newFans: 120, totalFans: 8000 }),
    });
    expect(post.status).toBe(200);
    expect(await post.json()).toEqual({ ok: true, date: "2026-09-21" });
    expect(upsertCreatorDaily).toHaveBeenCalledWith(
      expect.objectContaining({ sourceType: "CREATOR_IMPORT", newFans: 120 }),
    );
    vi.mocked(listCreatorDaily).mockResolvedValue([]);
    const list = await app.request(
      "/creator-daily?platform=抖音&dateFrom=2026-09-01&dateTo=2026-09-21",
    );
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ items: [] });
    expect(listCreatorDaily).toHaveBeenCalledWith({
      platform: "抖音",
      dateFrom: "2026-09-01",
      dateTo: "2026-09-21",
    });
  });

  it("date 格式非法（非 YYYY-MM-DD）→ 400", async () => {
    const res = await app.request("/creator-daily", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform: "抖音", date: "not-a-date" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/analytics/creator-daily/import（账号日批量导入）", () => {
  const validBody = {
    platform: "抖音",
    fieldMapping: { 总播放量: "playIncrement", 封面点击率: "coverClickRate" },
    rows: [
      {
        statDate: "2026-09-17",
        values: { 总播放量: "708", 封面点击率: "0.00%" },
        attribution: { mode: "account" },
      },
    ],
  };

  it("逐行归属裁决透传服务层，返回部分成功语义", async () => {
    vi.mocked(importCreatorDaily).mockResolvedValue([
      {
        row: 0,
        ok: true,
        statDate: "2026-09-17",
        dailyWritten: ["playIncrement", "coverClickRate"],
        videoRecordId: null,
        videoWritten: [],
        videoDerived: [],
        skipped: [],
      },
    ]);
    const res = await app.request("/creator-daily/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      summary: { total: number; succeeded: number; failed: number; batchId: string };
    };
    expect(body.summary).toMatchObject({ total: 1, succeeded: 1, failed: 0 });
    expect(body.summary.batchId).toMatch(/^[0-9a-f]{8}$/);
    expect(importCreatorDaily).toHaveBeenCalledWith(
      expect.objectContaining({ sourceType: "CREATOR_IMPORT", platform: "抖音" }),
    );
  });

  it("归属作品行：recordId 透传 attribution（操作者裁决不丢失）", async () => {
    vi.mocked(importCreatorDaily).mockResolvedValue([]);
    await app.request("/creator-daily/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...validBody,
        rows: [
          {
            statDate: "2026-09-20",
            values: { 总播放量: 4121 },
            attribution: { mode: "video", recordId: "testpub0001douyin" },
          },
        ],
      }),
    });
    expect(importCreatorDaily).toHaveBeenCalledWith(
      expect.objectContaining({
        rows: [
          expect.objectContaining({
            attribution: { mode: "video", recordId: "testpub0001douyin" },
          }),
        ],
      }),
    );
  });

  it("fieldMapping 为空 / rows 为空 / statDate 非法 → 400", async () => {
    const emptyMapping = await app.request("/creator-daily/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validBody, fieldMapping: {} }),
    });
    expect(emptyMapping.status).toBe(400);
    const emptyRows = await app.request("/creator-daily/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...validBody, rows: [] }),
    });
    expect(emptyRows.status).toBe(400);
    const badDate = await app.request("/creator-daily/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...validBody,
        rows: [{ statDate: "2026/09/17", values: {}, attribution: { mode: "account" } }],
      }),
    });
    expect(badDate.status).toBe(400);
  });

  it("attribution 白名单外 mode → 400（不接受系统推断型 mode）", async () => {
    const res = await app.request("/creator-daily/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...validBody,
        rows: [
          {
            statDate: "2026-09-17",
            values: { 总播放量: 708 },
            attribution: { mode: "auto_split" },
          },
        ],
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/analytics/overview（Phase 2 漏斗）", () => {
  it("默认 7 天窗口透传聚合结果", async () => {
    vi.mocked(getAnalyticsOverview).mockResolvedValue({
      days: 7,
      from: "2026-09-16",
      to: "2026-09-23",
      previousFrom: "2026-09-09",
      previousTo: "2026-09-16",
      publishedVideos: 2,
      previousPublishedVideos: 1,
      stages: [
        {
          key: "plays",
          label: "播放",
          kind: "count",
          value: 1500,
          previousValue: 900,
          stepRate: null,
          stepRateState: "first",
          shareOfPlays: 1,
          coverageCount: 2,
          windowRecordCount: 2,
          basisPlays: 1500,
          changePct: 0.667,
          sourceTypes: ["CREATOR_IMPORT"],
          emptyReason: null,
        },
      ],
      emptyReason: null,
    });
    const res = await app.request("/overview");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stages[0]).toMatchObject({ key: "plays", value: 1500 });
    expect(getAnalyticsOverview).toHaveBeenCalledWith(7);
  });

  it("days 非法（0/超过 365）→ 400", async () => {
    expect((await app.request("/overview?days=0")).status).toBe(400);
    expect((await app.request("/overview?days=400")).status).toBe(400);
  });
});

describe("GET /api/analytics/videos（Phase 2 表现列表）", () => {
  it("排序/分页参数透传（默认 play desc）", async () => {
    vi.mocked(listAnalyticsVideos).mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
      unregisteredContentCount: 0,
    });
    const res = await app.request("/videos?sort=completion&order=asc&page=2&pageSize=10");
    expect(res.status).toBe(200);
    expect(listAnalyticsVideos).toHaveBeenCalledWith({ sort: "completion", order: "asc" }, 2, 10);
    const def = await app.request("/videos");
    expect(def.status).toBe(200);
    expect(listAnalyticsVideos).toHaveBeenLastCalledWith({ sort: "play", order: "desc" }, 1, 20);
  });

  it("未登记发布记录的集数原样透出（行集锚点会吞集，必须可见）", async () => {
    vi.mocked(listAnalyticsVideos).mockResolvedValue({
      items: [],
      total: 39,
      page: 1,
      pageSize: 20,
      unregisteredContentCount: 6,
    });
    const res = await app.request("/videos");
    await expect(res.json()).resolves.toMatchObject({ total: 39, unregisteredContentCount: 6 });
  });

  it("非白名单排序键 → 400（拒绝任意列排序）", async () => {
    expect((await app.request("/videos?sort=title")).status).toBe(400);
  });
});

describe("GET /api/analytics/content-videos（批次一 统一内容主视图）", () => {
  const item = {
    contentId: "cnt_20260920_abc123",
    title: "咖啡店英语",
    template: "scene_word",
    level: "CET4",
    localStatus: "completed",
    generatedAt: "2026-09-20T10:00:00.000Z",
    videoAssetId: "video-1.mp4",
    durationSec: 33.5,
    status: "imported",
    statuses: ["imported"],
    platformCount: 1,
    metricCoverage: { platforms: 1, records: 1, recordsWithMetrics: 1 },
    platforms: [
      {
        recordId: "pub_20260920_abc123",
        platform: "抖音",
        platformVideoId: "7432123456789",
        publishStatus: "published",
        publishTime: "2026-09-20T10:00:00.000Z",
        publishTimeSource: "PLATFORM_IMPORTED",
        metricCount: 1,
        hasImportConflict: false,
        metrics: {
          play_count: {
            value: 1200,
            sourceType: "CREATOR_IMPORT",
            isEstimated: false,
            dataDate: "2026-09-21",
          },
        },
      },
    ],
  } satisfies import("../services/analytics-content-video.service").ContentVideoItem;

  const page = { items: [item], total: 1, page: 1, pageSize: 20 };

  it("默认参数：status=all、按生成时间倒序、第一页 20 条", async () => {
    vi.mocked(listContentVideos).mockResolvedValue(page);
    const res = await app.request("/content-videos");
    expect(res.status).toBe(200);
    expect(listContentVideos).toHaveBeenCalledWith({
      status: "all",
      platform: undefined,
      sort: "created_time",
      order: "desc",
      page: 1,
      pageSize: 20,
    });
  });

  it("一内容一行 + 平台明细原样透出（响应里不做任何跨平台合计）", async () => {
    vi.mocked(listContentVideos).mockResolvedValue(page);
    const body = await (await app.request("/content-videos?status=imported&sort=play")).json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].platforms).toHaveLength(1);
    // 主行没有 play/total/sum 之类的合计字段：指标只在 platforms[].metrics 里按平台读
    expect(Object.keys(body.items[0])).not.toContain("totalPlays");
    expect(listContentVideos).toHaveBeenLastCalledWith({
      status: "imported",
      platform: undefined,
      sort: "play",
      order: "desc",
      page: 1,
      pageSize: 20,
    });
  });

  it("非白名单 status / sort 与越界分页 → 400（拒绝任意列排序与状态值）", async () => {
    expect((await app.request("/content-videos?status=whatever")).status).toBe(400);
    expect((await app.request("/content-videos?sort=title")).status).toBe(400);
    expect((await app.request("/content-videos?page=0")).status).toBe(400);
    expect((await app.request("/content-videos?pageSize=101")).status).toBe(400);
  });

  it("服务抛错 → 500（不把查询失败渲染成空列表）", async () => {
    vi.mocked(listContentVideos).mockRejectedValue(new Error("conn lost"));
    const res = await app.request("/content-videos");
    expect(res.status).toBe(500);
  });
});

describe("已发布契约冻结（批次一：统一视图走新路径，旧接口逐字不变）", () => {
  /** 内层 .strict() 解析：多一个字段就红——防止「顺手往旧响应里加字段」破坏已发布契约 */
  const oldVideosItem = z
    .object({
      recordId: z.string(),
      contentId: z.string(),
      platform: z.string(),
      platformVideoId: z.string().nullable(),
      title: z.string(),
      template: z.string(),
      level: z.string(),
      durationSec: z.number().nullable(),
      publishTime: z.string().nullable(),
      metrics: z.record(z.unknown()),
    })
    .strict();

  const oldRecordsItem = z
    .object({
      id: z.string(),
      contentId: z.string(),
      contentTitle: z.string(),
      template: z.string(),
      videoAssetId: z.string().nullable(),
      platform: z.string(),
      platformVideoId: z.string().nullable(),
      publishTitle: z.string().nullable(),
      publishTime: z.string().nullable(),
      coverUrl: z.string().nullable(),
      publishStatus: z.string(),
      createdAt: z.string(),
      updatedAt: z.string(),
    })
    .strict();

  it("GET /videos 行锚点仍是 publish_records（一记录一行，字段集没被扩写）", async () => {
    vi.mocked(listAnalyticsVideos).mockResolvedValue({
      items: [
        {
          recordId: recordItem.id,
          contentId: recordItem.contentId,
          platform: "抖音",
          platformVideoId: "7432123456789",
          title: "咖啡店英语",
          template: "scene_word",
          level: "CET4",
          durationSec: 33.5,
          publishTime: "2026-09-20T10:00:00.000Z",
          metrics: {},
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
      unregisteredContentCount: 0,
    });
    const body = await (await app.request("/videos")).json();
    expect(oldVideosItem.parse(body.items[0] as object)).toBeTruthy();
    // 内容级状态/平台明细只属于 /content-videos，旧响应里不得出现
    expect(Object.keys(body.items[0] as object)).not.toContain("platforms");
    expect(Object.keys(body.items[0] as object)).not.toContain("status");
  });

  it("GET /videos 响应多一个字段即红（strict 守卫：加字段必须走新路径）", () => {
    expect(() =>
      oldVideosItem.parse({
        recordId: "pub_1",
        contentId: "cnt_1",
        platform: "抖音",
        platformVideoId: null,
        title: "t",
        template: "scene_word",
        level: "CET4",
        durationSec: null,
        publishTime: null,
        metrics: {},
        publishTimeSource: "LOCAL_GENERATED",
      }),
    ).toThrow();
  });

  it("GET /publish-records 响应字段集不变（内部列 publish_time_source 不外泄）", async () => {
    vi.mocked(listPublishRecords).mockResolvedValue({ items: [recordItem], total: 1 });
    const body = await (await app.request("/publish-records")).json();
    expect(oldRecordsItem.parse(body.items[0] as object)).toBeTruthy();
    expect(Object.keys(body.items[0] as object)).not.toContain("publishTimeSource");
  });
});

describe("GET /api/analytics/videos/{contentId}/benchmark（Phase 2 同类基准）", () => {
  it("返回分组/样本数/lowSample（必须可呈现样本量，防小样本误判）", async () => {
    vi.mocked(getBenchmark).mockResolvedValue({
      subject: {
        contentId: "cnt_x",
        group: { template: "scene_word", scene: null, contentFormat: null, durationBand: "30_60" },
      },
      sampleCount: 3,
      lowSample: true,
      metrics: {
        completion_rate: {
          self: { value: 0.4, sourceType: "CREATOR_IMPORT", isEstimated: false, dataDate: null },
          groupMedian: 0.3,
          groupMean: 0.32,
          diff: 0.1,
          sampleCount: 3,
        },
      },
      emptyReason: null,
    });
    const res = await app.request("/videos/cnt_x/benchmark");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ sampleCount: 3, lowSample: true });
    expect(body.metrics.completion_rate.self.sourceType).toBe("CREATOR_IMPORT");
  });

  it("无发布记录 → emptyReason 透传（不伪装成基准为 0）", async () => {
    vi.mocked(getBenchmark).mockResolvedValue({
      subject: {
        contentId: "cnt_none",
        group: { template: "", scene: null, contentFormat: null, durationBand: null },
      },
      sampleCount: 0,
      lowSample: true,
      metrics: {},
      emptyReason: "no_publish_record",
    });
    const body = await (await app.request("/videos/cnt_none/benchmark")).json();
    expect(body.emptyReason).toBe("no_publish_record");
  });
});

describe("GET /api/analytics/videos/{contentId}/trend（Phase 2 趋势）", () => {
  it("返回每日快照序列（缺日无点，不补 0）", async () => {
    vi.mocked(getDailyTrend).mockResolvedValue([
      {
        recordId: "pub_1",
        platform: "抖音",
        series: [
          {
            metricName: "play_count",
            points: [
              { date: "2026-09-20", value: 120, sourceType: "CREATOR_IMPORT" },
              { date: "2026-09-22", value: 300, sourceType: "CREATOR_IMPORT" },
            ],
          },
        ],
      },
    ]);
    const res = await app.request("/videos/cnt_x/trend?dateFrom=2026-09-01");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.records[0].series[0].points).toHaveLength(2);
    expect(getDailyTrend).toHaveBeenCalledWith("cnt_x", { dateFrom: "2026-09-01" });
  });

  it("日期格式非法 → 400", async () => {
    expect((await app.request("/videos/cnt_x/trend?dateFrom=20260901")).status).toBe(400);
  });
});

describe("GET /api/analytics/factors（Phase 3 因子分析）", () => {
  it("默认指标与维度透传；结果含样本数/lowSample/note 诚实声明", async () => {
    vi.mocked(getFactorAnalysis).mockResolvedValue({
      metric: "completion_rate",
      accountMedian: 0.2,
      accountSampleCount: 3,
      accountRealSampleCount: 3,
      scope: { platform: null, windowDays: null },
      mixedPlatform: false,
      platforms: [],
      dimensions: [
        {
          dimension: "hook",
          groups: [
            {
              value: "mistake",
              sampleCount: 2,
              realSampleCount: 2,
              median: 0.3,
              mean: 0.3,
              diff: 0.1,
              lowSample: true,
              recordIds: ["pub_1"],
            },
          ],
        },
      ],
      note: "相关性非因果",
      computedAt: "2026-09-24T00:00:00.000Z",
    });
    const res = await app.request("/factors");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dimensions[0].groups[0]).toMatchObject({ sampleCount: 2, lowSample: true });
    expect(getFactorAnalysis).toHaveBeenCalledWith({
      metric: "completion_rate",
      dimensions: ["hook", "scene", "durationBand", "template"],
      // 批次二：未传 platform/days 时保持既有全平台全历史口径（不隐含收窄样本）
      scope: { platform: null, windowDays: null },
    });
  });

  it("指定维度白名单；非法指标/维度 → 400", async () => {
    vi.mocked(getFactorAnalysis).mockResolvedValue({
      metric: "like_rate",
      accountMedian: null,
      accountSampleCount: 0,
      accountRealSampleCount: 0,
      scope: { platform: null, windowDays: null },
      mixedPlatform: false,
      platforms: [],
      dimensions: [],
      note: "",
      computedAt: "2026-09-24T00:00:00.000Z",
    });
    const ok = await app.request("/factors?metric=like_rate&dimensions=voice,promptVersion");
    expect(ok.status).toBe(200);
    expect(getFactorAnalysis).toHaveBeenLastCalledWith({
      metric: "like_rate",
      dimensions: ["voice", "promptVersion"],
      scope: { platform: null, windowDays: null },
    });
    expect((await app.request("/factors?metric=budget")).status).toBe(400);
    expect((await app.request("/factors?dimensions=nickname")).status).toBe(400);
  });

  it("GET 纯读：不调用留档编排 persistFactorAnalysis（批次 5B：无隐蔽写副作用）", async () => {
    vi.mocked(getFactorAnalysis).mockResolvedValue({
      metric: "completion_rate",
      accountMedian: null,
      accountSampleCount: 0,
      accountRealSampleCount: 0,
      scope: { platform: null, windowDays: null },
      mixedPlatform: false,
      platforms: [],
      dimensions: [],
      note: "",
      computedAt: "2026-09-26T00:00:00.000Z",
    });
    await app.request("/factors");
    expect(persistFactorAnalysis).not.toHaveBeenCalled();
  });
});

describe("POST /api/analytics/factors（批次 5B 显式重算留档）", () => {
  it("合法体 → 200 且调用 persistFactorAnalysis（白名单默认补全）", async () => {
    vi.mocked(persistFactorAnalysis).mockResolvedValue({
      metric: "completion_rate",
      accountMedian: 0.2,
      accountSampleCount: 3,
      accountRealSampleCount: 3,
      scope: { platform: null, windowDays: null },
      mixedPlatform: false,
      platforms: [],
      dimensions: [{ dimension: "hook", groups: [] }],
      note: "相关性非因果",
      computedAt: "2026-09-26T00:00:00.000Z",
      analysisResultId: 77,
    });
    const res = await app.request("/factors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dimensions: ["hook", "scene"] }),
    });
    expect(res.status).toBe(200);
    expect(persistFactorAnalysis).toHaveBeenCalledWith({
      metric: "completion_rate",
      dimensions: ["hook", "scene"],
    });
  });

  it("留档写失败 → 500（不再静默降级）", async () => {
    vi.mocked(persistFactorAnalysis).mockRejectedValue(new Error("db down"));
    const res = await app.request("/factors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ metric: "play_count" }),
    });
    expect(res.status).toBe(500);
  });

  it("维度不在白名单 → 400", async () => {
    const res = await app.request("/factors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dimensions: ["nickname"] }),
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/analytics/videos/{contentId}/timeline（Phase 3 时间轴）", () => {
  it("返回生产口径派生段落（带来源标注）", async () => {
    vi.mocked(loadContentSegments).mockResolvedValue([
      {
        idx: 0,
        startTime: 0,
        endTime: 1,
        segmentType: "intro",
        dialogue: "Three.js 主题片头",
        knowledgePoint: null,
        scene: null,
        emotion: null,
        shotType: null,
        sourceType: "PLATFORM_CALCULATED",
      },
    ] as never);
    const res = await app.request("/videos/cnt_x/timeline");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.emptyReason).toBeNull();
    expect(body.segments[0]).toMatchObject({
      segmentType: "intro",
      sourceType: "PLATFORM_CALCULATED",
    });
  });

  it("未派生 → emptyReason=not_derived（不猜）", async () => {
    vi.mocked(loadContentSegments).mockResolvedValue([]);
    const body = await (await app.request("/videos/cnt_x/timeline")).json();
    expect(body).toEqual({ segments: [], emptyReason: "not_derived" });
  });
});

describe("Phase 4 建议与结构复用端点", () => {
  const recView = {
    id: "rec_test001",
    recommendationType: "hook",
    recommendation: { value: "mistake", label: "错误示范", kindLabel: "推荐 Hook" },
    reason: "推荐 Hook「错误示范」组 completion_rate 中位 50.0%（n=10）",
    sourceSampleCount: 10,
    sourceMetric: "completion_rate",
    confidence: 0.5,
    accepted: null,
    appliedToContentId: null,
    createdAt: "2026-09-24T00:00:00.000Z",
  };

  it("GET /recommendations 透传清单与采纳汇总", async () => {
    vi.mocked(listRecommendations).mockResolvedValue({
      items: [recView],
      summary: { total: 1, pending: 1, accepted: 0, rejected: 0, applied: 0 },
    });
    const res = await app.request("/recommendations");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items[0].recommendation).toMatchObject({ value: "mistake", label: "错误示范" });
    expect(body.summary.pending).toBe(1);
  });

  it("POST /recommendations/generate 返回生成条数", async () => {
    vi.mocked(generateRecommendations).mockResolvedValue(3);
    const res = await app.request("/recommendations/generate", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ created: 3 });
  });

  it("POST /recommendations/{id}/applications 登记采纳：只上交预填值，建议值由服务端读", async () => {
    vi.mocked(recordRecommendationApplication).mockResolvedValue({
      kind: "created",
      id: "recapp_1",
      targetMetric: "completion_rate",
      analysisResultId: 77,
    });
    const res = await app.request("/recommendations/rec_test001/applications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prefillParams: { rate: 0.85 } }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({
      id: "recapp_1",
      targetMetric: "completion_rate",
      analysisResultId: 77,
    });
    expect(recordRecommendationApplication).toHaveBeenCalledWith({
      recommendationId: "rec_test001",
      prefillParams: { rate: 0.85 },
    });
  });

  it("POST /recommendations/{id}/applications：建议不存在 → 404（不给幽灵建议记采纳）", async () => {
    vi.mocked(recordRecommendationApplication).mockResolvedValue({
      kind: "recommendation-not-found",
    });
    const res = await app.request("/recommendations/rec_none/applications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prefillParams: {} }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /recommendation-applications/{id}/bind 写入用户最终参数；409 拒绝二次覆盖", async () => {
    vi.mocked(bindRecommendationApplication).mockResolvedValue("bound");
    const ok = await app.request("/recommendation-applications/recapp_1/bind", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contentId: "cnt_x", finalParams: { media: { rate: 1.05 } } }),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ id: "recapp_1", bound: true });
    expect(bindRecommendationApplication).toHaveBeenCalledWith("recapp_1", {
      contentId: "cnt_x",
      finalParams: { media: { rate: 1.05 } },
    });

    vi.mocked(bindRecommendationApplication).mockResolvedValue("already-bound");
    expect(
      (
        await app.request("/recommendation-applications/recapp_1/bind", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ contentId: "cnt_y", finalParams: {} }),
        })
      ).status,
    ).toBe(409);

    vi.mocked(bindRecommendationApplication).mockResolvedValue("content-not-found");
    const missing = await app.request("/recommendation-applications/recapp_1/bind", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ contentId: "cnt_none", finalParams: {} }),
    });
    expect(missing.status).toBe(404);
  });

  it("bind 缺 contentId 或非法 applicationId → 400（不接空绑定）", async () => {
    const res = await app.request("/recommendation-applications/recapp_1/bind", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ finalParams: {} }),
    });
    expect(res.status).toBe(400);
    expect(
      (
        await app.request("/recommendation-applications//bind", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ contentId: "c", finalParams: {} }),
        })
      ).status,
    ).not.toBe(200);
  });

  it("GET /recommendations/{id}/evidence 透出快照口径、参与视频与导入原始行", async () => {
    vi.mocked(getRecommendationEvidence).mockResolvedValue({
      recommendationId: "rec_test001",
      recommendationType: "hook",
      recommendation: { value: "mistake", label: "错误示范", kindLabel: "推荐 Hook" },
      reason: "抖音 · 近 90 天",
      targetMetric: "completion_rate",
      sourceSampleCount: 9,
      analysisResultId: 77,
      status: "traceable",
      unavailableReasons: [],
      snapshot: {
        analysisType: "factors:completion_rate",
        modelVersion: "group-stats-v1",
        computedAt: "2026-10-04T00:00:00.000Z",
        scope: { platform: "抖音", windowDays: 90 },
        accountMedian: 0.3,
        accountSampleCount: 12,
        accountRealSampleCount: 9,
      },
      groups: [
        {
          dimension: "hook",
          value: "mistake",
          sampleCount: 9,
          realSampleCount: 9,
          median: 0.45,
          mean: 0.45,
          recordIds: ["pub_1"],
        },
      ],
      videos: [
        {
          recordId: "pub_1",
          contentId: "cnt_1",
          title: "机场英语",
          platform: "抖音",
          platformVideoId: "7432",
          publishStatus: "published",
          publishTime: "2026-10-01T00:00:00.000Z",
          publishTimeSource: "PLATFORM_IMPORTED",
          videoAssetId: "a.mp4",
          metrics: {
            completion_rate: {
              value: 0.45,
              sourceType: "CREATOR_IMPORT",
              sourceField: "完播率",
              dataDate: "2026-10-02",
              isEstimated: false,
              batchId: "imp_1",
              importRowNumber: 3,
              matchedBy: "operator_confirm",
            },
          },
          features: { hook: "mistake" },
          fieldSources: { hook: "USER_INPUT" },
          auditAvailable: true,
          auditInputKeys: ["topic", "level"],
        },
      ],
      importRows: [
        {
          batchId: "imp_1",
          rowNumber: 3,
          filename: "抖音导出.csv",
          batchPlatform: "抖音",
          batchStatus: "committed",
          rawData: { 完播率: "45%" },
          matchStatus: "confirmed",
          decisionType: "operator_confirm",
        },
      ],
    });
    const res = await app.request("/recommendations/rec_test001/evidence");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("traceable");
    // 端到端可追溯：字段名 + 批次 + 原始行号 + 原始整行都在响应里
    expect(body.videos[0].metrics.completion_rate).toMatchObject({
      sourceField: "完播率",
      batchId: "imp_1",
      importRowNumber: 3,
    });
    expect(body.importRows[0].rawData).toMatchObject({ 完播率: "45%" });
  });

  it("GET evidence：建议不存在 404；缺快照 200 + evidence_unavailable（不拼猜测证据）", async () => {
    vi.mocked(getRecommendationEvidence).mockResolvedValue(null);
    expect((await app.request("/recommendations/rec_none/evidence")).status).toBe(404);

    vi.mocked(getRecommendationEvidence).mockResolvedValue({
      recommendationId: "rec_old",
      recommendationType: "hook",
      recommendation: { value: "mistake", label: "错误示范", kindLabel: "推荐 Hook" },
      reason: "历史建议",
      targetMetric: "completion_rate",
      sourceSampleCount: 9,
      analysisResultId: null,
      status: "evidence_unavailable",
      unavailableReasons: ["该建议产出时尚未留档因子快照，无法回放分组统计与参与样本"],
      snapshot: null,
      groups: [],
      videos: [],
      importRows: [],
    });
    const res = await app.request("/recommendations/rec_old/evidence");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("evidence_unavailable");
    expect(body.videos).toEqual([]);
  });

  it("PATCH /recommendations/{id} 采纳/忽略；不存在 → 404", async () => {
    vi.mocked(decideRecommendation).mockResolvedValue({ ...recView, accepted: false });
    const res = await app.request("/recommendations/rec_test001", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accepted: false }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).accepted).toBe(false);
    expect(decideRecommendation).toHaveBeenCalledWith("rec_test001", { accepted: false });
    vi.mocked(decideRecommendation).mockResolvedValue(null);
    expect(
      (
        await app.request("/recommendations/rec_none", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accepted: true }),
        })
      ).status,
    ).toBe(404);
  });

  it("GET /videos/{id}/structure 返回骨架；未派生 → not_derived", async () => {
    vi.mocked(getVideoStructure).mockResolvedValue({
      skeleton: [
        {
          idx: 0,
          segmentType: "intro",
          label: "片头",
          startTime: 0,
          endTime: 1,
          durationShare: 0.021,
          knowledgePoint: null,
        },
      ],
      totalDuration: 48,
    });
    const res = await app.request("/videos/cnt_x/structure");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skeleton[0].label).toBe("片头");
    expect(body.emptyReason).toBeNull();
    vi.mocked(getVideoStructure).mockResolvedValue(null);
    const empty = await (await app.request("/videos/cnt_y/structure")).json();
    expect(empty).toMatchObject({ skeleton: [], emptyReason: "not_derived" });
  });
});

describe("Phase 6 内容实验端点", () => {
  const expView = {
    id: "exp_test001",
    variable: "hook",
    variantA: { label: "错误示范", contentIds: ["cnt_a"] },
    variantB: { label: "提问", contentIds: ["cnt_b"] },
    controlVariables: { template: "保持一致" },
    targetMetric: "completion_rate",
    startAt: null,
    endAt: null,
    status: "draft",
    result: null,
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
  };

  it("GET /experiments 列表透传", async () => {
    vi.mocked(listExperiments).mockResolvedValue([expView] as never);
    const body = await (await app.request("/experiments")).json();
    expect(body.items[0]).toMatchObject({ id: "exp_test001", status: "draft" });
  });

  it("POST /experiments：白名单/相交校验 400；合法 201", async () => {
    const bad = await app.request("/experiments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        variable: "vibes",
        variantA: { label: "a", contentIds: ["c1"] },
        variantB: { label: "b", contentIds: ["c1"] },
      }),
    });
    expect(bad.status).toBe(400);
    const badBody = await bad.json();
    expect(badBody.error.message).toContain("白名单");
    vi.mocked(createExperiment).mockResolvedValue(expView as never);
    const ok = await app.request("/experiments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        variable: "hook",
        variantA: { label: "错误示范", contentIds: ["cnt_a"] },
        variantB: { label: "提问", contentIds: ["cnt_b"] },
      }),
    });
    expect(ok.status).toBe(201);
  });

  it("POST /experiments/{id}/evaluate：评估快照回传；不存在 404", async () => {
    vi.mocked(evaluateExperimentById).mockResolvedValue({
      kind: "ok",
      experiment: {
        ...expView,
        status: "completed",
        result: {
          targetMetric: "completion_rate",
          medianA: 0.5,
          medianB: 0.3,
          diff: -0.2,
          sampleA: 8,
          sampleB: 8,
          lowSample: false,
          verdict: "B 组中位较 A 组低 20.0pp",
          note: "相关性非因果",
          modelVersion: "ab-descriptive-v1",
          evaluatedAt: "2026-09-24T00:00:00.000Z",
        },
      },
    } as never);
    const res = await app.request("/experiments/exp_test001/evaluate", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.verdict).toContain("20.0pp");
    vi.mocked(evaluateExperimentById).mockResolvedValue({ kind: "not-found" } as never);
    expect((await app.request("/experiments/exp_none/evaluate", { method: "POST" })).status).toBe(
      404,
    );
  });

  it("PATCH /experiments/{id}/status：completed 不可手改 → 404", async () => {
    vi.mocked(updateExperimentStatus).mockResolvedValue(null);
    const res = await app.request("/experiments/exp_done/status", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "running" }),
    });
    expect(res.status).toBe(404);
  });

  const jsonHeaders = { "content-type": "application/json" };
  const assignmentFixture = {
    id: "expa_1",
    experimentId: "exp_test001",
    contentId: null,
    variant: "A" as const,
    assignmentMethod: "operator_selected",
    assignedParams: { variantLabel: "提问开场" },
    finalParams: null,
    assignedAt: "2026-10-04T00:00:00.000Z",
    boundAt: null,
  };

  it("POST /experiments/{id}/assignments：201 回读台账；404 / 409 / variant 非 A-B 400", async () => {
    vi.mocked(createExperimentAssignment).mockResolvedValue({
      kind: "created",
      assignment: assignmentFixture,
    } as never);
    const ok = await app.request("/experiments/exp_test001/assignments", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ variant: "A", assignedParams: { variantLabel: "提问开场" } }),
    });
    expect(ok.status).toBe(201);
    expect((await ok.json()).id).toBe("expa_1");
    expect(vi.mocked(createExperimentAssignment)).toHaveBeenCalledWith({
      experimentId: "exp_test001",
      variant: "A",
      assignedParams: { variantLabel: "提问开场" },
    });

    vi.mocked(createExperimentAssignment).mockResolvedValue({
      kind: "experiment-not-found",
    } as never);
    const missing = await app.request("/experiments/exp_none/assignments", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ variant: "A", assignedParams: {} }),
    });
    expect(missing.status).toBe(404);

    vi.mocked(createExperimentAssignment).mockResolvedValue({
      kind: "not-assignable",
      status: "completed",
    } as never);
    const blocked = await app.request("/experiments/exp_done/assignments", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ variant: "B", assignedParams: {} }),
    });
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error.code).toBe("EXPERIMENT_NOT_ASSIGNABLE");

    // 变体只有 A/B：第三组不存在，zod 直接拒（不入库）
    const bad = await app.request("/experiments/exp_test001/assignments", {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ variant: "C", assignedParams: {} }),
    });
    expect(bad.status).toBe(400);
  });

  it("POST .../assignments/{id}/bind：200；分配/内容不存在 404；重复绑定与失败内容 409", async () => {
    const bindBody = JSON.stringify({ contentId: "cnt_1", finalParams: { template: "quiz" } });
    vi.mocked(bindExperimentAssignment).mockResolvedValue("bound");
    const ok = await app.request("/experiments/exp_test001/assignments/expa_1/bind", {
      method: "POST",
      headers: jsonHeaders,
      body: bindBody,
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(vi.mocked(bindExperimentAssignment)).toHaveBeenCalledWith("exp_test001", "expa_1", {
      contentId: "cnt_1",
      finalParams: { template: "quiz" },
    });

    for (const [outcome, status, code] of [
      ["not-found", 404, "NOT_FOUND"],
      ["content-not-found", 404, "CONTENT_NOT_FOUND"],
      ["already-bound", 409, "ALREADY_BOUND"],
      ["content-failed", 409, "CONTENT_FAILED"],
      ["content-already-assigned", 409, "CONTENT_ALREADY_ASSIGNED"],
    ] as const) {
      vi.mocked(bindExperimentAssignment).mockResolvedValue(outcome);
      const res = await app.request("/experiments/exp_test001/assignments/expa_1/bind", {
        method: "POST",
        headers: jsonHeaders,
        body: bindBody,
      });
      expect(res.status).toBe(status);
      expect((await res.json()).error.code).toBe(code);
    }
  });

  it("GET /experiments/{id}/assignments 透传台账；实验不存在 404（不拿空列表冒充「还没有分配」）", async () => {
    vi.mocked(experimentExists).mockResolvedValue(true);
    vi.mocked(listExperimentAssignments).mockResolvedValue([assignmentFixture]);
    const res = await app.request("/experiments/exp_test001/assignments");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items[0]).toMatchObject({ id: "expa_1", variant: "A", contentId: null });
    expect(vi.mocked(listExperimentAssignments)).toHaveBeenCalledWith("exp_test001");

    vi.mocked(experimentExists).mockResolvedValue(false);
    const missing = await app.request("/experiments/exp_none/assignments");
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("NOT_FOUND");
    expect(vi.mocked(listExperimentAssignments)).not.toHaveBeenCalledWith("exp_none");
  });
});
