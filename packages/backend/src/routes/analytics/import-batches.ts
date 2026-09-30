// 平台数据导入·四步精准匹配路由（docs/17 §数据导入）
// import-batches 全生命周期：创建/查询/删除 · 粒度确认 · 规则+预估 · 预匹配 · 行列表/详情 · 裁决 · preflight · 提交 · 回滚
// 纪律：确定性匹配零 LLM；账号日级禁止归属作品（service 红线，路由如实透出 4xx）；提交服务端重验 preflight
import { createRoute, z } from "@hono/zod-openapi";
import {
  IMPORT_DATA_GRANULARITIES,
  IMPORT_MATCH_METHODS,
  IMPORT_ROW_MATCH_STATUSES,
} from "../../db/schema";
import { API_TAGS } from "../../lib/api-convention";
import { apiError, internalError } from "../../lib/api-error";
import { IMPORT_FIELD_ROLES } from "../../lib/import-granularity";
import type { PreflightReport } from "../../lib/import-preflight";
import { logger } from "../../lib/logger";
import {
  type CommitSummary,
  type DecisionAction,
  applyDecisions,
  commitBatch,
  confirmGranularity,
  createImportBatch,
  deleteImportBatch,
  getBatchView,
  getRowDetail,
  listBatchRows,
  listImportBatches,
  preflightBatch,
  prematchBatch,
  quickImport,
  rollbackBatch,
  saveRules,
} from "../../services/analytics-import-batch.service";
import { analyticsRoute } from "./shared";

const batchIdParam = z.object({ batchId: z.string().min(1).max(32) });
const rowIdParam = z.object({
  batchId: z.string().min(1).max(32),
  rowId: z.coerce.number().int().min(1),
});

const granularityEnum = z.enum(IMPORT_DATA_GRANULARITIES);
const matchStatusEnum = z.enum(IMPORT_ROW_MATCH_STATUSES);
const matchMethodEnum = z.enum(IMPORT_MATCH_METHODS);

const statsSchema = z.object({
  uniqueMatch: z.number(),
  conflict: z.number(),
  unmatched: z.number(),
  accountDayLevel: z.number(),
  confirmed: z.number(),
  ignored: z.number(),
});

const batchViewSchema = z.object({
  id: z.string(),
  filename: z.string(),
  fileSize: z.number(),
  fileHash: z.string(),
  platform: z.string(),
  rowCount: z.number(),
  dataGranularity: granularityEnum,
  granularityEvidence: z.unknown(),
  headers: z.unknown(),
  fieldDetection: z.unknown(),
  matchRules: z.unknown().nullable(),
  status: z.string(),
  stats: statsSchema,
  summary: z.object({
    rowCount: z.number(),
    accountCount: z.number(),
    dateFrom: z.string().nullable(),
    dateTo: z.string().nullable(),
  }),
  commitSummary: z.unknown().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});

const titleNormalizationSchema = z.object({
  stripEmoji: z.boolean(),
  stripHashtag: z.boolean(),
  collapseWhitespace: z.boolean(),
  toLowercase: z.boolean(),
  fullToHalfWidth: z.boolean(),
});

const rulesSchema = z.object({
  accountMapping: z.record(z.string().min(1).max(100)).default({}),
  platformMapping: z.record(z.string().min(1).max(100)).default({}),
  timezoneOffsetMinutes: z.number().int().min(-720).max(840).default(480),
  publishTimeToleranceMinutes: z.number().int().min(0).max(1440).default(5),
  titleNormalization: titleNormalizationSchema.default({
    stripEmoji: true,
    stripHashtag: true,
    collapseWhitespace: true,
    toLowercase: true,
    fullToHalfWidth: true,
  }),
  titleSimilarityThreshold: z.number().min(0.5).max(1).default(0.9),
});

const preflightCheckSchema = z.object({
  id: z.number(),
  name: z.string(),
  level: z.enum(["pass", "warning", "blocking"]),
  message: z.string(),
  rowIds: z.array(z.number()),
});

