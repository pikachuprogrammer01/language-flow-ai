// 数据接入领域路由（批次 5C 自 routes/analytics.ts 拆分，行为逐字不变）
// videos/{contentId}/metrics · import · metric-catalog · creator-daily(GET/POST) · creator-daily/import
import { randomBytes } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import {
  CANONICAL_METRICS,
  CREATOR_DAILY_FIELDS,
  IMPORTABLE_SOURCE_TYPES,
  METRIC_SOURCE_TYPES,
} from "../../lib/analytics-taxonomy";
import { API_TAGS } from "../../lib/api-convention";
import { apiError, internalError } from "../../lib/api-error";
import { logger } from "../../lib/logger";
import {
  getRecordMetrics,
  importCreatorDaily,
  importMetrics,
  listCreatorDaily,
  upsertCreatorDaily,
} from "../../services/analytics-metrics.service";
import { analyticsRoute, contentIdParam, dateSchema, metricViewSchema } from "./shared";

const videoMetricsRoute = createRoute({
  method: "get",
  path: "/videos/{contentId}/metrics",
  tags: [API_TAGS.analytics],
  operationId: "getAnalyticsVideoMetrics",
  summary: "单视频指标：最新值 + 每日快照（多平台逐发布记录返回）",
  request: {
    params: contentIdParam,
    query: z.object({
      platform: z.string().max(50).optional(),
      dateFrom: dateSchema.optional(),
      dateTo: dateSchema.optional(),
    }),
  },
  responses: {
    200: {
      description:
        "指标视图；emptyReason 表达 Empty State 原因（not_published=尚无发布记录 / not_imported=指标未导入 / null=有数据），无数据不得渲染为 0",
      content: {
        "application/json": {
          schema: z.object({
            records: z.array(
              z.object({
                recordId: z.string(),
                platform: z.string(),
                platformVideoId: z.string().nullable(),
                publishTime: z.string().nullable(),
                latest: z.array(metricViewSchema),
                daily: z.array(metricViewSchema),
              }),
            ),
            emptyReason: z.string().nullable(),
          }),
        },
      },
    },
    404: { description: "内容不存在" },
    500: { description: "查询失败" },
  },
});

analyticsRoute.openapi(videoMetricsRoute, async (c) => {
  const { contentId } = c.req.valid("param");
  try {
    const view = await getRecordMetrics(contentId, c.req.valid("query"));
    if (view.emptyReason === "content_not_found") {
      return c.json(apiError("NOT_FOUND", "内容不存在"), 404);
    }
    return c.json(view, 200);
  } catch (e) {
    logger.error({ err: e, contentId }, "analytics 指标查询失败");
    return c.json(internalError(), 500);
  }
});

const importRoute = createRoute({
  method: "post",
  path: "/import",
  tags: [API_TAGS.analytics],
  operationId: "importAnalyticsMetrics",
  summary: "创作者后台数据导入（动态字段映射；外部列名不写死）",
  description:
    "sourceType 仅允许 CREATOR_IMPORT / USER_INPUT：导入数据不得伪装为平台官方 API 来源（需求 §二十二；抖音开放平台通道已砍除，外部绩效数据唯一入口即本端点）。" +
    "未映射字段逐行返回 skipped 原因，不静默丢弃；派生指标由平台导入后统一重算，不接受导入。",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            sourceType: z.enum(IMPORTABLE_SOURCE_TYPES).optional().default("CREATOR_IMPORT"),
            metricMapping: z
              .record(z.string().min(1).max(64))
              .refine(
                (m) => Object.keys(m).length > 0,
                "metricMapping 至少包含一条 外部列→canonical指标 映射",
              ),
            dataDate: dateSchema.optional(),
            rows: z
              .array(
                z.object({
                  match: z.object({
                    recordId: z.string().max(32).optional(),
                    platformVideoId: z.string().max(100).optional(),
                    platform: z.string().max(50).optional(),
                    contentId: z.string().max(32).optional(),
                  }),
                  values: z.record(z.union([z.number(), z.string(), z.null()])),
                  dataDate: dateSchema.optional(),
                }),
              )
              .min(1)
              .max(500),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "逐行处理结果（部分成功语义：ok=false 行带 error，不整单回滚）",
      content: {
        "application/json": {
          schema: z.object({
            results: z.array(
              z.object({
                row: z.number(),
                ok: z.boolean(),
                recordId: z.string().nullable(),
                written: z.array(z.string()),
                skipped: z.array(z.object({ field: z.string(), reason: z.string() })),
                derived: z.array(z.string()),
                error: z.string().optional(),
              }),
            ),
            summary: z.object({
              total: z.number(),
              succeeded: z.number(),
              failed: z.number(),
              /** 请求级批次号（批次 3B）：写入行的 metadata.batch_id 同一此值，供事后审计/回滚定位 */
              batchId: z.string(),
            }),
          }),
        },
      },
    },
    400: { description: "参数不合法（映射为空 / 超出行数上限等）" },
    500: { description: "导入失败" },
  },
});

