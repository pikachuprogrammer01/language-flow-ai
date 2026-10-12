# 数据分析真实闭环 Agent 执行提示词

以下内容可直接复制给 coding agent。它是 `docs/22_数据分析真实闭环实施规格.md` 的执行版提示词。执行时必须以仓库真实源码和设计文档为准，不得凭提示词臆造接口。

```text
你是 language-flow-ai 仓库的 coding agent。请在当前工作树中实施“数据分析真实闭环”功能，目标是让本地生成的视频、平台发布记录、导入指标、因子分析、优化建议和内容实验形成真实可追溯闭环。

一、必须先读的文件

按顺序读取并遵守：

1. AGENTS.md
2. PROGRESS.md
3. docs/17_视频数据分析模块设计.md
4. docs/19_发布数据一致性架构设计.md
5. docs/20_质量与运维门禁需求文档.md
6. docs/21_质量与运维门禁架构设计.md
7. docs/22_数据分析真实闭环实施规格.md
8. docs/ai-adapters/bmad-aoci-protocol.md
9. SPEC.md §5.6、§10.5 及现有 analytics 相关章节

如果仓库提供 AOCI MCP：先按 AGENTS.md 的 AOCI 合同调用 aoci_rules；需要完整认知时调用 aoci_overview，并原样跟随 continuation 直到完成。若 AOCI 不可用，按协议 fallback：rg 搜索、直读源码和 docs，并在最终报告声明未使用 AOCI。不要修改 aoci 托管资产，除非 AOCI 工具按合同要求维护。

二、不可违反的硬约束

1. 不修改 ContentDTO 14 个核心字段的名称、类型和语义。
2. 不修改已有 API 的路径、请求体和响应体结构；旧 API 必须继续通过契约测试。统一内容视图必须使用新路径。
3. 不修改状态流转 draft → ai_generating → content_ready → … → completed。
4. 不使用 any、as 强转绕过类型、@ts-ignore 或裸 SQL；数据库访问使用 Drizzle ORM query builder。
5. 后端保持 Hono + Zod；前端保持 Vue 3 Composition API + script setup + openapi-fetch。
6. 所有外部调用必须 try/catch；失败时返回明确错误；不能保留半成品或假成功状态。
7. 不把缺失指标补成 0；不把估算涨粉写成真实单视频归因；不把相关性写成因果结论。
8. 不在生产页面放假指标、假曲线、假推荐或硬编码表现数据。测试夹具只能用于隔离测试环境。
9. 不跨平台相加播放、点赞、完播、互动等指标。平台指标必须分别展示。
10. 不自动修改全局生成默认值，不训练模型权重，不实现 SHAP，不引入随机 A/B 分配。
11. 不执行生产 release、rollback、生产灌库或生产修复脚本。测试写入只允许测试库 :3307。
12. 单批修改尽量控制在 5 个业务文件以内；超过范围先拆成下一批，不做无关重构。
13. 新增 API 必须有 Zod/OpenAPI 定义和测试；新增表必须有增量 migration 和测试库演练。

三、目标决策（不得重新发明产品规则）

1. 统一列表按 contents 一内容一行；publish_records 作为平台明细。
2. 未发布的本地成片进入统一列表，但不创建 local 伪平台记录。
3. 默认列表显示已完成且有视频产物；支持未发布、已发布未导入、已有指标、导入冲突、失败/删除筛选。
4. 新增 GET /api/analytics/content-videos；保留现有 GET /api/analytics/videos 不变。
5. 因子默认目标指标 completion_rate；缺失时提示切换 effective_play_rate_2s。
6. actionable 推荐要求同平台、同窗口、同目标指标至少 8 个非空真实样本；否则只能输出 data_readiness。
7. 推荐只能预填当前生成链路已经支持的参数：模板、主题/场景、目标时长、词数、语速、音色、BGM 等。
8. 用户点击“使用推荐参数创建”后才预填；用户可以修改；最终提交值以用户提交为准。
9. 推荐证据必须能追到 analysis_result、参与视频、video_metrics、import_batch/import_row/source_field、content_features/audit。
10. 实验在生成时显式选择 A/B 变体，不隐式随机；每个变体少于 8 个有效样本时只给观察结论。
11. 新发布记录的默认 publish_time 使用关联 contents.created_at。
12. 历史只回填 publish_time IS NULL 的记录；已有人工/导入时间不得覆盖。
13. publish_time_source 使用 LOCAL_GENERATED、PLATFORM_IMPORTED、USER_EDITED；旧非空记录无法判断时允许为空。

四、分批执行顺序

必须按以下三批顺序实施。每批都要先检查现状，再最小编辑，再验证；前一批验证失败时不要开始后一批。

批次一：真实内容主视图与发布时间

目标：让本地成片、发布记录和真实导入指标在一个内容主视图中可见，并消除数据接入页的未知发布时间。

实施步骤：

1. 检查 db/schema.ts、analytics records/dashboard routes/services、frontend InsightsVideos/InsightsData 和现有 OpenAPI 客户端。
2. 新增 publish_records.publish_time_source 的增量 migration；确认唯一键、外键和旧数据兼容。
3. 修改 createPublishRecord：未传 publishTime 时读取关联 content.createdAt，写 LOCAL_GENERATED。
4. 修改导入提交：只有导入行提供真实发布时间时才更新 publish_records，并写 PLATFORM_IMPORTED；缺失时间不得清空已有值。
5. 修改人工编辑路径：用户直接编辑发布时间时写 USER_EDITED。
6. 编写 dry-run 回填逻辑，只更新历史 publish_time IS NULL 的记录；先在测试库演练，再由测试断言回填数量和幂等性。
7. 新增 GET /api/analytics/content-videos。响应必须是一内容一行，含 localStatus、generatedAt、platforms[]、平台指标、来源和覆盖摘要。
8. 实现状态计算：unpublished、published_unimported、imported、import_conflict、failed、deleted。默认只返回已完成且有视频产物，状态筛选可扩大范围。
9. 前端表现列表改用新接口；保留平台展开明细；缺失指标显示暂无数据，不显示 0。
10. 不修改旧 GET /api/analytics/videos 的结构；增加旧接口回归测试。

批次一必须验证：

- 本地有成片但无发布记录时仍有内容行，platforms=[]。
- 一个内容两个平台时只有一行，两个平台在明细中分别显示。
- 不同平台指标没有相加。
- 新记录默认时间来自 contents.created_at。
- 导入时间覆盖 LOCAL_GENERATED，但不覆盖 USER_EDITED。
- 历史空值回填可重复执行且第二次零变更。
- 旧 analytics API、OpenAPI coverage、前端现有页面测试不回归。

批次二：因子推荐和完整证据链

目标：推荐只能来自真实可追溯数据，并记录用户实际使用的最终参数。

实施步骤：

1. 检查 analytics-factors.service、analytics-recommend.service、recommendations/analysis_result schema、CreateTask/create-session prefill 现状。
2. 增加 recommendation_applications 增量表，记录 recommendationId、suggestedParams、prefillParams、finalParams、targetMetric、analysisResultId、contentId 和时间。
3. 因子和推荐查询统一按平台、时间窗口、目标指标过滤；isEstimated=1 的值不得计入 actionable 门槛。
4. 保持样本门槛为每个可比较组至少 8 个有效真实值；不足时返回 data_readiness，不生成参数改动建议。
5. 默认 targetMetric=completion_rate；没有样本时让前端明确提示切换 effective_play_rate_2s，不静默切换。
6. 新增 GET /api/analytics/recommendations/{recommendationId}/evidence，返回快照、分组、视频、指标、导入原始行和生产字段来源。
7. 导入批次成功提交后，在事务完成后触发一次推荐刷新；刷新失败不能回滚导入，必须记录错误并保留手动重算。
8. 点击“使用推荐参数创建”时创建 recommendation_application；生成成功后写 finalParams 和 contentId；生成失败不绑定内容。
9. 推荐卡和新建页显示目标指标、样本数、时间窗口、平台、依据维度和来源入口。
10. 所有文案使用“相关/观察/建议”，禁止“导致/保证提升/因果”。

批次二必须验证：

- 7 个真实样本只产生 data_readiness。
- 8 个同平台、同指标、同窗口真实样本可以产生 actionable。
- 估算值不会满足行动门槛。
- 推荐证据可追到 import_row 的原始行和 source_field。
- 用户修改预填值后，finalParams 是用户最终值而不是建议值。
- 导入刷新失败不会回滚已提交的指标。

批次三：实验分配和真实评估

目标：实验从“手工选已有内容”升级为“生成时显式分配变体，发布和导入后自动可评估”。

实施步骤：

1. 检查 experiments schema/service/routes、InsightsExperiments、CreateTask 和现有实验评估测试。
2. 新增 experiment_assignments 增量表；ContentDTO 不增加实验字段。
3. 新增 POST /api/analytics/experiments/{experimentId}/assignments，body 为 variant=A|B 和 assignedParams。
4. 新增 POST /api/analytics/experiments/{experimentId}/assignments/{assignmentId}/bind，body 为 contentId 和 finalParams。
5. 新建页增加实验选择和 A/B 变体选择；先创建 assignment，再运行现有生成流程。
6. 生成成功绑定 contentId 和 finalParams；生成失败保留未绑定 assignment，不伪造实验样本。
7. 实验评估优先按 assignments 生成 A/B 内容集；继续兼容旧 variant contentIds 读取。
8. 评估按真实导入指标输出样本数、覆盖率、中位数/均值、差值、lowSample 和非因果说明。
9. 任一变体有效样本少于 8 时 verdict 必须是不构成结论；没有指标时必须是无法评估。

批次三必须验证：

- assignment 只能使用 A/B，错误输入返回结构化 400。
- 生成失败不会绑定 contentId。
- 生成成功后实验页能看到正确变体归属。
- 指标导入后评估按真实指标分组，不使用假数据。
- 低样本不宣布胜者、不写因果结论。

五、验证命令

每批执行：

pnpm typecheck
pnpm lint
pnpm test
pnpm openapi:check

涉及真实页面和数据库时，重建隔离测试栈后执行：

pnpm docker:test
pnpm e2e

如果测试并行造成已知 CPU 争用，必须串行复跑失败用例和全量套件，并在报告中写清原因；不能把一次并行红灯直接判定为代码通过。

六、文档、AOCI 和 BMAD 收口

1. 代码达到当前批次最终稳定状态后，按 AGENTS.md 只调用一次 aoci_maintain；如果产生语义候选，按 AOCI 合同提交完整批次，不按路径猜写语义。
2. 按 docs/ai-adapters/bmad-aoci-protocol.md 执行：Planning → Coding Agent → AOCI Context → Implementation → Verification → AOCI Alignment → BMAD Review。BMAD 或 AOCI 不可用时按协议 fallback，不阻塞代码验证。
3. 实现稳定后更新 docs/17、SPEC 对应 API/表结构章节和 PROGRESS；不要改写第三方 runtime 文件。
4. 不创建生产 release，不执行生产数据库写入，不跳过 backup/gate。

七、最终报告格式

完成每批后，用以下格式报告：

- 本批目标：
- 已修改文件：逐项列出并说明用途
- 新增/保持的 API：列出路径和兼容性
- 数据库迁移：迁移编号、测试库演练结果、回滚/幂等结果
- 测试命令与结果：typecheck、lint、unit、openapi、E2E
- 真实数据证据：内容数、发布记录数、指标数、可追溯样本数
- 未完成项或阻塞：必须明确，不得用“基本完成”代替
- 是否允许进入下一批：只有当前批次所有验收项通过才回答“允许”
```

## 使用说明

- 第一次执行时把本文件完整内容交给 agent，不要只截取某一批。
- 如果只想推进一个批次，在提示词开头追加“只执行批次一/二/三，其他批次只做只读检查，不修改”。
- 如果 agent 试图修改旧 API、ContentDTO、生产库或引入假指标，应立即停止该批并要求它回到对应硬约束。