const preflightReportSchema = z.object({
  pass: z.boolean(),
  checks: z.array(preflightCheckSchema),
  counts: z.object({
    workLevel: z.number(),
    accountDayLevel: z.number(),
    ignored: z.number(),
    external: z.number(),
    pendingUnique: z.number(),
    pendingConflict: z.number(),
    pendingUnmatched: z.number(),
  }),
});

/** 结果 kind → HTTP：统一映射，错误信息人话上屏（问题+原因+修复） */
function invalidState(c: { json: (p: unknown, s: number) => Response }, status: string) {
  return c.json(
    apiError(
      "INVALID_BATCH_STATE",
      `批次当前状态「${status}」不允许该操作，请回到对应步骤刷新页面查看`,
    ),
    409,
  );
}

// ── ① 创建批次（字段识别 + 粒度判定，STEP 1 数据落库） ──

const createBatchRoute = createRoute({
  method: "post",
  path: "/import-batches",
  tags: [API_TAGS.analytics],
  operationId: "createAnalyticsImportBatch",
  summary: "创建导入批次：服务端字段识别 + 数据粒度三态判定（可解释）",
  description:
    "浏览器解析 CSV/XLSX 后提交结构化数据；服务端识别 10 类字段并判定 work_level_strong / work_level_weak / account_day_level。" +
    "账号日汇总只允许保存为账号日级数据，绝不进入作品级匹配；同 file_hash 已有提交批次返回 409（重复导入拦截）。",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            filename: z.string().min(1).max(255),
            fileSize: z.number().int().min(1),
            fileHash: z
              .string()
              .regex(/^[0-9a-f]{64}$/, "fileHash 须为文件内容 sha256（64 位小写十六进制）"),
            platform: z.string().min(1).max(50).default("抖音"),
            headers: z.array(z.string().max(200)).min(2).max(100),
            rows: z
              .array(z.array(z.string().max(2000)).min(1))
              .min(1)
              .max(5000),
            /** 用户手改的 列下标(字符串)→角色（null=不导入）；缺省走自动识别 */
            fieldOverride: z.record(z.enum(IMPORT_FIELD_ROLES).nullable()).optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "批次视图 + 前 10 条预览",
      content: {
        "application/json": {
          schema: z.object({
            batchId: z.string(),
            dataGranularity: granularityEnum,
            granularityEvidence: z.unknown(),
            fieldDetection: z.array(
              z.object({
                col: z.number(),
                header: z.string(),
                role: z.string().nullable(),
                sample: z.string(),
              }),
            ),
            summary: z.object({
              rowCount: z.number(),
              accountCount: z.number(),
              dateFrom: z.string().nullable(),
              dateTo: z.string().nullable(),
            }),
            preview: z.array(z.array(z.string())),
          }),
        },
      },
    },
    400: { description: "参数不合法（行数/列数超限、hash 格式错等）" },
    409: { description: "相同文件已有提交批次（重复导入拦截）" },
    500: { description: "创建失败" },
  },
});

analyticsRoute.openapi(createBatchRoute, async (c) => {
  const body = c.req.valid("json");
  try {
    // 重复导入在创建即拦截提示（preflight ③ 仍是提交前第二道闸）
    const batches = await listImportBatches();
    const dup = batches.find((b) => b.fileHash === body.fileHash && b.status === "committed");
    if (dup) {
      return c.json(
        apiError(
          "DUPLICATE_IMPORT",
          `相同文件已存在提交批次「${dup.id}」（${dup.filename}），禁止重复入库`,
          {
            field: "fileHash",
            hint: "如确属新数据，请从平台重新导出（内容变化后 hash 不同）",
          },
        ),
        409,
      );
    }
    const result = await createImportBatch(body);
    if (result.kind === "empty") {
      return c.json(apiError("EMPTY_ROWS", "没有可导入的数据行", { field: "rows" }), 400);
    }
    return c.json(
      {
        batchId: result.batchId,
        dataGranularity: result.granularity,
        granularityEvidence: result.granularityEvidence,
        fieldDetection: result.fieldDetection,
        summary: result.summary,
        preview: result.preview,
      },
      201,
    );
  } catch (e) {
    logger.error({ err: e }, "import-batches 创建失败");
    return c.json(internalError(), 500);
  }
});

