// 统一内容主视图路由（docs/22 §5.1）
// GET /content-videos —— 一内容一行，平台发布记录与导入指标作为明细；旧 /videos 契约不变
import { createRoute, z } from "@hono/zod-openapi";
import { PUBLISH_TIME_SOURCES } from "../../lib/analytics-taxonomy";
import { API_TAGS } from "../../lib/api-convention";
import { internalError } from "../../lib/api-error";
import { logger } from "../../lib/logger";
import {
  CONTENT_VIDEO_SORTS,
  CONTENT_VIDEO_STATUSES,
  CONTENT_VIDEO_STATUS_FILTERS,
  listContentVideos,
} from "../../services/analytics-content-video.service";
import {
  analyticsRoute,
  levelEnum,
  metricCellSchema,
  publishStatusEnum,
  templateEnum,
} from "./shared";

const platformDetailSchema = z.object({
  recordId: z.string(),
  platform: z.string(),
  platformVideoId: z.string().nullable(),
  publishStatus: publishStatusEnum,
  publishTime: z.string().nullable(),
  /** 发布时间来处；null=旧记录无法判定（不事后编一个来源） */
  publishTimeSource: z.enum(PUBLISH_TIME_SOURCES).nullable(),
  /** 该平台上已有指标条数（0=已发布但未导入，不是「表现全是 0」） */
  metricCount: z.number(),
  /** 仍有未裁决导入冲突把这条记录列为候选 */
  hasImportConflict: z.boolean(),
  /** canonical 指标名 → 带来源单元格；缺键=无数据，非 0 */
  metrics: z.record(metricCellSchema),
});

const contentVideoItemSchema = z.object({
  contentId: z.string(),
  title: z.string(),
  template: templateEnum,
  level: levelEnum,
  /** contents.status 原值（draft…completed/failed），列表默认只放 completed */
  localStatus: z.string(),
  /** 本地生成时间；不冒充平台发布时间 */
  generatedAt: z.string(),
  videoAssetId: z.string().nullable(),
  durationSec: z.number().nullable(),
  status: z.enum(CONTENT_VIDEO_STATUSES),
  statuses: z.array(z.enum(CONTENT_VIDEO_STATUSES)),
  /** 去重平台数；同平台多条记录时小于 platforms.length */
  platformCount: z.number(),
  metricCoverage: z.object({
    platforms: z.number(),
    records: z.number(),
    recordsWithMetrics: z.number(),
  }),
  /** 平台明细：指标只在各自平台里读，主行不提供任何跨平台合计 */
  platforms: z.array(platformDetailSchema),
});

const contentVideosRoute = createRoute({
  method: "get",
  path: "/content-videos",
  tags: [API_TAGS.analytics],
  operationId: "listAnalyticsContentVideos",
  summary: "统一内容主视图（一内容一行，平台发布记录与导入指标作为明细）",
  description:
    "行锚点是 contents：本地有成片但未发布的集也在列表里（platforms=[]，status=unpublished），不为它造 local 伪平台记录。" +
    "默认只返回已完成且有真实视频产物的内容；显式 status 会放开该范围以筛出失败/删除态。" +
    "排序里的 play/completion/engagement 取该内容各平台该指标的最好值（max），跨平台口径不可比，绝不返回相加后的合计；" +
    "指标缺键表示无数据而非 0，发布时间来源为 null 表示旧记录无法判定来源。",
  request: {
    query: z.object({
      status: z.enum(CONTENT_VIDEO_STATUS_FILTERS).optional().default("all"),
      platform: z.string().max(50).optional(),
      sort: z.enum(CONTENT_VIDEO_SORTS).optional().default("created_time"),
      order: z.enum(["asc", "desc"]).optional().default("desc"),
      page: z.coerce.number().int().min(1).optional().default(1),
      pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
    }),
  },
  responses: {
    200: {
      description: "统一内容列表（分页；items 顺序跟随排序参数）",
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(contentVideoItemSchema),
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

analyticsRoute.openapi(contentVideosRoute, async (c) => {
  const query = c.req.valid("query");
  try {
    const page = await listContentVideos({
      status: query.status,
      platform: query.platform,
      sort: query.sort,
      order: query.order,
      page: query.page,
      pageSize: query.pageSize,
    });
    return c.json(page, 200);
  } catch (e) {
    logger.error({ err: e }, "analytics content-videos 列表失败");
    return c.json(internalError(), 500);
  }
});
