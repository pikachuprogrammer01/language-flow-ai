// 看板领域路由（批次 5C 自 routes/analytics.ts 拆分，行为逐字不变）
// GET /overview · /videos · /videos/{contentId}/benchmark · /videos/{contentId}/trend
import { createRoute, z } from "@hono/zod-openapi";
import { API_TAGS } from "../../lib/api-convention";
import { internalError } from "../../lib/api-error";
import { logger } from "../../lib/logger";
import {
  getAnalyticsOverview,
  getBenchmark,
  getDailyTrend,
  listAnalyticsVideos,
} from "../../services/analytics-dashboard.service";
import {
  analyticsRoute,
  contentIdParam,
  dateSchema,
  levelEnum,
  metricCellSchema,
  templateEnum,
} from "./shared";

const funnelStageSchema = z.object({
  key: z.string(),
  label: z.string(),
  kind: z.enum(["count", "rate", "creator"]),
  value: z.number().nullable(),
  previousValue: z.number().nullable(),
  /** 逐级转化：仅 stepRateState="computed" 时非空；null 是诚实不可比，不是错误 */
  stepRate: z.number().nullable(),
  stepRateState: z.enum([
    "first",
    "computed",
    "coverage-mismatch",
    "inverted",
    "missing",
    "standalone",
  ]),
  /** 相对本阶段覆盖播放（basisPlays）的占比；creator 阶段 null */
  shareOfPlays: z.number().nullable(),
  /** video 阶段=参与折算记录数；creator 阶段=窗口内参与折算的账号日行数 */
  coverageCount: z.number(),
  /** 窗口内发布记录总数（覆盖率分母） */
  windowRecordCount: z.number(),
  /** 本阶段覆盖记录的播放量合计（折算/占比分母） */
  basisPlays: z.number().nullable(),
  changePct: z.number().nullable(),
  sourceTypes: z.array(z.string()),
  emptyReason: z.string().nullable(),
  note: z.string().optional(),
});

const overviewRoute = createRoute({
  method: "get",
  path: "/overview",
  tags: [API_TAGS.analytics],
  operationId: "getAnalyticsOverview",
  summary: "分析首页：视频观看漏斗（播放→2秒→5秒→完播→主页）+ 账号增长独立项 + 上一周期对比",
  description:
    "窗口内有发布才计入；各阶段携来源与 emptyReason（无数据 ≠ 0）。逐级转化 stepRate 仅在相邻阶段覆盖记录集一致且数值不倒挂时给出（stepRateState 枚举说明不可比原因，绝不截断伪造百分比）；shareOfPlays 分母为本阶段覆盖记录播放合计 basisPlays；「关注」为账号级日新增合计，独立不入观看漏斗链路。",
  request: {
    query: z.object({
      days: z.coerce.number().int().min(1).max(365).optional().default(7),
    }),
  },
  responses: {
    200: {
      description: "漏斗视图",
      content: {
        "application/json": {
          schema: z.object({
            days: z.number(),
            from: z.string(),
            to: z.string(),
            previousFrom: z.string(),
            previousTo: z.string(),
            publishedVideos: z.number(),
            previousPublishedVideos: z.number(),
            stages: z.array(funnelStageSchema),
            emptyReason: z.string().nullable(),
          }),
        },
      },
    },
    500: { description: "查询失败" },
  },
});

analyticsRoute.openapi(overviewRoute, async (c) => {
  try {
    return c.json(await getAnalyticsOverview(c.req.valid("query").days), 200);
  } catch (e) {
    logger.error({ err: e }, "analytics overview 查询失败");
    return c.json(internalError(), 500);
  }
});