// ── ②b 一键导入（合集快速模式：零异常自动入库，任何异常整批拦截转四步） ──

const quickRoute = createRoute({
  method: "post",
  path: "/import-batches/quick",
  tags: [API_TAGS.analytics],
  operationId: "quickImportAnalyticsBatch",
  summary: "合集一键导入：同引擎同状态机无人值守跑四步；有任异常整批不入库并返回批次号转人工",
  description:
    "复用创建/粒度确认/默认规则/预匹配/批量确认/preflight/提交全链路（审计痕迹与回滚能力与四步一致）。" +
    "committed=全部行强证据或双证据（标题完全一致+时间容差内）自动入库；manual_required=批次已预匹配保留，携 batchId 到四步 STEP3 处理；" +
    "account_day_denied=账号日汇总拒绝作品入库（红线），引导存账号级数据。",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({
            filename: z.string().min(1).max(255),
            fileSize: z.number().int().min(1),
            fileHash: z.string().regex(/^[0-9a-f]{64}$/, "fileHash 须为文件内容 sha256"),
            platform: z.string().min(1).max(50).default("抖音"),
            headers: z.array(z.string().max(200)).min(2).max(100),
            rows: z
              .array(z.array(z.string().max(2000)).min(1))
              .min(1)
              .max(5000),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "三态结果（committed / manual_required / account_day_denied）",
      content: {
        "application/json": {
          schema: z.object({
            mode: z.enum(["committed", "manual_required", "account_day_denied"]),
            batchId: z.string(),
            summary: z.unknown().optional(),
            stats: z.unknown().optional(),
            reason: z.string().optional(),
          }),
        },
      },
    },
    400: { description: "参数不合法" },
    500: { description: "导入失败（事务已回滚）" },
  },
});

analyticsRoute.openapi(quickRoute, async (c) => {
  const body = c.req.valid("json");
  try {
    const result = await quickImport(body);
    if (result.kind === "committed") {
      return c.json(
        { mode: "committed" as const, batchId: result.batchId, summary: result.summary },
        200,
      );
    }
    if (result.kind === "account_day_denied") {
      return c.json(
        { mode: "account_day_denied" as const, batchId: result.batchId, reason: result.reason },
        200,
      );
    }
    return c.json(
      {
        mode: "manual_required" as const,
        batchId: result.batchId,
        stats: result.stats,
        reason: result.reason,
      },
      200,
    );
  } catch (e) {
    logger.error({ err: e }, "import-batches 一键导入失败");
    return c.json(internalError(), 500);
  }
});

// ── ②③ 批次查询/列表/删除 ──

const listBatchesRoute = createRoute({
  method: "get",
  path: "/import-batches",
  tags: [API_TAGS.analytics],
  operationId: "listAnalyticsImportBatches",
  summary: "批次列表（最近 50，页面刷新恢复 + 回滚入口）",
  responses: {
    200: {
      description: "批次视图列表",
      content: { "application/json": { schema: z.object({ items: z.array(batchViewSchema) }) } },
    },
    500: { description: "查询失败" },
  },
});

analyticsRoute.openapi(listBatchesRoute, async (c) => {
  try {
    return c.json({ items: await listImportBatches() }, 200);
  } catch (e) {
    logger.error({ err: e }, "import-batches 列表失败");
    return c.json(internalError(), 500);
  }
});

const getBatchRoute = createRoute({
  method: "get",
  path: "/import-batches/{batchId}",
  tags: [API_TAGS.analytics],
  operationId: "getAnalyticsImportBatch",
  summary: "批次完整视图（状态/统计/规则，刷新即恢复）",
  request: { params: batchIdParam },
  responses: {
    200: {
      description: "批次视图",
      content: { "application/json": { schema: batchViewSchema } },
    },
    404: { description: "批次不存在" },
    500: { description: "查询失败" },
  },
});

