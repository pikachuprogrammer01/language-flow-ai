// 洞察领域路由（批次 5C 自 routes/analytics.ts 拆分，行为逐字不变）
// factors(GET/POST) · timeline · recommendations(list/generate/decide) · structure · experiments
import { createRoute, z } from "@hono/zod-openapi";
import { METRIC_SOURCE_TYPES } from "../../lib/analytics-taxonomy";
import { API_TAGS } from "../../lib/api-convention";
import { apiError, internalError } from "../../lib/api-error";
import { logger } from "../../lib/logger";
import {
  createExperiment,
  evaluateExperimentById,
  listExperiments,
  updateExperimentStatus,
  validateExperimentInput,
} from "../../services/analytics-experiment.service";
import {
  DEFAULT_FACTOR_DIMENSIONS,
  FACTOR_DIMENSIONS,
  FACTOR_METRICS,
  getFactorAnalysis,
  persistFactorAnalysis,
} from "../../services/analytics-factors.service";
import {
  decideRecommendation,
  generateRecommendations,
  getVideoStructure,
  listRecommendations,
} from "../../services/analytics-recommend.service";
import { loadContentSegments } from "../../services/analytics-segment.service";
import { analyticsRoute, contentIdParam } from "./shared";

// ── Phase 3 · 内容因子分析（批次 5B：GET 纯读，POST 显式留档） ──

const factorViewSchema = z.object({
  metric: z.string(),
  accountMedian: z.number().nullable(),
  accountSampleCount: z.number(),
  dimensions: z.array(
    z.object({
      dimension: z.string(),
      groups: z.array(
        z.object({
          value: z.string(),
          sampleCount: z.number(),
          median: z.number().nullable(),
          mean: z.number().nullable(),
          diff: z.number().nullable(),
          lowSample: z.boolean(),
        }),
      ),
    }),
  ),
  note: z.string(),
  computedAt: z.string(),
});

const factorsRoute = createRoute({
  method: "get",
  path: "/factors",
  tags: [API_TAGS.analytics],
  operationId: "getAnalyticsFactors",
  summary: "内容因子分析（哪些生产参数与效果同时出现；分组统计非因果，纯读不落库）",
  description:
    "需求 §十一 页面 D / §十四：早期只做分组统计（中位数/均值/样本数），不上模型；每组必携 sampleCount，<8 标 lowSample；响应 note 声明相关性非因果。批次 5B：GET 纯读不再有写副作用，留档走 POST /factors。",
  request: {
    query: z.object({
      metric: z.enum(FACTOR_METRICS).optional().default("completion_rate"),
      dimensions: z
        .string()
        .max(400)
        .optional()
        .refine(
          (v) =>
            v === undefined ||
            (v
              .split(",")
              .every((d) => (FACTOR_DIMENSIONS as readonly string[]).includes(d.trim())) &&
              v.split(",").length <= FACTOR_DIMENSIONS.length),
          `dimensions 为逗号分隔白名单：${FACTOR_DIMENSIONS.join("/")}`,
        ),
    }),
  },
  responses: {
    200: {
      description: "因子分析结果（含账号整体中位基准与 note 诚实声明；不写入任何表）",
      content: {
        "application/json": {
          schema: factorViewSchema,
        },
      },
    },
    400: { description: "指标/维度不在白名单" },
    500: { description: "分析失败" },
  },
});

analyticsRoute.openapi(factorsRoute, async (c) => {
  const query = c.req.valid("query");
  const dimensions = (
    query.dimensions
      ? query.dimensions
          .split(",")
          .map((d) => d.trim())
          .filter((d): d is (typeof FACTOR_DIMENSIONS)[number] =>
            (FACTOR_DIMENSIONS as readonly string[]).includes(d),
          )
      : DEFAULT_FACTOR_DIMENSIONS
  ) as (typeof FACTOR_DIMENSIONS)[number][];
  try {
    return c.json(await getFactorAnalysis({ metric: query.metric, dimensions }), 200);
  } catch (e) {
    logger.error({ err: e }, "analytics factors 失败");
    return c.json(internalError(), 500);
  }
});