analyticsRoute.openapi(importRoute, async (c) => {
  const body = c.req.valid("json");
  try {
    const batchId = randomBytes(4).toString("hex");
    const results = await importMetrics({ ...body, sourceType: body.sourceType, batchId });
    return c.json(
      {
        results,
        summary: {
          total: results.length,
          succeeded: results.filter((r) => r.ok).length,
          failed: results.filter((r) => !r.ok).length,
          batchId,
        },
      },
      200,
    );
  } catch (e) {
    logger.error({ err: e }, "analytics 导入失败");
    return c.json(internalError(), 500);
  }
});

const catalogRoute = createRoute({
  method: "get",
  path: "/metric-catalog",
  tags: [API_TAGS.analytics],
  operationId: "getAnalyticsMetricCatalog",
  summary: "canonical 指标目录（含 availability 分级，前端动态渲染不写死字段）",
  responses: {
    200: {
      description: "指标目录（视频级 canonical + 账号日字段目录，前端动态渲染不写死）",
      content: {
        "application/json": {
          schema: z.object({
            metrics: z.array(
              z.object({
                name: z.string(),
                label: z.string(),
                unit: z.string(),
                availability: z.string(),
                formula: z.string().optional(),
                importable: z.boolean(),
                note: z.string().optional(),
              }),
            ),
            creatorDailyFields: z.array(
              z.object({
                name: z.string(),
                label: z.string(),
                unit: z.string(),
                note: z.string().optional(),
              }),
            ),
            sourceTypes: z.array(z.enum(METRIC_SOURCE_TYPES)),
          }),
        },
      },
    },
  },
});

analyticsRoute.openapi(catalogRoute, async (c) => {
  return c.json(
    {
      metrics: CANONICAL_METRICS.map((m) => ({ ...m })),
      creatorDailyFields: CREATOR_DAILY_FIELDS.map((f) => ({ ...f })),
      sourceTypes: [...METRIC_SOURCE_TYPES],
    },
    200,
  );
});

// ── 账号每日聚合 ──

const creatorDailyBodySchema = z.object({
  platform: z.string().min(1).max(50),
  date: dateSchema,
  sourceType: z.enum(IMPORTABLE_SOURCE_TYPES).optional().default("CREATOR_IMPORT"),
  playIncrement: z.number().int().min(0).nullable().optional(),
  likeIncrement: z.number().int().min(0).nullable().optional(),
  commentIncrement: z.number().int().min(0).nullable().optional(),
  shareIncrement: z.number().int().min(0).nullable().optional(),
  profileUV: z.number().int().min(0).nullable().optional(),
  newFans: z.number().int().min(0).nullable().optional(),
  totalFans: z.number().int().min(0).nullable().optional(),
});

const upsertCreatorDailyRoute = createRoute({
  method: "post",
  path: "/creator-daily",
  tags: [API_TAGS.analytics],
  operationId: "upsertAnalyticsCreatorDaily",
  summary: "账号每日聚合指标写入（(platform, date) 幂等 upsert；不自动归因到单视频）",
  request: {
    body: { content: { "application/json": { schema: creatorDailyBodySchema } } },
  },
  responses: {
    200: {
      description: "写入成功",
      content: {
        "application/json": { schema: z.object({ ok: z.literal(true), date: z.string() }) },
      },
    },
    400: { description: "参数不合法" },
    500: { description: "写入失败" },
  },
});

analyticsRoute.openapi(upsertCreatorDailyRoute, async (c) => {
  const body = c.req.valid("json");
  try {
    await upsertCreatorDaily(body);
    return c.json({ ok: true as const, date: body.date }, 200);
  } catch (e) {
    logger.error({ err: e }, "analytics creator-daily 写入失败");
    return c.json(internalError(), 500);
  }
});