analyticsRoute.openapi(getBatchRoute, async (c) => {
  const { batchId } = c.req.valid("param");
  try {
    const view = await getBatchView(batchId);
    if (!view) return c.json(apiError("NOT_FOUND", "批次不存在"), 404);
    return c.json(view, 200);
  } catch (e) {
    logger.error({ err: e, batchId }, "import-batches 查询失败");
    return c.json(internalError(), 500);
  }
});

const deleteBatchRoute = createRoute({
  method: "delete",
  path: "/import-batches/{batchId}",
  tags: [API_TAGS.analytics],
  operationId: "deleteAnalyticsImportBatch",
  summary: "删除未提交批次（已提交批次只能回滚，保留审计）",
  request: { params: batchIdParam },
  responses: {
    200: {
      description: "删除成功",
      content: {
        "application/json": { schema: z.object({ id: z.string(), deleted: z.literal(true) }) },
      },
    },
    404: { description: "批次不存在" },
    409: { description: "批次已提交，禁止删除" },
    500: { description: "删除失败" },
  },
});

analyticsRoute.openapi(deleteBatchRoute, async (c) => {
  const { batchId } = c.req.valid("param");
  try {
    const result = await deleteImportBatch(batchId);
    if (result.kind === "not-found") return c.json(apiError("NOT_FOUND", "批次不存在"), 404);
    if (result.kind === "committed") {
      return c.json(
        apiError("BATCH_COMMITTED", "已提交批次不可删除，请使用回滚（保留审计链路）"),
        409,
      );
    }
    return c.json({ id: batchId, deleted: true as const }, 200);
  } catch (e) {
    logger.error({ err: e, batchId }, "import-batches 删除失败");
    return c.json(internalError(), 500);
  }
});

// ── ⑤ STEP1→2：粒度确认（只允许降级） ──

const confirmGranularityRoute = createRoute({
  method: "post",
  path: "/import-batches/{batchId}/confirm-granularity",
  tags: [API_TAGS.analytics],
  operationId: "confirmAnalyticsImportGranularity",
  summary: "确认数据粒度（STEP1→STEP2；手动只允许降级，账号日级禁止升格作品级）",
  request: {
    params: batchIdParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({ granularity: granularityEnum }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "确认成功",
      content: {
        "application/json": {
          schema: z.object({ ok: z.literal(true), dataGranularity: granularityEnum }),
        },
      },
    },
    400: { description: "粒度升格被拒（账号日级数据不允许按作品匹配）" },
    404: { description: "批次不存在" },
    409: { description: "批次状态不允许" },
    500: { description: "操作失败" },
  },
});

analyticsRoute.openapi(confirmGranularityRoute, async (c) => {
  const { batchId } = c.req.valid("param");
  const { granularity } = c.req.valid("json");
  try {
    const result = await confirmGranularity(batchId, granularity);
    if (result.kind === "not-found") return c.json(apiError("NOT_FOUND", "批次不存在"), 404);
    if (result.kind === "upgrade-denied") {
      return c.json(
        apiError(
          "GRANULARITY_UPGRADE_DENIED",
          "账号日汇总数据不允许升格为作品级（系统绝不拆数/平均/推测）",
          {
            field: "granularity",
            hint: "只允许向更保守的粒度降级",
          },
        ),
        400,
      );
    }
    if (result.kind === "invalid-state") return invalidState(c, result.status);
    return c.json({ ok: true as const, dataGranularity: result.granularity }, 200);
  } catch (e) {
    logger.error({ err: e, batchId }, "import-batches 粒度确认失败");
    return c.json(internalError(), 500);
  }
});

// ──  STEP2：保存规则 + dry-run 预估 ──