// 批次 5B：留档显式化——只有这个 POST 会写 analysis_result 快照，写失败回错不静默
const recomputeFactorsRoute = createRoute({
  method: "post",
  path: "/factors",
  tags: [API_TAGS.analytics],
  operationId: "recomputeAnalyticsFactors",
  summary: "因子分析显式重算并留档（写 analysis_result 快照；白名单与 GET 同源）",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            metric: z.enum(FACTOR_METRICS).optional().default("completion_rate"),
            dimensions: z.array(z.enum(FACTOR_DIMENSIONS)).max(15).optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "重算完成已留档（payload 与 GET 同构）",
      content: { "application/json": { schema: factorViewSchema } },
    },
    400: { description: "指标/维度不在白名单" },
    500: { description: "重算或留档失败（留档失败报错，不再静默）" },
  },
});

analyticsRoute.openapi(recomputeFactorsRoute, async (c) => {
  const body = c.req.valid("json");
  try {
    return c.json(
      await persistFactorAnalysis({
        metric: body.metric,
        dimensions: (body.dimensions ??
          DEFAULT_FACTOR_DIMENSIONS) as (typeof FACTOR_DIMENSIONS)[number][],
      }),
      200,
    );
  } catch (e) {
    logger.error({ err: e }, "analytics factors 重算留档失败");
    return c.json(internalError(), 500);
  }
});

// ── Phase 3 · 内容段落时间轴 ──

