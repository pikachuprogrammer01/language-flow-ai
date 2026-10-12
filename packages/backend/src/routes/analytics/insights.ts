// 洞察领域路由（批次 5C 自 routes/analytics.ts 拆分，行为逐字不变）
// factors(GET/POST) · timeline · recommendations(list/generate/decide) · structure · experiments
import { createRoute, z } from "@hono/zod-openapi";
import { METRIC_SOURCE_TYPES, PUBLISH_TIME_SOURCES } from "../../lib/analytics-taxonomy";
import { API_TAGS } from "../../lib/api-convention";
import { apiError, internalError } from "../../lib/api-error";
import { logger } from "../../lib/logger";
import {
  bindExperimentAssignment,
  createExperimentAssignment,
  experimentExists,
  listExperimentAssignments,
} from "../../services/analytics-experiment-assignment.service";
import {
  createExperiment,
  evaluateExperimentById,
  listExperiments,
  updateExperimentStatus,
  validateExperimentInput,
} from "../../services/analytics-experiment.service";
import {
  DEFAULT_FACTOR_DIMENSIONS,
  DEFAULT_FACTOR_SCOPE,
  FACTOR_DIMENSIONS,
  FACTOR_METRICS,
  type FactorAnalysisPayload,
  type FactorScope,
  getFactorAnalysis,
  persistFactorAnalysis,
} from "../../services/analytics-factors.service";
import {
  bindRecommendationApplication,
  getRecommendationEvidence,
  recordRecommendationApplication,
} from "../../services/analytics-recommend-evidence.service";
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

/**
 * 服务内部载荷 → 本端点已发布响应形状。
 *
 * 批次二给分组加了 realSampleCount（行动门槛只数非估算值）与 recordIds（证据链），
 * 但 GET/POST /factors 的响应结构是已发布契约，不能顺手扩字段——这些内部量
 * 经 `GET /recommendations/{id}/evidence` 与新表外露，这里显式投影回原形状。
 * 注意 `lowSample` 的**语义**已变窄为「非估算真实样本 <8」，字段名与类型不变。
 */
function toFactorView(
  payload: FactorAnalysisPayload & { computedAt: string },
): z.infer<typeof factorViewSchema> {
  return {
    metric: payload.metric,
    accountMedian: payload.accountMedian,
    accountSampleCount: payload.accountSampleCount,
    dimensions: payload.dimensions.map((d) => ({
      dimension: d.dimension,
      groups: d.groups.map((g) => ({
        value: g.value,
        sampleCount: g.sampleCount,
        median: g.median,
        mean: g.mean,
        diff: g.diff,
        lowSample: g.lowSample,
      })),
    })),
    note: payload.note,
    computedAt: payload.computedAt,
  };
}

/** 统计范围解析（缺失即保持既有全平台/全历史口径，不隐含收窄） */
function scopeFromInput(input: {
  platform?: string | null;
  days?: number | null;
}): FactorScope {
  return {
    platform: input.platform ?? DEFAULT_FACTOR_SCOPE.platform,
    windowDays: input.days ?? DEFAULT_FACTOR_SCOPE.windowDays,
  };
}

const scopeQueryFields = {
  /** 只统计该平台的发布记录；省略 = 跨平台（口径不可比，不得据此出参数建议） */
  platform: z.string().max(50).optional(),
  /** 只看近 N 天（按发布时间，缺失回退登记时间）；省略 = 全部历史 */
  days: z.coerce.number().int().min(1).max(3650).optional(),
};