const saveRulesRoute = createRoute({
  method: "put",
  path: "/import-batches/{batchId}/rules",
  tags: [API_TAGS.analytics],
  operationId: "saveAnalyticsImportRules",
  summary: "保存匹配规则并返回 dry-run 预估（总记录/预计强匹配/预计人工确认/预计未匹配）",
  request: {
    params: batchIdParam,
    body: { content: { "application/json": { schema: rulesSchema } } },
  },
  responses: {
    200: {
      description: "规则已保存 + 预估",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.literal(true),
            dataGranularity: granularityEnum,
            estimate: z.object({
              total: z.number(),
              expectStrongMatch: z.number(),
              expectManualConfirm: z.number(),
              expectUnmatched: z.number(),
            }),
          }),
        },
      },
    },
    404: { description: "批次不存在" },
    409: { description: "请先在 STEP1 确认数据粒度" },
    500: { description: "保存失败" },
  },
});

analyticsRoute.openapi(saveRulesRoute, async (c) => {
  const { batchId } = c.req.valid("param");
  const rules = c.req.valid("json");
  try {
    const result = await saveRules(batchId, rules);
    if (result.kind === "not-found") return c.json(apiError("NOT_FOUND", "批次不存在"), 404);
    if (result.kind === "invalid-state") return invalidState(c, result.status);
    return c.json(
      { ok: true as const, dataGranularity: result.granularity, estimate: result.estimate },
      200,
    );
  } catch (e) {
    logger.error({ err: e, batchId }, "import-batches 规则保存失败");
    return c.json(internalError(), 500);
  }
});

// ── ⑦ 预匹配 / 重新匹配（确定性引擎，点击才执行） ──

const prematchRoute = createRoute({
  method: "post",
  path: "/import-batches/{batchId}/prematch",
  tags: [API_TAGS.analytics],
  operationId: "prematchAnalyticsImportBatch",
  summary: "执行预匹配（确定性规则引擎，零 LLM；force=true 为「重新执行匹配」）",
  description:
    "存在人工裁决时未带 force 返回 409 needs_confirmation（重匹配会清空人工裁决，必须显式确认）。" +
    "账号日级批次不产候选，全部行直接终态。",
  request: {
    params: batchIdParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({ force: z.boolean().optional().default(false) }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "匹配完成 + 五类统计",
      content: {
        "application/json": {
          schema: z.object({ ok: z.literal(true), stats: statsSchema }),
        },
      },
    },
    404: { description: "批次不存在" },
    409: { description: "状态不允许 / 需确认清空人工裁决" },
    500: { description: "匹配失败" },
  },
});

analyticsRoute.openapi(prematchRoute, async (c) => {
  const { batchId } = c.req.valid("param");
  const { force } = c.req.valid("json");
  try {
    const result = await prematchBatch(batchId, force);
    if (result.kind === "not-found") return c.json(apiError("NOT_FOUND", "批次不存在"), 404);
    if (result.kind === "needs-confirmation") {
      return c.json(
        apiError(
          "NEEDS_CONFIRMATION",
          `重新匹配将清空 ${result.operatorDecisions} 条人工裁决，请确认后重试（force=true）`,
          { hint: "前端应弹二次确认" },
        ),
        409,
      );
    }
    if (result.kind === "invalid-state") return invalidState(c, result.status);
    return c.json({ ok: true as const, stats: result.stats }, 200);
  } catch (e) {
    logger.error({ err: e, batchId }, "import-batches 预匹配失败");
    return c.json(internalError(), 500);
  }
});

// ── ⑨ STEP 3：行列表与详情 ──

const rowItemSchema = z.object({
  rowId: z.number(),
  rowNumber: z.number(),
  imported: z.object({
    date: z.string().nullable(),
    platform: z.string().nullable(),
    account: z.string().nullable(),
    title: z.string().nullable(),
    platformWorkId: z.string().nullable(),
    views: z.string().nullable(),
  }),
  matched: z
    .object({
      videoId: z.string(),
      videoTitle: z.string(),
      coverUrl: z.string().nullable(),
      publishTime: z.string().nullable(),
      durationSec: z.number().nullable(),
    })
    .nullable(),
  matchStatus: matchStatusEnum,
  decisionType: z.string().nullable(),
  matchMethod: z.string().nullable(),
  candidateCount: z.number(),
  evidenceSummary: z.array(z.string()),
});

