// 内容特征领域路由（批次 5C 自 routes/analytics.ts 拆分，行为逐字不变）
// GET/POST-sync/PATCH /features/{contentId}
import { createRoute, z } from "@hono/zod-openapi";
import { API_TAGS } from "../../lib/api-convention";
import { apiError, internalError } from "../../lib/api-error";
import { logger } from "../../lib/logger";
import {
  loadContentFeature,
  patchManualFeature,
  syncContentFeature,
  validateManualPatch,
} from "../../services/analytics-feature.service";
import { getRecordMetrics } from "../../services/analytics-metrics.service";
import { syncContentSegments } from "../../services/analytics-segment.service";
import { analyticsRoute, contentIdParam, featureSchema, toFeatureView } from "./shared";

const featureParam = contentIdParam;

const getFeatureRoute = createRoute({
  method: "get",
  path: "/features/{contentId}",
  tags: [API_TAGS.analytics],
  operationId: "getAnalyticsFeature",
  summary: "内容特征读取（生产字段 + 人工标签，含字段级来源）",
  request: { params: featureParam },
  responses: {
    200: {
      description: "特征视图（从未落库时返回 null，可先 POST /sync 重算）",
      content: { "application/json": { schema: featureSchema.nullable() } },
    },
    404: { description: "内容不存在" },
    500: { description: "查询失败" },
  },
});

analyticsRoute.openapi(getFeatureRoute, async (c) => {
  const { contentId } = c.req.valid("param");
  try {
    const feature = await loadContentFeature(contentId);
    if (feature) return c.json(toFeatureView(feature), 200);
    // 无特征行：内容存在则回 null（GET 只读不重建），内容不存在才 404
    const view = await getRecordMetrics(contentId, {});
    if (view.emptyReason === "content_not_found") {
      return c.json(apiError("NOT_FOUND", "内容不存在"), 404);
    }
    return c.json(null, 200);
  } catch (e) {
    logger.error({ err: e, contentId }, "analytics 特征读取失败");
    return c.json(internalError(), 500);
  }
});

const syncFeatureRoute = createRoute({
  method: "post",
  path: "/features/{contentId}/sync",
  tags: [API_TAGS.analytics],
  operationId: "syncAnalyticsFeature",
  summary: "生产特征重算（人工 USER_INPUT 标签保留不覆盖）",
  request: { params: featureParam },
  responses: {
    200: {
      description: "重算后的特征",
      content: { "application/json": { schema: featureSchema } },
    },
    404: { description: "内容不存在" },
    500: { description: "同步失败" },
  },
});

analyticsRoute.openapi(syncFeatureRoute, async (c) => {
  const { contentId } = c.req.valid("param");
  try {
    const feature = await syncContentFeature(contentId);
    if (!feature) return c.json(apiError("NOT_FOUND", "内容不存在"), 404);
    // 生产链路同源：特征重算时一并重建段落时间轴（失败不阻断特征返回）
    await syncContentSegments(contentId).catch((e) => {
      logger.error({ err: e, contentId }, "analytics 时间轴重建失败");
    });
    return c.json(toFeatureView(feature), 200);
  } catch (e) {
    logger.error({ err: e, contentId }, "analytics 特征同步失败");
    return c.json(internalError(), 500);
  }
});

const manualFeatureSchema = z.object({
  scene: z.string().max(32).nullable().optional(),
  hook: z.string().max(32).nullable().optional(),
  contentFormat: z.string().max(32).nullable().optional(),
  emotion: z.string().max(32).nullable().optional(),
  ctaType: z.string().max(32).nullable().optional(),
  ctaStartTime: z.number().int().min(0).nullable().optional(),
});

const patchFeatureRoute = createRoute({
  method: "patch",
  path: "/features/{contentId}",
  tags: [API_TAGS.analytics],
  operationId: "patchAnalyticsFeature",
  summary: "人工标签覆盖（taxonomy 校验；来源记为 USER_INPUT）",
  request: {
    params: featureParam,
    body: { content: { "application/json": { schema: manualFeatureSchema } } },
  },
  responses: {
    200: {
      description: "覆盖后的特征",
      content: { "application/json": { schema: featureSchema } },
    },
    400: { description: "标签值不在体系内" },
    404: { description: "内容不存在" },
    500: { description: "覆盖失败" },
  },
});

analyticsRoute.openapi(patchFeatureRoute, async (c) => {
  const { contentId } = c.req.valid("param");
  const patch = c.req.valid("json");
  const errors = validateManualPatch(patch);
  if (errors.length > 0) {
    return c.json(apiError("INVALID_TAXONOMY", errors.join("；")), 400);
  }
  try {
    const feature = await patchManualFeature(contentId, patch);
    if (!feature) return c.json(apiError("NOT_FOUND", "内容不存在"), 404);
    return c.json(toFeatureView(feature), 200);
  } catch (e) {
    logger.error({ err: e, contentId }, "analytics 特征覆盖失败");
    return c.json(internalError(), 500);
  }
});
