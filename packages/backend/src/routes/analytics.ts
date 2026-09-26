// 视频数据分析路由组合器（docs/17 §十一；批次 5C 按领域拆分，对外路径/operationId/契约逐字不变）
// 领域模块向共用 analyticsRoute 实例注册（导入顺序=OpenAPI 文档收录顺序）：
//   ./analytics/records    发布记录 CRUD（统一 ID 链路）
//   ./analytics/import     单视频指标查询 · Creator Import · 指标目录 · 账号日聚合/批量导入
//   ./analytics/features   内容特征（读取/sync 重算/人工标签覆盖）
//   ./analytics/dashboard  漏斗 overview · 表现列表 · benchmark · trend
//   ./analytics/insights   factors(GET 纯读/POST 留档) · timeline · recommendations · structure · experiments
//（抖音开放平台同步端点已砍除：无企业资质，外部绩效数据唯一入口 = POST /api/analytics/import）
import { analyticsRoute } from "./analytics/shared";
import "./analytics/records";
import "./analytics/import";
import "./analytics/features";
import "./analytics/dashboard";
import "./analytics/insights";

export { analyticsRoute };