const listRowsRoute = createRoute({
  method: "get",
  path: "/import-batches/{batchId}/rows",
  tags: [API_TAGS.analytics],
  operationId: "listAnalyticsImportRows",
  summary: "STEP3 主列表：导入侧+匹配侧+状态+依据摘要（分页/状态筛选/关键词）",
  request: {
    params: batchIdParam,
    query: z.object({
      status: z.string().max(32).optional(),
      keyword: z.string().max(100).optional(),
      page: z.coerce.number().int().min(1).optional().default(1),
      pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
    }),
  },
  responses: {
    200: {
      description: "分页行列表",
      content: {
        "application/json": {
          schema: z.object({ items: z.array(rowItemSchema), total: z.number() }),
        },
      },
    },
    500: { description: "查询失败" },
  },
});

analyticsRoute.openapi(listRowsRoute, async (c) => {
  const { batchId } = c.req.valid("param");
  try {
    const result = await listBatchRows(batchId, c.req.valid("query"));
    return c.json(result, 200);
  } catch (e) {
    logger.error({ err: e, batchId }, "import-batches 行列表失败");
    return c.json(internalError(), 500);
  }
});

const rowDetailRoute = createRoute({
  method: "get",
  path: "/import-batches/{batchId}/rows/{rowId}",
  tags: [API_TAGS.analytics],
  operationId: "getAnalyticsImportRowDetail",
  summary: "行详情：全部候选+结构化匹配证据（evidence，禁止裸置信度）",
  request: { params: rowIdParam },
  responses: {
    200: {
      description: "行详情",
      content: {
        "application/json": {
          schema: z.object({
            row: z.object({
              id: z.number(),
              rowNumber: z.number(),
              matchStatus: matchStatusEnum,
              dataGranularity: granularityEnum,
              rawData: z.record(z.string()),
              normalized: z.unknown(),
            }),
            decision: z
              .object({
                matchStatus: matchStatusEnum,
                matchedVideoId: z.string().nullable(),
                decisionType: z.string(),
                operator: z.string(),
                confirmedAt: z.string().nullable(),
                metadata: z.unknown(),
              })
              .nullable(),
            candidates: z.array(
              z.object({
                videoId: z.string(),
                matchMethod: matchMethodEnum,
                matchScore: z.number(),
                rank: z.number(),
                evidence: z.unknown(),
                video: z
                  .object({
                    videoId: z.string(),
                    videoTitle: z.string(),
                    coverUrl: z.string().nullable(),
                    publishTime: z.string().nullable(),
                    durationSec: z.number().nullable(),
                  })
                  .nullable(),
              }),
            ),
          }),
        },
      },
    },
    404: { description: "行不存在或不属于该批次" },
    500: { description: "查询失败" },
  },
});

analyticsRoute.openapi(rowDetailRoute, async (c) => {
  const { batchId, rowId } = c.req.valid("param");
  try {
    const detail = await getRowDetail(batchId, rowId);
    if (!detail) return c.json(apiError("NOT_FOUND", "行不存在或不属于该批次"), 404);
    return c.json(detail, 200);
  } catch (e) {
    logger.error({ err: e, batchId, rowId }, "import-batches 行详情失败");
    return c.json(internalError(), 500);
  }
});

// ── ⑩⑪ STEP 3：裁决（批量操作真实落库） ──

const rowIdsArray = z.array(z.number().int().min(1)).min(1).max(5000);