const videosListRoute = createRoute({
  method: "get",
  path: "/videos",
  tags: [API_TAGS.analytics],
  operationId: "listAnalyticsVideos",
  summary: "视频表现列表（多发布记录逐行；排序白名单，缺数据恒排末）",
  description:
    "行集以 publish_records 为锚点：有成片但未登记发布记录的集不在 items 内，改由 unregisteredContentCount 显式点破（未标记发布的集本就没有平台侧指标，不占一行空数据）。",
  request: {
    query: z.object({
      sort: z
        .enum(["play", "completion", "engagement", "fans", "publish_time"])
        .optional()
        .default("play"),
      order: z.enum(["asc", "desc"]).optional().default("desc"),
      page: z.coerce.number().int().min(1).optional().default(1),
      pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
    }),
  },
  responses: {
    200: {
      description: "表现列表（metrics 为 canonical 名→带来源单元格；缺失键=无数据，非 0）",
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(
              z.object({
                recordId: z.string(),
                contentId: z.string(),
                platform: z.string(),
                platformVideoId: z.string().nullable(),
                title: z.string(),
                template: templateEnum,
                level: levelEnum,
                durationSec: z.number().nullable(),
                publishTime: z.string().nullable(),
                metrics: z.record(metricCellSchema),
              }),
            ),
            total: z.number(),
            page: z.number(),
            pageSize: z.number(),
            unregisteredContentCount: z.number(),
          }),
        },
      },
    },
    500: { description: "查询失败" },
  },
});

analyticsRoute.openapi(videosListRoute, async (c) => {
  const query = c.req.valid("query");
  try {
    return c.json(
      await listAnalyticsVideos(
        { sort: query.sort, order: query.order },
        query.page,
        query.pageSize,
      ),
      200,
    );
  } catch (e) {
    logger.error({ err: e }, "analytics videos 列表失败");
    return c.json(internalError(), 500);
  }
});

const benchmarkRoute = createRoute({
  method: "get",
  path: "/videos/{contentId}/benchmark",
  tags: [API_TAGS.analytics],
  operationId: "getAnalyticsBenchmark",
  summary: "同类 Benchmark（当前账号×同模板×相似时长带×同场景/形态；必须同时展示样本数）",
  description:
    "拒绝写死行业阈值（需求 §十五）：以账号自身同类分组的中位数/均值为基准；lowSample=true（组内样本 <8）时前端必须提示样本不足，禁止据此下结论。",
  request: { params: contentIdParam },
  responses: {
    200: {
      description: "分组基准视图",
      content: {
        "application/json": {
          schema: z.object({
            subject: z.object({
              contentId: z.string(),
              group: z.object({
                template: z.string(),
                scene: z.string().nullable(),
                contentFormat: z.string().nullable(),
                durationBand: z.string().nullable(),
              }),
            }),
            sampleCount: z.number(),
            lowSample: z.boolean(),
            metrics: z.record(
              z.object({
                self: metricCellSchema.nullable(),
                groupMedian: z.number().nullable(),
                groupMean: z.number().nullable(),
                diff: z.number().nullable(),
                sampleCount: z.number(),
              }),
            ),
            emptyReason: z.string().nullable(),
          }),
        },
      },
    },
    500: { description: "查询失败" },
  },
});

analyticsRoute.openapi(benchmarkRoute, async (c) => {
  const { contentId } = c.req.valid("param");
  try {
    return c.json(await getBenchmark(contentId), 200);
  } catch (e) {
    logger.error({ err: e, contentId }, "analytics benchmark 查询失败");
    return c.json(internalError(), 500);
  }
});

const trendRoute = createRoute({
  method: "get",
  path: "/videos/{contentId}/trend",
  tags: [API_TAGS.analytics],
  operationId: "getAnalyticsTrend",
  summary: "单视频每日快照趋势（D0~D30 观察；不补 0，缺日无点；无秒级留存不造假曲线）",
  request: {
    params: contentIdParam,
    query: z.object({ dateFrom: dateSchema.optional(), dateTo: dateSchema.optional() }),
  },
  responses: {
    200: {
      description: "逐发布记录的指标时间序列（空数组=未导入，前端展示暂无数据）",
      content: {
        "application/json": {
          schema: z.object({
            records: z.array(
              z.object({
                recordId: z.string(),
                platform: z.string(),
                series: z.array(
                  z.object({
                    metricName: z.string(),
                    points: z.array(
                      z.object({ date: z.string(), value: z.number(), sourceType: z.string() }),
                    ),
                  }),
                ),
              }),
            ),
          }),
        },
      },
    },
    500: { description: "查询失败" },
  },
});

analyticsRoute.openapi(trendRoute, async (c) => {
  const { contentId } = c.req.valid("param");
  try {
    return c.json({ records: await getDailyTrend(contentId, c.req.valid("query")) }, 200);
  } catch (e) {
    logger.error({ err: e, contentId }, "analytics trend 查询失败");
    return c.json(internalError(), 500);
  }
});