const listCreatorDailyRoute = createRoute({
  method: "get",
  path: "/creator-daily",
  tags: [API_TAGS.analytics],
  operationId: "listAnalyticsCreatorDaily",
  summary: "账号每日聚合指标查询（日期范围，最多 366 条）",
  request: {
    query: z.object({
      platform: z.string().max(50).optional(),
      dateFrom: dateSchema.optional(),
      dateTo: dateSchema.optional(),
    }),
  },
  responses: {
    200: {
      description: "聚合列表（无数据返回空数组，不补 0）",
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(
              z.object({
                platform: z.string(),
                date: z.string(),
                playIncrement: z.number().int().nullable(),
                likeIncrement: z.number().int().nullable(),
                commentIncrement: z.number().int().nullable(),
                shareIncrement: z.number().int().nullable(),
                profileUV: z.number().int().nullable(),
                newFans: z.number().int().nullable(),
                totalFans: z.number().int().nullable(),
                bounceRate2s: z.number().nullable(),
                watchRate5s: z.number().nullable(),
                avgWatchTime: z.number().nullable(),
                postCount: z.number().int().nullable(),
                coverClickRate: z.number().nullable(),
                sourceType: z.enum(METRIC_SOURCE_TYPES),
                fetchedAt: z.string(),
              }),
            ),
          }),
        },
      },
    },
    500: { description: "查询失败" },
  },
});

analyticsRoute.openapi(listCreatorDailyRoute, async (c) => {
  try {
    const items = await listCreatorDaily(c.req.valid("query"));
    return c.json({ items }, 200);
  } catch (e) {
    logger.error({ err: e }, "analytics creator-daily 查询失败");
    return c.json(internalError(), 500);
  }
});

// ── 账号日汇总批量导入（导入向导：操作者逐行裁决归属，系统不自动拆数） ──

const importCreatorDailyRoute = createRoute({
  method: "post",
  path: "/creator-daily/import",
  tags: [API_TAGS.analytics],
  operationId: "importAnalyticsCreatorDaily",
  summary: "账号日汇总批量导入（动态字段映射 + 逐行归属裁决：仅账号级 / 归属作品近似落库）",
  description:
    "每行由操作者裁决 attribution：account=只记账号日行；video=同时把可归属字段近似写入该发布记录的 video_metrics（必携 isEstimated + 长尾声明，matched_by=operator_confirmed）。" +
    "(platform, stat_date) 幂等 upsert 仅覆盖本次提供的列；归属目标不存在/无合法值逐行回 error 不崩整单。",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            platform: z.string().min(1).max(50),
            sourceType: z.enum(IMPORTABLE_SOURCE_TYPES).optional().default("CREATOR_IMPORT"),
            fieldMapping: z
              .record(z.string().min(1).max(64))
              .refine(
                (m) => Object.keys(m).length > 0,
                "fieldMapping 至少一条 外部列→账号日字段 映射",
              ),
            rows: z
              .array(
                z.object({
                  statDate: dateSchema,
                  values: z.record(z.union([z.number(), z.string(), z.null()])),
                  attribution: z.discriminatedUnion("mode", [
                    z.object({ mode: z.literal("account") }),
                    z.object({ mode: z.literal("video"), recordId: z.string().min(1).max(32) }),
                  ]),
                }),
              )
              .min(1)
              .max(366),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "逐行处理结果（部分成功语义，不整单回滚）",
      content: {
        "application/json": {
          schema: z.object({
            results: z.array(
              z.object({
                row: z.number(),
                ok: z.boolean(),
                statDate: z.string(),
                dailyWritten: z.array(z.string()),
                videoRecordId: z.string().nullable(),
                videoWritten: z.array(z.string()),
                videoDerived: z.array(z.string()),
                skipped: z.array(z.object({ field: z.string(), reason: z.string() })),
                error: z.string().optional(),
              }),
            ),
            summary: z.object({
              total: z.number(),
              succeeded: z.number(),
              failed: z.number(),
              /** 请求级批次号（批次 3B）：账号日行与归属视频行 metadata 同一此值 */
              batchId: z.string(),
            }),
          }),
        },
      },
    },
    400: { description: "参数不合法" },
    500: { description: "导入失败" },
  },
});

analyticsRoute.openapi(importCreatorDailyRoute, async (c) => {
  const body = c.req.valid("json");
  try {
    const batchId = randomBytes(4).toString("hex");
    const results = await importCreatorDaily({ ...body, sourceType: body.sourceType, batchId });
    return c.json(
      {
        results,
        summary: {
          total: results.length,
          succeeded: results.filter((r) => r.ok).length,
          failed: results.filter((r) => !r.ok).length,
          batchId,
        },
      },
      200,
    );
  } catch (e) {
    logger.error({ err: e }, "analytics creator-daily 批量导入失败");
    return c.json(internalError(), 500);
  }
});