const decisionsRoute = createRoute({
  method: "post",
  path: "/import-batches/{batchId}/decisions",
  tags: [API_TAGS.analytics],
  operationId: "decideAnalyticsImportRows",
  summary:
    "批量裁决：confirm(唯一匹配一键确认)/assign(选择或搜索绑定)/ignore/external/account_day/reset",
  description:
    "confirm 只接受 unique_match 行（含 allUnique 全量模式）；CONFLICT 必须 assign 显式指定视频，系统绝不自动选最高分；" +
    "账号日级行 assign 直接 400（红线：禁止归属到单个视频）；external 行不落任何作品指标。",
  request: {
    params: batchIdParam,
    body: {
      content: {
        "application/json": {
          schema: z.discriminatedUnion("action", [
            z.object({
              action: z.literal("confirm"),
              rowIds: rowIdsArray.optional(),
              allUnique: z.boolean().optional(),
            }),
            z.object({
              action: z.literal("assign"),
              rowId: z.number().int().min(1),
              videoId: z.string().min(1).max(32),
            }),
            z.object({ action: z.literal("ignore"), rowIds: rowIdsArray }),
            z.object({ action: z.literal("external"), rowIds: rowIdsArray }),
            z.object({ action: z.literal("account_day"), rowIds: rowIdsArray }),
            z.object({ action: z.literal("reset"), rowIds: rowIdsArray }),
          ]),
        },
      },
    },
  },
  responses: {
    200: {
      description: "裁决成功 + 最新统计",
      content: {
        "application/json": {
          schema: z.object({ ok: z.literal(true), affected: z.number(), stats: statsSchema }),
        },
      },
    },
    400: { description: "账号日级禁止归属 / confirm 含非唯一匹配行 / 目标视频不存在" },
    404: { description: "批次或行不存在" },
    409: { description: "批次状态不允许裁决" },
    500: { description: "操作失败" },
  },
});

analyticsRoute.openapi(decisionsRoute, async (c) => {
  const { batchId } = c.req.valid("param");
  const action = c.req.valid("json") as DecisionAction;
  try {
    const result = await applyDecisions(batchId, action);
    if (result.kind === "not-found") return c.json(apiError("NOT_FOUND", "批次或行不存在"), 404);
    if (result.kind === "invalid-state") return invalidState(c, result.status);
    if (result.kind === "account-day-denied") {
      return c.json(
        apiError(
          "ACCOUNT_DAY_ASSIGN_DENIED",
          "该行为账号日汇总数据，禁止归属到单个视频（只能保存为账号日级或忽略）",
          {
            hint: "系统绝不拆数、不平均、不推测",
          },
        ),
        400,
      );
    }
    if (result.kind === "video-not-found") {
      return c.json(
        apiError("VIDEO_NOT_FOUND", `目标发布记录不存在或已删除：${result.videoId}`, {
          field: "videoId",
        }),
        400,
      );
    }
    if (result.kind === "not-confirmable") {
      return c.json(
        apiError("NOT_CONFIRMABLE", "批量确认只适用于唯一匹配行；冲突行必须逐个选择视频", {
          received: result.rowIds.map(String).join(","),
        }),
        400,
      );
    }
    return c.json({ ok: true as const, affected: result.affected, stats: result.stats }, 200);
  } catch (e) {
    logger.error({ err: e, batchId }, "import-batches 裁决失败");
    return c.json(internalError(), 500);
  }
});

// ──  STEP 4：Preflight 十项校验 ──

const preflightRoute = createRoute({
  method: "post",
  path: "/import-batches/{batchId}/preflight",
  tags: [API_TAGS.analytics],
  operationId: "preflightAnalyticsImportBatch",
  summary: "提交前十项校验报告（重复导入/未处理冲突/非法数值等，blocking 未清零禁止提交）",
  request: { params: batchIdParam },
  responses: {
    200: {
      description: "校验报告（pass=false 时含 blocking 清单）",
      content: { "application/json": { schema: preflightReportSchema } },
    },
    404: { description: "批次不存在" },
    500: { description: "校验失败" },
  },
});

analyticsRoute.openapi(preflightRoute, async (c) => {
  const { batchId } = c.req.valid("param");
  try {
    const result = await preflightBatch(batchId);
    if (result.kind === "not-found") return c.json(apiError("NOT_FOUND", "批次不存在"), 404);
    return c.json(result.report, 200);
  } catch (e) {
    logger.error({ err: e, batchId }, "import-batches preflight 失败");
    return c.json(internalError(), 500);
  }
});

