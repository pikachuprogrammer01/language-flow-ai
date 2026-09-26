// 发布记录领域路由（批次 5C 自 routes/analytics.ts 拆分，行为逐字不变）
// GET/POST /publish-records · PATCH/DELETE /publish-records/{recordId}
import { createRoute, z } from "@hono/zod-openapi";
import { API_TAGS } from "../../lib/api-convention";
import { apiError, internalError } from "../../lib/api-error";
import { logger } from "../../lib/logger";
import { syncContentFeature } from "../../services/analytics-feature.service";
import {
  createPublishRecord,
  deletePublishRecord,
  listPublishRecords,
  updatePublishRecord,
} from "../../services/analytics-metrics.service";
import { syncContentSegments } from "../../services/analytics-segment.service";
import { analyticsRoute, publishStatusEnum, recordItemSchema } from "./shared";

const listRecordsRoute = createRoute({
  method: "get",
  path: "/publish-records",
  tags: [API_TAGS.analytics],
  operationId: "listAnalyticsPublishRecords",
  summary: "发布记录列表（统一 ID 链路）",
  request: {
    query: z.object({
      platform: z.string().max(50).optional(),
      contentId: z.string().max(32).optional(),
      page: z.coerce.number().int().min(1).optional().default(1),
      pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
    }),
  },
  responses: {
    200: {
      description: "发布记录分页列表",
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(recordItemSchema),
            total: z.number(),
            page: z.number(),
            pageSize: z.number(),
          }),
        },
      },
    },
    500: { description: "查询失败" },
  },
});

analyticsRoute.openapi(listRecordsRoute, async (c) => {
  const query = c.req.valid("query");
  try {
    const { items, total } = await listPublishRecords(query);
    return c.json({ items, total, page: query.page, pageSize: query.pageSize }, 200);
  } catch (e) {
    logger.error({ err: e }, "analytics publish-records 列表失败");
    return c.json(internalError(), 500);
  }
});

const createRecordRoute = createRoute({
  method: "post",
  path: "/publish-records",
  tags: [API_TAGS.analytics],
  operationId: "createAnalyticsPublishRecord",
  summary: "创建发布记录（自动派生视频资产标识并触发生产特征落库）",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            contentId: z.string().min(1).max(32),
            platform: z.string().min(1).max(50),
            platformVideoId: z.string().max(100).nullable().optional(),
            publishTitle: z.string().max(255).nullable().optional(),
            publishTime: z.string().datetime().nullable().optional(),
            coverUrl: z.string().max(500).nullable().optional(),
            publishStatus: publishStatusEnum.optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "创建成功",
      content: { "application/json": { schema: z.object({ id: z.string() }) } },
    },
    400: { description: "参数不合法" },
    404: { description: "内容不存在" },
    409: { description: "同平台作品 ID 已存在发布记录" },
    500: { description: "创建失败" },
  },
});

analyticsRoute.openapi(createRecordRoute, async (c) => {
  const body = c.req.valid("json");
  try {
    const result = await createPublishRecord(body);
    if (result.kind === "content-not-found") {
      return c.json(apiError("NOT_FOUND", "内容不存在", { field: "contentId" }), 404);
    }
    if (result.kind === "duplicate") {
      return c.json(
        apiError("DUPLICATE_PLATFORM_VIDEO", "该平台作品 ID 已有发布记录（禁止重复绑定）", {
          field: "platformVideoId",
        }),
        409,
      );
    }
    // Production Feature 落库（需求 §五A：发布即固化生产事实，失败不阻断记录创建）
    await syncContentFeature(body.contentId).catch((e) => {
      logger.error({ err: e, contentId: body.contentId }, "analytics 特征自动落库失败");
    });
    await syncContentSegments(body.contentId).catch((e) => {
      logger.error({ err: e, contentId: body.contentId }, "analytics 时间轴自动落库失败");
    });
    return c.json({ id: result.id }, 201);
  } catch (e) {
    logger.error({ err: e }, "analytics publish-records 创建失败");
    return c.json(internalError(), 500);
  }
});

const patchRecordRoute = createRoute({
  method: "patch",
  path: "/publish-records/{recordId}",
  tags: [API_TAGS.analytics],
  operationId: "updateAnalyticsPublishRecord",
  summary: "更新发布记录",
  request: {
    params: z.object({ recordId: z.string().min(1).max(32) }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            platform: z.string().min(1).max(50).optional(),
            platformVideoId: z.string().max(100).nullable().optional(),
            videoAssetId: z.string().max(100).nullable().optional(),
            publishTitle: z.string().max(255).nullable().optional(),
            publishTime: z.string().datetime().nullable().optional(),
            coverUrl: z.string().max(500).nullable().optional(),
            publishStatus: publishStatusEnum.optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "更新成功",
      content: {
        "application/json": { schema: z.object({ id: z.string(), updated: z.literal(true) }) },
      },
    },
    404: { description: "发布记录不存在" },
    409: { description: "同平台作品 ID 已存在发布记录" },
    500: { description: "更新失败" },
  },
});

analyticsRoute.openapi(patchRecordRoute, async (c) => {
  const { recordId } = c.req.valid("param");
  try {
    const result = await updatePublishRecord(recordId, c.req.valid("json"));
    if (result === "not-found") return c.json(apiError("NOT_FOUND", "发布记录不存在"), 404);
    if (result === "duplicate") {
      return c.json(apiError("DUPLICATE_PLATFORM_VIDEO", "该平台作品 ID 已有发布记录"), 409);
    }
    return c.json({ id: recordId, updated: true as const }, 200);
  } catch (e) {
    logger.error({ err: e, recordId }, "analytics publish-records 更新失败");
    return c.json(internalError(), 500);
  }
});

const deleteRecordRoute = createRoute({
  method: "delete",
  path: "/publish-records/{recordId}",
  tags: [API_TAGS.analytics],
  operationId: "deleteAnalyticsPublishRecord",
  summary: "删除发布记录（关联指标级联删除）",
  request: { params: z.object({ recordId: z.string().min(1).max(32) }) },
  responses: {
    200: {
      description: "删除成功",
      content: {
        "application/json": { schema: z.object({ id: z.string(), deleted: z.literal(true) }) },
      },
    },
    404: { description: "发布记录不存在（不再对不存在的 ID 假报删除成功）" },
    500: { description: "删除失败" },
  },
});

analyticsRoute.openapi(deleteRecordRoute, async (c) => {
  const { recordId } = c.req.valid("param");
  try {
    const deleted = await deletePublishRecord(recordId);
    if (!deleted) return c.json(apiError("NOT_FOUND", "发布记录不存在"), 404);
    return c.json({ id: recordId, deleted: true as const }, 200);
  } catch (e) {
    logger.error({ err: e, recordId }, "analytics publish-records 删除失败");
    return c.json(internalError(), 500);
  }
});