const factorsRoute = createRoute({
  method: "get",
  path: "/factors",
  tags: [API_TAGS.analytics],
  operationId: "getAnalyticsFactors",
  summary: "内容因子分析（哪些生产参数与效果同时出现；分组统计非因果，纯读不落库）",
  description:
    "需求 §十一 页面 D / §十四：早期只做分组统计（中位数/均值/样本数），不上模型；每组必携 sampleCount，" +
    "低样本判据为「非估算真实样本 <8」（估算值如窗口归因涨粉不满足行动门槛）；响应 note 声明相关性非因果。" +
    "批次 5B：GET 纯读不再有写副作用，留档走 POST /factors。批次二：可选 platform/days 收窄统计范围" +
    "（docs/22 §6.1 同平台同窗口才可比），省略时保持既有全量口径并在 note 里明示跨平台。",
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
      ...scopeQueryFields,
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
    const payload = await getFactorAnalysis({
      metric: query.metric,
      dimensions,
      scope: scopeFromInput({ platform: query.platform, days: query.days }),
    });
    return c.json(toFactorView(payload), 200);
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

const evidenceMetricCellSchema = z.object({
  value: z.number(),
  sourceType: z.enum(METRIC_SOURCE_TYPES),
  sourceField: z.string().nullable(),
  dataDate: z.string().nullable(),
  isEstimated: z.boolean(),
  /** batchId/importRowNumber 为 null 表示该值不是导入来的（派生/人工录入），追到字段名即止 */
  batchId: z.string().nullable(),
  importRowNumber: z.number().nullable(),
  matchedBy: z.string().nullable(),
});

const evidenceVideoSchema = z.object({
  recordId: z.string(),
  contentId: z.string(),
  title: z.string(),
  platform: z.string(),
  platformVideoId: z.string().nullable(),
  publishStatus: z.string(),
  publishTime: z.string().nullable(),
  publishTimeSource: z.enum(PUBLISH_TIME_SOURCES).nullable(),
  videoAssetId: z.string().nullable(),
  metrics: z.record(evidenceMetricCellSchema),
  features: z.record(z.unknown()).nullable(),
  fieldSources: z.record(z.string()).nullable(),
  auditAvailable: z.boolean(),
  auditInputKeys: z.array(z.string()),
});

const evidenceImportRowSchema = z.object({
  batchId: z.string(),
  rowNumber: z.number(),
  filename: z.string().nullable(),
  batchPlatform: z.string().nullable(),
  batchStatus: z.string().nullable(),
  /** import_row.raw_data 原样回传（永久保留的整行原文，裁决归属时看得境的东西） */
  rawData: z.unknown(),
  matchStatus: z.string().nullable(),
  decisionType: z.string().nullable(),
});

const recommendationEvidenceSchema = z.object({
  recommendationId: z.string(),
  recommendationType: z.string(),
  recommendation: z.unknown(),
  reason: z.string(),
  targetMetric: z.string(),
  sourceSampleCount: z.number(),
  analysisResultId: z.number().nullable(),
  /** traceable=能回放到分组与原始行；evidence_unavailable=缺一环，如实说明缺哪一环 */
  status: z.enum(["traceable", "evidence_unavailable"]),
  unavailableReasons: z.array(z.string()),
  snapshot: z
    .object({
      analysisType: z.string(),
      modelVersion: z.string(),
      computedAt: z.string(),
      scope: z.unknown(),
      accountMedian: z.number().nullable(),
      accountSampleCount: z.number().nullable(),
      accountRealSampleCount: z.number().nullable(),
    })
    .nullable(),
  groups: z.array(
    z.object({
      dimension: z.string(),
      value: z.string(),
      sampleCount: z.number(),
      realSampleCount: z.number(),
      median: z.number().nullable(),
      mean: z.number().nullable(),
      recordIds: z.array(z.string()),
    }),
  ),
  videos: z.array(evidenceVideoSchema),
  importRows: z.array(evidenceImportRowSchema),
});

const recommendationEvidenceRoute = createRoute({
  method: "get",
  path: "/recommendations/{recommendationId}/evidence",
  tags: [API_TAGS.analytics],
  operationId: "getAnalyticsRecommendationEvidence",
  summary: "建议证据链回放（快照 → 分组 → 参与视频 → 指标 provenance → 导入原始行 → 生产字段来源）",
  description:
    "docs/22 §5.2：建议必须能追到它依据的真实数据。analysisResultId 为 null 的历史建议返回 " +
    "status=evidence_unavailable 并说明「产出时未留档快照」，不回推一份看起来完整的证据；" +
    "指标行缺 batch_id/import_row 留痕（派生或人工录入）时如实说明只能追到字段名层级。",
  request: { params: z.object({ recommendationId: z.string().min(1).max(32) }) },
  responses: {
    200: {
      description: "证据视图（traceable 或 evidence_unavailable）",
      content: { "application/json": { schema: recommendationEvidenceSchema } },
    },
    404: { description: "建议不存在" },
    500: { description: "证据查询失败" },
  },
});

analyticsRoute.openapi(recommendationEvidenceRoute, async (c) => {
  const { recommendationId } = c.req.valid("param");
  try {
    const evidence = await getRecommendationEvidence(recommendationId);
    if (!evidence) return c.json(apiError("NOT_FOUND", "建议不存在"), 404);
    return c.json(evidence, 200);
  } catch (e) {
    logger.error({ err: e, recommendationId }, "analytics recommendation 证据链查询失败");
    return c.json(internalError(), 500);
  }
});

const createApplicationRoute = createRoute({
  method: "post",
  path: "/recommendations/{recommendationId}/applications",
  tags: [API_TAGS.analytics],
  operationId: "createAnalyticsRecommendationApplication",
  summary: "记录一次建议采纳（建议值 + 页面预填值分开存；最终值由生成成功后的 bind 写入）",
  description:
    "suggestedParams 由服务端从建议行当场读出，不接受前端回传建议值（防「按建议生成」其实换了参数）。" +
    "本端点只登记采纳动作；生成失败时不会有对应 bind 调用，记录保持未绑定，不伪造 content_id。",
  request: {
    params: z.object({ recommendationId: z.string().min(1).max(32) }),
    body: {
      content: {
        "application/json": {
          schema: z.object({ prefillParams: z.record(z.unknown()) }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "采纳记录已创建",
      content: {
        "application/json": {
          schema: z.object({
            id: z.string(),
            targetMetric: z.string(),
            analysisResultId: z.number().nullable(),
          }),
        },
      },
    },
    400: { description: "参数不合法" },
    404: { description: "建议不存在" },
    500: { description: "创建失败" },
  },
});

analyticsRoute.openapi(createApplicationRoute, async (c) => {
  const { recommendationId } = c.req.valid("param");
  try {
    const result = await recordRecommendationApplication({
      recommendationId,
      prefillParams: c.req.valid("json").prefillParams as Record<string, unknown>,
    });
    if (result.kind === "recommendation-not-found") {
      return c.json(apiError("NOT_FOUND", "建议不存在"), 404);
    }
    return c.json(
      {
        id: result.id,
        targetMetric: result.targetMetric,
        analysisResultId: result.analysisResultId,
      },
      201,
    );
  } catch (e) {
    logger.error({ err: e, recommendationId }, "analytics recommendation 采纳记录创建失败");
    return c.json(internalError(), 500);
  }
});

const bindApplicationRoute = createRoute({
  method: "post",
  path: "/recommendation-applications/{applicationId}/bind",
  tags: [API_TAGS.analytics],
  operationId: "bindAnalyticsRecommendationApplication",
  summary: "生成成功后绑定内容与用户最终参数（一次采纳对应一次生成，不覆盖首次事实）",
  description:
    "finalParams 必须是用户实际提交给生成链路的值，不是建议值；内容不存在时拒绝绑定（404），" +
    "已绑定过再绑返回 409 而不是静默改写。",
  request: {
    params: z.object({ applicationId: z.string().min(1).max(32) }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            contentId: z.string().min(1).max(32),
            finalParams: z.record(z.unknown()),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "绑定完成",
      content: {
        "application/json": {
          schema: z.object({ id: z.string(), bound: z.literal(true) }),
        },
      },
    },
    400: { description: "参数不合法" },
    404: { description: "采纳记录或内容不存在" },
    409: { description: "该采纳记录已绑定过内容" },
    500: { description: "绑定失败" },
  },
});

analyticsRoute.openapi(bindApplicationRoute, async (c) => {
  const { applicationId } = c.req.valid("param");
  const body = c.req.valid("json");
  try {
    const result = await bindRecommendationApplication(applicationId, {
      contentId: body.contentId,
      finalParams: body.finalParams,
    });
    if (result === "not-found" || result === "content-not-found") {
      const message = result === "not-found" ? "采纳记录不存在" : "内容不存在";
      return c.json(apiError("NOT_FOUND", message), 404);
    }
    if (result === "already-bound") {
      return c.json(apiError("ALREADY_BOUND", "该采纳记录已绑定内容，不允许改写首次绑定"), 409);
    }
    return c.json({ id: applicationId, bound: true as const }, 200);
  } catch (e) {
    logger.error({ err: e, applicationId }, "analytics recommendation 采纳绑定失败");
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

// ── 批次三：实验变体分配（生成前选定，评估以它为准） ──

const experimentIdParam = z.object({ experimentId: z.string().min(1).max(32) });

const assignmentViewSchema = z.object({
  id: z.string(),
  experimentId: z.string(),
  contentId: z.string().nullable(),
  variant: z.enum(["A", "B"]),
  assignmentMethod: z.string(),
  assignedParams: z.record(z.unknown()).nullable(),
  finalParams: z.record(z.unknown()).nullable(),
  assignedAt: z.string(),
  boundAt: z.string().nullable(),
});

const listAssignmentsRoute = createRoute({
  method: "get",
  path: "/experiments/{experimentId}/assignments",
  tags: [API_TAGS.analytics],
  operationId: "listAnalyticsExperimentAssignments",
  summary: "实验的变体分配台账（谁在生成前被定为哪一组、是否已绑定内容）",
  description:
    "旧 `GET /experiments` 的两组 contentIds 是事后记账，回答不了「生成前是否已选定变体」。" +
    "本端点是新增的读出口，不改旧响应结构。实验不存在回 404——不能拿一份空列表冒充「这个实验还没有分配」。",
  request: { params: experimentIdParam },
  responses: {
    200: {
      description: "分配列表（按分配时间升序）",
      content: {
        "application/json": { schema: z.object({ items: z.array(assignmentViewSchema) }) },
      },
    },
    404: { description: "实验不存在（不能拿一份空列表冒充「这个实验还没有分配」）" },
    500: { description: "查询失败" },
  },
});

analyticsRoute.openapi(listAssignmentsRoute, async (c) => {
  const { experimentId } = c.req.valid("param");
  try {
    if (!(await experimentExists(experimentId))) {
      return c.json(apiError("NOT_FOUND", "实验不存在"), 404);
    }
    return c.json({ items: await listExperimentAssignments(experimentId) }, 200);
  } catch (e) {
    logger.error({ err: e, experimentId }, "analytics experiment 分配列表失败");
    return c.json(internalError(), 500);
  }
});

const createAssignmentRoute = createRoute({
  method: "post",
  path: "/experiments/{experimentId}/assignments",
  tags: [API_TAGS.analytics],
  operationId: "createAnalyticsExperimentAssignment",
  summary: "生成前登记一次变体分配（variant 只能 A/B；仅 draft/running 的实验可分配）",
  description:
    "第一版 assignment_method 固定 operator_selected——没有随机分流基础设施就不假装随机 A/B。" +
    "此时还没有内容：contentId 为空，生成成功后由 bind 写入。",
  request: {
    params: experimentIdParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            variant: z.enum(["A", "B"]),
            assignedParams: z.record(z.unknown()),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "分配已登记",
      content: { "application/json": { schema: assignmentViewSchema } },
    },
    400: { description: "参数不合法" },
    404: { description: "实验不存在" },
    409: { description: "实验状态不允许再分配（已完成/已取消）" },
    500: { description: "登记失败" },
  },
});

analyticsRoute.openapi(createAssignmentRoute, async (c) => {
  const { experimentId } = c.req.valid("param");
  const body = c.req.valid("json");
  try {
    const result = await createExperimentAssignment({
      experimentId,
      variant: body.variant,
      assignedParams: body.assignedParams,
    });
    if (result.kind === "experiment-not-found") {
      return c.json(apiError("NOT_FOUND", "实验不存在"), 404);
    }
    if (result.kind === "not-assignable") {
      return c.json(
        apiError(
          "EXPERIMENT_NOT_ASSIGNABLE",
          `实验当前状态为 ${result.status}，不再接受新的变体分配（事后追加会污染已归档的对比）`,
        ),
        409,
      );
    }
    return c.json(result.assignment, 201);
  } catch (e) {
    logger.error({ err: e, experimentId }, "analytics experiment 分配登记失败");
    return c.json(internalError(), 500);
  }
});

const bindAssignmentRoute = createRoute({
  method: "post",
  path: "/experiments/{experimentId}/assignments/{assignmentId}/bind",
  tags: [API_TAGS.analytics],
  operationId: "bindAnalyticsExperimentAssignment",
  summary: "生成成功后绑定内容与最终参数（一次分配对应一次生成，不覆盖首次事实）",
  description:
    "finalParams 是用户实际提交的参数，不是分配时的参数；内容不存在或状态为 failed 时拒绝绑定——" +
    "失败产物不是实验样本，未绑定的分配会如实留在台账里。",
  request: {
    params: z.object({ experimentId: z.string().min(1).max(32), assignmentId: z.string().max(32) }),
    body: {
      content: {
        "application/json": {
          schema: z.object({
            contentId: z.string().min(1).max(32),
            finalParams: z.record(z.unknown()),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "绑定成功",
      content: {
        "application/json": { schema: z.object({ ok: z.boolean() }) },
      },
    },
    400: { description: "参数不合法" },
    404: { description: "分配不存在或内容不存在" },
    409: {
      description:
        "该分配已绑定过 / 内容已被这条实验的其它分配占用 / 内容为生成失败产物（都不静默覆盖首次事实）",
    },
    500: { description: "绑定失败" },
  },
});

analyticsRoute.openapi(bindAssignmentRoute, async (c) => {
  const { experimentId, assignmentId } = c.req.valid("param");
  const body = c.req.valid("json");
  try {
    const outcome = await bindExperimentAssignment(experimentId, assignmentId, {
      contentId: body.contentId,
      finalParams: body.finalParams,
    });
    if (outcome === "not-found") return c.json(apiError("NOT_FOUND", "分配不存在"), 404);
    if (outcome === "content-not-found") {
      return c.json(apiError("CONTENT_NOT_FOUND", "内容不存在，不绑定（不伪造归属）"), 404);
    }
    if (outcome === "already-bound") {
      return c.json(apiError("ALREADY_BOUND", "该分配已绑定内容，不改写首次事实"), 409);
    }
    if (outcome === "content-already-assigned") {
      return c.json(
        apiError("CONTENT_ALREADY_ASSIGNED", "这条内容已属于该实验的某个变体，不能同时占两组"),
        409,
      );
    }
    if (outcome === "content-failed") {
      return c.json(apiError("CONTENT_FAILED", "内容生成失败，失败产物不计入实验样本"), 409);
    }
    return c.json({ ok: true as const }, 200);
  } catch (e) {
    logger.error({ err: e, experimentId, assignmentId }, "analytics experiment 分配绑定失败");
    return c.json(internalError(), 500);
  }
});