// ──  提交落库（服务端重验 preflight，单事务，preimage 可回滚） ──

const commitRoute = createRoute({
  method: "post",
  path: "/import-batches/{batchId}/commit",
  tags: [API_TAGS.analytics],
  operationId: "commitAnalyticsImportBatch",
  summary:
    "确认导入：作品级写 video_metrics（复用单一口径+派生重算），账号级写 creator_metric_daily",
  description:
    "服务端不信任前端态：提交前重跑十项校验，不过一律 409 PREFLIGHT_FAILED 携报告；" +
    "落库记录 metadata.batch_id 溯源，commit_preimage 快照支持整批回滚；禁止直写 video_analytics。",
  request: { params: batchIdParam },
  responses: {
    200: {
      description: "提交成功",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.literal(true),
            summary: z.object({
              workLevel: z.number(),
              accountDayLevel: z.number(),
              ignored: z.number(),
              external: z.number(),
              skippedRows: z.array(z.object({ rowNumber: z.number(), reason: z.string() })),
            }),
          }),
        },
      },
    },
    404: { description: "批次不存在" },
    409: { description: "校验未通过（携完整报告）" },
    500: { description: "提交失败（事务整体回滚，可修正后重试）" },
  },
});

function preflightFailed(
  c: { json: (p: unknown, s: number) => Response },
  report: PreflightReport,
) {
  return c.json(
    { error: { code: "PREFLIGHT_FAILED", message: "提交前校验未通过，请先处理阻断项" }, report },
    409,
  );
}

analyticsRoute.openapi(commitRoute, async (c) => {
  const { batchId } = c.req.valid("param");
  try {
    const result = await commitBatch(batchId);
    if (result.kind === "not-found") return c.json(apiError("NOT_FOUND", "批次不存在"), 404);
    if (result.kind === "preflight_failed") return preflightFailed(c, result.report);
    return c.json({ ok: true as const, summary: result.summary satisfies CommitSummary }, 200);
  } catch (e) {
    logger.error({ err: e, batchId }, "import-batches 提交失败");
    return c.json(internalError(), 500);
  }
});

// ── ⑭ 回滚已提交批次 ──

const rollbackRoute = createRoute({
  method: "post",
  path: "/import-batches/{batchId}/rollback",
  tags: [API_TAGS.analytics],
  operationId: "rollbackAnalyticsImportBatch",
  summary: "回滚已提交批次：按 commit_preimage 精确恢复受影响记录（含派生行），导入可追溯可撤销",
  request: { params: batchIdParam },
  responses: {
    200: {
      description: "回滚成功",
      content: {
        "application/json": {
          schema: z.object({
            ok: z.literal(true),
            records: z.number(),
            creatorDailyKeys: z.number(),
          }),
        },
      },
    },
    404: { description: "批次不存在" },
    409: { description: "批次未提交 / 缺少回滚快照" },
    500: { description: "回滚失败" },
  },
});

analyticsRoute.openapi(rollbackRoute, async (c) => {
  const { batchId } = c.req.valid("param");
  try {
    const result = await rollbackBatch(batchId);
    if (result.kind === "not-found") return c.json(apiError("NOT_FOUND", "批次不存在"), 404);
    if (result.kind === "not-committed") {
      return c.json(apiError("NOT_COMMITTED", "仅已提交批次可回滚"), 409);
    }
    if (result.kind === "no-preimage") {
      return c.json(apiError("NO_PREIMAGE", "批次缺少回滚快照（异常数据），请联系维护者"), 409);
    }
    return c.json(
      { ok: true as const, records: result.records, creatorDailyKeys: result.creatorDailyKeys },
      200,
    );
  } catch (e) {
    logger.error({ err: e, batchId }, "import-batches 回滚失败");
    return c.json(internalError(), 500);
  }
});