const timelineRoute = createRoute({
  method: "get",
  path: "/videos/{contentId}/timeline",
  tags: [API_TAGS.analytics],
  operationId: "getAnalyticsTimeline",
  summary: "内容段落时间轴（生产口径派生：片头事实 + 字符权重分配；非逐帧实测切换点）",
  request: { params: contentIdParam },
  responses: {
    200: {
      description: "段落列表；emptyReason=not_derived 表示尚未同步或无产物时长（不猜）",
      content: {
        "application/json": {
          schema: z.object({
            segments: z.array(
              z.object({
                idx: z.number(),
                startTime: z.number(),
                endTime: z.number(),
                segmentType: z.string(),
                dialogue: z.string().nullable(),
                knowledgePoint: z.string().nullable(),
                scene: z.string().nullable(),
                emotion: z.string().nullable(),
                shotType: z.string().nullable(),
                sourceType: z.enum(METRIC_SOURCE_TYPES),
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

analyticsRoute.openapi(timelineRoute, async (c) => {
  const { contentId } = c.req.valid("param");
  try {
    const rows = await loadContentSegments(contentId);
    return c.json(
      {
        segments: rows.map((r) => ({
          idx: r.idx,
          startTime: r.startTime,
          endTime: r.endTime,
          segmentType: r.segmentType,
          dialogue: r.dialogue,
          knowledgePoint: r.knowledgePoint,
          scene: r.scene,
          emotion: r.emotion,
          shotType: r.shotType,
          sourceType: r.sourceType,
        })),
        emptyReason: rows.length === 0 ? "not_derived" : null,
      },
      200,
    );
  } catch (e) {
    logger.error({ err: e, contentId }, "analytics timeline 查询失败");
    return c.json(internalError(), 500);
  }
});

// ── Phase 4 · 生产建议与结构复用 ──

const recommendationViewSchema = z.object({
  id: z.string(),
  recommendationType: z.string(),
  recommendation: z.object({
    value: z.string(),
    label: z.string(),
    kindLabel: z.string(),
  }),
  reason: z.string(),
  sourceSampleCount: z.number(),
  sourceMetric: z.string(),
  confidence: z.number().nullable(),
  accepted: z.boolean().nullable(),
  appliedToContentId: z.string().nullable(),
  createdAt: z.string(),
});

const listRecommendationsRoute = createRoute({
  method: "get",
  path: "/recommendations",
  tags: [API_TAGS.analytics],
  operationId: "listAnalyticsRecommendations",
  summary: "生产建议清单（每条必携理由/样本数/依据指标；含采纳汇总）",
  responses: {
    200: {
      description: "建议列表与汇总（total/pending/accepted/rejected/applied）",
      content: {
        "application/json": {
          schema: z.object({
            items: z.array(recommendationViewSchema),
            summary: z.object({
              total: z.number(),
              pending: z.number(),
              accepted: z.number(),
              rejected: z.number(),
              applied: z.number(),
            }),
          }),
        },
      },
    },
    500: { description: "查询失败" },
  },
});

analyticsRoute.openapi(listRecommendationsRoute, async (c) => {
  try {
    return c.json(await listRecommendations(), 200);
  } catch (e) {
    logger.error({ err: e }, "analytics recommendations 列表失败");
    return c.json(internalError(), 500);
  }
});

const generateRecommendationsRoute = createRoute({
  method: "post",
  path: "/recommendations/generate",
  tags: [API_TAGS.analytics],
  operationId: "generateAnalyticsRecommendations",
  summary: "按最新数据重新生成建议（清空待处理项；已采纳/已忽略历史保留）",
  responses: {
    200: {
      description: "生成完成（created=建议条数；样本不足时为 data_readiness 诚实建议）",
      content: {
        "application/json": { schema: z.object({ created: z.number() }) },
      },
    },
    500: { description: "生成失败" },
  },
});

analyticsRoute.openapi(generateRecommendationsRoute, async (c) => {
  try {
    return c.json({ created: await generateRecommendations() }, 200);
  } catch (e) {
    logger.error({ err: e }, "analytics recommendations 生成失败");
    return c.json(internalError(), 500);
  }
});

const decideRecommendationRoute = createRoute({
  method: "patch",
  path: "/recommendations/{recommendationId}",
  tags: [API_TAGS.analytics],
  operationId: "decideAnalyticsRecommendation",
  summary: "建议采纳/忽略（accepted）与采纳后新建内容回写（appliedToContentId 效果回路）",
  request: {
    params: z.object({ recommendationId: z.string().min(1).max(32) }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            accepted: z.boolean(),
            appliedToContentId: z.string().max(32).nullable().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "更新后的建议",
      content: { "application/json": { schema: recommendationViewSchema } },
    },
    404: { description: "建议不存在" },
    500: { description: "更新失败" },
  },
});

analyticsRoute.openapi(decideRecommendationRoute, async (c) => {
  const { recommendationId } = c.req.valid("param");
  try {
    const updated = await decideRecommendation(recommendationId, c.req.valid("json"));
    if (!updated) return c.json(apiError("NOT_FOUND", "建议不存在"), 404);
    return c.json(updated, 200);
  } catch (e) {
    logger.error({ err: e, recommendationId }, "analytics recommendation 决策失败");
    return c.json(internalError(), 500);
  }
});

const structureRoute = createRoute({
  method: "get",
  path: "/videos/{contentId}/structure",
  tags: [API_TAGS.analytics],
  operationId: "getAnalyticsVideoStructure",
  summary: "可复用成功结构（从段落时间轴提取结构序列与时长占比；不复制内容）",
  request: { params: contentIdParam },
  responses: {
    200: {
      description: "结构骨架；emptyReason=not_derived 表示尚未同步段落",
      content: {
        "application/json": {
          schema: z.object({
            skeleton: z.array(
              z.object({
                idx: z.number(),
                segmentType: z.string(),
                label: z.string(),
                startTime: z.number(),
                endTime: z.number(),
                durationShare: z.number(),
                knowledgePoint: z.string().nullable(),
              }),
            ),
            totalDuration: z.number().nullable(),
            emptyReason: z.string().nullable(),
          }),
        },
      },
    },
    500: { description: "查询失败" },
  },
});

analyticsRoute.openapi(structureRoute, async (c) => {
  const { contentId } = c.req.valid("param");
  try {
    const structure = await getVideoStructure(contentId);
    if (!structure) {
      return c.json({ skeleton: [], totalDuration: null, emptyReason: "not_derived" }, 200);
    }
    return c.json({ ...structure, emptyReason: null }, 200);
  } catch (e) {
    logger.error({ err: e, contentId }, "analytics structure 查询失败");
    return c.json(internalError(), 500);
  }
});

// ── Phase 6 · 内容实验（A/B 描述统计） ──

const variantSchema = z.object({
  label: z.string().max(255),
  contentIds: z.array(z.string().min(1).max(32)).max(500),
});

const experimentViewSchema = z.object({
  id: z.string(),
  variable: z.string(),
  variantA: variantSchema,
  variantB: variantSchema,
  controlVariables: z.unknown(),
  targetMetric: z.string(),
  startAt: z.string().nullable(),
  endAt: z.string().nullable(),
  status: z.string(),
  result: z
    .object({
      targetMetric: z.string(),
      medianA: z.number().nullable(),
      medianB: z.number().nullable(),
      diff: z.number().nullable(),
      sampleA: z.number(),
      sampleB: z.number(),
      lowSample: z.boolean(),
      verdict: z.string(),
      note: z.string(),
      modelVersion: z.string(),
      evaluatedAt: z.string(),
    })
    .nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const listExperimentsRoute = createRoute({
  method: "get",
  path: "/experiments",
  tags: [API_TAGS.analytics],
  operationId: "listAnalyticsExperiments",
  summary: "内容实验清单（含评估快照；最多 100 条）",
  responses: {
    200: {
      description: "实验列表",
      content: {
        "application/json": { schema: z.object({ items: z.array(experimentViewSchema) }) },
      },
    },
    500: { description: "查询失败" },
  },
});

analyticsRoute.openapi(listExperimentsRoute, async (c) => {
  try {
    return c.json({ items: await listExperiments() }, 200);
  } catch (e) {
    logger.error({ err: e }, "analytics experiments 列表失败");
    return c.json(internalError(), 500);
  }
});

const createExperimentRoute = createRoute({
  method: "post",
  path: "/experiments",
  tags: [API_TAGS.analytics],
  operationId: "createAnalyticsExperiment",
  summary: "创建内容实验（变量白名单；A/B 两组内容非空且不相交；控制变量如实声明）",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            variable: z.string().min(1).max(32),
            variantA: variantSchema,
            variantB: variantSchema,
            controlVariables: z.record(z.string()).optional(),
            targetMetric: z.string().min(1).max(64).optional().default("completion_rate"),
            startAt: z.string().datetime().nullable().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "创建成功",
      content: { "application/json": { schema: experimentViewSchema } },
    },
    400: { description: "变量/指标不在白名单或分组不合法" },
    500: { description: "创建失败" },
  },
});

analyticsRoute.openapi(createExperimentRoute, async (c) => {
  const body = c.req.valid("json");
  const errors = validateExperimentInput({
    variable: body.variable,
    variantA: body.variantA,
    variantB: body.variantB,
    targetMetric: body.targetMetric,
  });
  if (errors.length > 0) return c.json(apiError("INVALID_EXPERIMENT", errors.join("；")), 400);
  try {
    const created = await createExperiment({
      variable: body.variable as "hook",
      variantA: body.variantA,
      variantB: body.variantB,
      controlVariables: body.controlVariables,
      targetMetric: body.targetMetric as "completion_rate",
      startAt: body.startAt,
    });
    return c.json(created, 201);
  } catch (e) {
    logger.error({ err: e }, "analytics experiment 创建失败");
    return c.json(internalError(), 500);
  }
});

const evaluateRoute = createRoute({
  method: "post",
  path: "/experiments/{experimentId}/evaluate",
  tags: [API_TAGS.analytics],
  operationId: "evaluateAnalyticsExperiment",
  summary: "评估归档：两组发布指标描述统计（小样本只给观察不给结论，相关≠因果）",
  request: { params: z.object({ experimentId: z.string().min(1).max(32) }) },
  responses: {
    200: {
      description: "评估后的实验（result 含 verdict/note/lowSample）",
      content: { "application/json": { schema: experimentViewSchema } },
    },
    404: { description: "实验不存在或已取消" },
    500: { description: "评估失败" },
  },
});

analyticsRoute.openapi(evaluateRoute, async (c) => {
  const { experimentId } = c.req.valid("param");
  try {
    const outcome = await evaluateExperimentById(experimentId);
    if (outcome.kind !== "ok") return c.json(apiError("NOT_FOUND", "实验不存在或已取消"), 404);
    return c.json(outcome.experiment, 200);
  } catch (e) {
    logger.error({ err: e, experimentId }, "analytics experiment 评估失败");
    return c.json(internalError(), 500);
  }
});

const experimentStatusRoute = createRoute({
  method: "patch",
  path: "/experiments/{experimentId}/status",
  tags: [API_TAGS.analytics],
  operationId: "updateAnalyticsExperimentStatus",
  summary: "实验状态流转（draft/running/cancelled；completed 仅由 evaluate 写入防手改结论）",
  request: {
    params: z.object({ experimentId: z.string().min(1).max(32) }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ status: z.enum(["draft", "running", "cancelled"]) }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "更新后的实验",
      content: { "application/json": { schema: experimentViewSchema } },
    },
    404: { description: "实验不存在或已完成不可改状态" },
    500: { description: "更新失败" },
  },
});

analyticsRoute.openapi(experimentStatusRoute, async (c) => {
  const { experimentId } = c.req.valid("param");
  try {
    const updated = await updateExperimentStatus(experimentId, c.req.valid("json").status);
    if (!updated) return c.json(apiError("NOT_FOUND", "实验不存在或已完成不可改状态"), 404);
    return c.json(updated, 200);
  } catch (e) {
    logger.error({ err: e, experimentId }, "analytics experiment 状态更新失败");
    return c.json(internalError(), 500);
  }
});
