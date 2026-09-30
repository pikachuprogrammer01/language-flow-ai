# AGENTS.md — AI 辅助开发行为约束

> 版本：V1.1
> 本文件在每次会话启动时自动加载，定义 AI Agent 的行为边界。
> 违反任何 MUST 规则视为严重错误。

---

## 零、环境与版本信息（长期不变，会话启动即用）

```
项目        四级词汇情景记忆短视频平台（language-flow-ai）
运行环境    macOS arm64 + OrbStack（Docker）/ Node v24（支持 --env-file）/ pnpm workspace
服务端口    本地 dev：backend 8080 / UI 5173（= 工作树代码）
            Docker 测试栈：UI 5174 / 测试库 3307（= 工作树代码，每次 --build）
            Docker 生产栈：UI 15173（= deploy/prod.env 的 APP_VERSION 固定 tag，不随工作树变）
            MySQL 生产库 3306 · Ollama 11434（三轨共用一个 Ollama 实例）
数据库      开发/测试用 mysql://dev:dev@localhost:3307/language_flow（表：cet_words / contents / __drizzle_migrations）
            .env 保留生产连接串 :3306 仅供容器与发布参数；dev / db:* 脚本已内置 :3307 默认值，
            对回环 :3306 写库（migrate/seed）需显式 DB_ALLOW_PROD=1——MUST：不得为了图便利去写生产库
技术栈      Hono 4 · Drizzle ORM · MySQL 8.4 · Vue 3.5 + Tailwind CSS 4 · Playwright + FFmpeg 8 · Biome · Vitest 3 · zod
LLM 配置    Ollama 本地（qwen2.5:7b，纯本地离线方案 2026-08-17 用户决策），配置在 packages/backend/.env
            （LLM_BASE_URL/LLM_API_KEY/LLM_MODEL；.env 已被 gitignore，密钥不入库）
文档版本    SPEC V2.0 · docs/ 01-15（05 已废弃由 15 取代）· PROGRESS 持续更新
常用命令    pnpm dev（本地前后端）· pnpm docker:test（测试栈）· pnpm docker:up（生产，不构建）
            pnpm docker:release / docker:rollback <tag> / docker:version（MUST：生产版本只有用户明确要求时才能 release）
            pnpm test / pnpm lint / pnpm typecheck · pnpm e2e（真实测试栈 E2E，需先 docker:test）/ pnpm e2e:full（全链路含 Ollama 生成，手动触发不进 hooks）
            pnpm --filter backend db:generate / db:migrate / db:seed（词库 seed-data/cet_words.csv）
```

---

## 一、架构边界（MUST）

### 1.1 可修改范围

```
✅ 可自由修改：
  packages/shared/src/     — 类型定义（同步更新所有引用方）
  packages/backend/src/    — 后端路由、service、DB、渲染器
  packages/frontend/src/   — Vue 页面、组件
  *.config.*               — 工程配置文件（biome/lefthook/commitlint）
  PROGRESS.md              — 进度更新

⚠️ 需用户确认后修改：
  docs/*.txt               — 设计文档（通常是先改代码，确认后再更新文档）
  SPEC.md                  — 技术规格变更
  PRD.md                   — 需求变更
  package.json             — 新增依赖

❌ 绝对禁止修改：
  ContentDTO 14 个核心字段的名称/类型/语义
  已发布的 API 契约（路径、请求体、响应体结构）
  状态流转规则（draft → ai_generating → content_ready → … → completed）
  已有的 TemplateType 枚举值（新增可以，修改/删除不行）
```

### 1.2 文档优先级

```
docs/ 设计文档  >  SPEC.md  >  PRD.md  >  README.md  >  凭记忆猜测
     ↑                                      ↑
  真相来源                             派生文件，不能作为唯一的实现依据
```

**MUST：写任何代码前，先读对应的 docs/ 设计文档。允许修改文档时同步更新代码。**

---

## 二、技术栈硬约束（MUST）

| 层 | 约束 | 禁止替代品 |
|----|------|-----------|
| 后端框架 | Hono | Express / Fastify / NestJS |
| 数据校验 | Zod | Joi / Yup / class-validator |
| ORM | Drizzle ORM query builder | Prisma / Knex / 裸 SQL |
| 数据库 | MySQL 8.4 | PostgreSQL（后续可加，但现在不行） |
| 前端框架 | Vue 3.5 Composition API + `<script setup lang="ts">` | Options API / React |
| UI 组件 | shadcn-vue + Tailwind CSS 4 | Element Plus / Naive UI |
| 前端请求 | openapi-fetch（类型安全客户端） | axios / 裸 fetch |
| API 文档 | @hono/zod-openapi → OpenAPI 3.1 → Scalar | 手写 Swagger YAML |
| 视频渲染 | Playwright + FFmpeg | Puppeteer（非 darwin/arm64 场景可换） |
| 代码检查 | Biome | ESLint + Prettier |
| Git hooks | lefthook | husky |

---

## 三、代码风格规范（MUST）

### 3.1 语言和范式

```
MUST:
  ✅ 所有代码用 TypeScript，禁止 JavaScript
  ✅ 纯函数优先，副作用集中在 service 层
  ✅ 单个函数不超过 50 行
  ✅ 导出函数必须有显式返回类型注解
  ✅ 修改入参视为错误（immutable）

MUST NOT:
  ❌ 任何 any 类型
  ❌ as 强转绕过类型错误
  ❌ @ts-ignore 或 @ts-expect-error（除非旁边有注释解释）
  ❌ 循环导入
  ❌ 相对导入超过 2 级（../../ 是危险信号）
```

### 3.2 命名规范

```
文件名        kebab-case       content.dto.ts, scene-word.renderer.ts
变量/函数     camelCase        targetDuration, validateWords()
类型/接口     PascalCase       ContentDTO, WordInfo
枚举值        snake_case 字符串 "content_ready", "scene_word"
数据库列      snake_case       created_at, target_duration
API 路径      kebab-case       /api/cet/validate-words
Vue 组件      PascalCase       CreateTask.vue, TaskList.vue
```

### 3.3 TypeScript 特约规范

```
✅ 用 satisfies 做穷尽性检查
✅ 用 discriminated union + 类型守卫区分模板（isSceneWord / isWordCard / isQuiz）
✅ Zod schema 放在 route 文件里，和 handler 相邻
✅ 用 z.infer<typeof schema> 推导类型，不重复定义 interface
✅ shared 包的类型从 @ai-english/shared 导入
```

### 3.4 错误处理

```
✅ 所有外部服务调用必须有 try-catch
✅ 失败时返回明确的错误信息
✅ 视频渲染失败时 status 必须设为 "failed"，不保留半成品
```

---

## 四、Git 自动化规范（MUST）

### 4.1 Commit 格式

```
type(scope): 中文描述

type     — feat / fix / refactor / docs / test / chore / style
scope    — shared / backend / frontend / docs
描述     — 中文，祈使句，50 字以内

示例：
  feat(backend): 实现 /api/cet/random-words 接口
  fix(frontend): 修复任务列表分页切换后数据未更新
  refactor(shared): 提取 ContentArray 联合类型
  chore: 配置 Biome 和 lefthook
```

不合规的 commit message 会被 commitlint 拒绝。

### 4.2 Git Hooks

```
pre-commit（< 1 秒）
  → Biome format + lint（仅 staged files）

commit-msg
  → commitlint 格式校验

pre-push
  → pnpm -r typecheck（全仓类型检查）
  → pnpm -r test --run（单元测试）
```

### 4.3 分支策略

```
main           — 始终可运行，不允许直接 push
feature/*      — 每个功能一个分支（如 feature/cet-api）
fix/*          — 修 bug
```

开发流程：从 main 拉 feature 分支 → 开发 → 开 PR → 自审 → squash merge 回 main。

---

## 五、文件操作规范（MUST）

### 5.1 修改范围限制

```
单次任务允许最大范围：
  新增功能  → ≤ 5 个文件（route + service + test + type + 文档）
  修复 bug  → ≤ 3 个文件
  重构      → ≤ 5 个文件（需用户确认后执行）
  配置变更  → ≤ 3 个文件

超过限制时：分批次，每批征得用户确认。
```

### 5.2 操作方式

```
✅ 最小化编辑（用 edit_file 精确替换，不重写整个文件）
✅ 修改前先 read_file 确认当前内容
✅ 修改后运行 typecheck + 相关测试
❌ 禁止在不读取文件的情况下凭记忆编辑
❌ 禁止重写整个文件（除非文件 < 30 行且需要大幅重构）
```

---

## 六、文档更新规则（MUST）

### 6.1 同步更新映射表

```
改动内容                  →  必须同步更新的文档
─────────────────────────────────────────────
shared 类型定义变更        →  SPEC.md §三/四 + docs/04
API 路径/参数/响应变更     →  SPEC.md §五 + docs/05
Workflow 节点变更          →  docs/05 对应节点定义
数据库表结构变更           →  SPEC.md §十
技术选型变更              →  SPEC.md §2.2 + README.md 技术方案表
ContentDTO 核心字段变更    →  docs/04 + docs/05 + SPEC.md + README.md（全部）
新增/完成功能模块          →  PROGRESS.md
```

### 6.2 无需更新文档的情况

```
- service 层内部重构（接口不变）
- 修 bug 不改变行为
- 加注释、加测试
- 代码格式化、重命名局部变量
```

### 6.3 需求变更流程

```
PRD.md 变更 → SPEC.md 变更 → docs/ 对应设计文档变更 → 代码变更
（按顺序，不要跳步）
```

---

## 七、测试规范（SHOULD）

```
✅ 新增 API 端点必须同步新增测试文件
✅ 修改 shared 类型后运行 pnpm -r typecheck 确认全仓通过
✅ 测试文件与源文件同目录或 tests/ 同级目录
```

---

## 八、Session 启动流程（MUST）

每次新会话启动时，Agent 必须：

1. 读取 `AGENTS.md`（本文件，自动加载）
2. 读取 `PROGRESS.md`，明确当前进度和下一步任务
3. 如果用户给出具体指令，先确认指令与 PROGRESS.md 中的优先级不冲突
4. 如果用户没有具体指令，主动报告 PROGRESS.md 中标注的下一步任务

---

## 九、违规处理

```
违反 MUST 规则     → 开发人员有权要求 Agent 立即停止并修正
违反 SHOULD 规则   → 开发人员提醒，Agent 应采纳
连续违规           → 重新评估 AGENTS.md 的约束是否合理
```

<!-- aoci:begin -->
## AOCI 仓库认知

AOCI 为本仓库维护一个稳定、可版本化、可增量更新的仓库级认知层，供模型跨任务复用对系统的理解。

`aoci.txt` 是面向模型的结构化认知索引。它以每个受管理文件、数据库表或其他受管理对象一条独立 Entry 的方式，用符号标签与 F/R/A/S 语义表达对象的核心职责、重要关系、对外契约，以及理解或修改系统时必须知道的非显然约束和设计决策。

Header、目录段和全部 Entry 共同组成完整仓库索引，可以覆盖前端、后端、配置、数据库结构及其他受管理内容。受管理内容发生变化时，通常只需维护受影响的认知条目，不需要重新生成整个索引。

AOCI 提供系统架构、对象职责、重要关系、对外契约和关键约束的高密度视图。

### 工作原理

AOCI 采用“模型生成、模型读取”的认知闭环。

Header、Entry 和 Curation 语义的创作只按当前机器签发的 Plan 与实时 Guide 执行；由 Host 模型基于当前绑定证据独立完成。

Entry 的语义必须来自模型对真实证据的理解。不得仅依据路径、文件名、扩展名、AST、符号列表、依赖扫描、正则、固定模板或规则引擎推导、预填、拼接或改写索引语义。

对 Fresh Bootstrap，只按当前机器签发的 Plan 和实时 Guide 执行。当它们要求创作时，Host 模型创作 Root、Meta、Tag 和 F/R/A/S，提供 authoring-run 声明，并把它绑定到 Plan、Evidence 与完整 Candidate。不得要求 AOCI 填写 `origin=host_model`、制造 Receipt 或把程序生成的 Framework 当作语义。本文件不自行重建 Onboarding 流程。内部批次不是用户决策；只有遇到既有批准边界或真实的安全、漂移、CAS、Recovery 条件才停止。

### 最小使用入口

- `aoci_rules`：取得当前AOCI版本的会话运行合同。
- `aoci_overview`：建立或恢复本仓库的完整认知。
- `aoci_maintain`：受管理对象达到最终稳定状态后检查认知是否需要维护。
- `aoci_update_entry`：提交与当前证据和源码摘要绑定的完整语义更新批次。
- `aoci_report`：仅当当前布局和工具状态支持时，在证据不足、无法可靠生成语义时登记待办，不猜写。

其他MCP工具、CLI命令、参数和专项流程，以当前工具说明、Guide和 `--help` 返回内容为准，不在本文件中重复完整手册。

本区块只规定仓库接入、认知使用和收尾原则。`aoci_rules` 承载当前会话合同，Guide实时输出承载当前Plan的执行顺序与停点，工具Schema、Spec和Validator承载机器结构与判据；Prompt、Description、README和静态文档不能覆盖这些机器事实。

### 建立、生成和恢复认知

1. 每个新的 Agent Run 开始时，应先判断：

   - 本仓库是否已经存在可用的完整AOCI索引；
   - 当前上下文中是否已有与本仓库根、当前索引版本和当前AOCI服务相匹配，并且模型仍可可靠使用的完整仓库认知。

2. 仓库已经存在可用的完整索引，但当前Run没有可靠完整认知时，先调用 `aoci_rules`，再调用 `aoci_overview`。

   完整认知仍可靠时直接复用。局部不确定本身不要求机械重读系统全貌。

   本Run从已知Host上下文压缩恢复时（包括宿主注入的压缩摘要），必须把此前模型认知视为不可靠。压缩handoff不得保留或摘要正式Whole-Index，也不得保留或摘要任何Overview Header、Entry、Chunk、Challenge或Attestation正文；只能保留安全续接所需的receipt身份、未完成write或Recovery状态，以及立即重载指令。复制进handoff的Whole-Index语义或receipt不能证明恢复后模型的当前认知可靠。若当前上下文已无法可靠保留运行合同，先调用 `aoci_rules`。继续业务任务前，使用 `refresh_reasons=["context_compaction"]` 和新的 `refresh_event_id` 调用普通完整Whole-Index `aoci_overview`（不设置 `check_only` 或设为false）；不得使用 `check_only` 或认知probe。原样跟随每个 `next_cursor` 直到 `completed=true`，确认交付，并且只基于新交付正文提交一次Attestation。完成这次新的完整传输后，即使Attestation为partial或fail也消费该generation，并按既有合同继续source-bound任务，不再自动调用第二次Overview。

   AOCI可以针对 `context_compaction`、项目 `cognition_refresh_threshold` 下的机器 `semantic_threshold` 或主要 `phase_transition` 提供checkpoint与认知状态事实。只需要这些紧凑事实时使用 `check_only=true`；这些事实只向Agent提供建议，不替模型决定是否需要系统全貌。

   Agent显式调用普通 `aoci_overview`（未设置 `check_only` 或为false）时，只要能形成一致的CognitionSet，AOCI必须完整交付请求scope。不得因为已有receipt、阈值未达到或没有待处理刷新原因而抑制正文。正式认知Dirty或Stale时仍交付正文，但必须标记不可靠。存在未决恢复或无法形成一致snapshot时失败关闭，不返回混合正文。

   普通Overview返回 `continuation_required=true` 时，必须原样提交 `next_cursor` 并自动继续到 `completed=true`。不得询问用户、开始业务任务或给出阶段性系统结论。Host截断、缺块、重复、乱序、cursor失败、Index变化或`chunk_tokens`变化时停止本次认知链。Attestation完成前不得用Memory、源码、Spec、`aoci.txt`、历史会话、scope、search或Entry读取修补或补充Whole-Index认知。Challenge ordinal是正式Entry序列中的1-based位置；Header内容、注释、空行、Section/Overview/Chunk Marker、Receipt与Metadata均不计数，Chunk Receipt ordinal使用同一序列。Attestation必须原样回绑本次Challenge发布的当前`index_sha256`、`entry_sequence_sha256`与`entry_count`；旧Index、旧Entry序列、旧数量或旧Attestation均无效。完整链结束后只正式提交一次既有模型认知Attestation；同一响应只允许一次不改变语义答案的JSON Schema或字段格式修正。对象、Tag或F不匹配即失败且认知吸收不确定，不得语义重试或旁路补答。首次认知失败时还不得执行Root/Meta、Migration、全局布局或其他未重新绑定的系统级决策。上下文压缩刷新若传输完整、认知身份不变、治理对齐且没有Recovery或第三方冲突，即使Attestation为partial或fail也消耗该refresh generation，并继续原任务，不再自动重读Overview。`system_mastery_percent`只自评系统框架——架构、职责、强关系、稳定外部契约以及高熵安全和维护约束——不表示完整实现或运行实况知识；机器索引覆盖率必须分开。默认只向用户输出由本次真实覆盖率、Challenge、块数、Token和掌握度生成的规定成功或失败一句话。Host截断时提示用户把 `overview_delivery.chunk_tokens` 设置为更小的合法值后重新开始，不得自动修改。

   加法认知等级必须与严格证明字段分开解释。`delivery_verified`表示已加载Index且Host交付已确认，但完整认知验证仍未完成；应表达为“已加载且交付已验证”，不得描述为“没有认知”或“没有理解系统”。`cognition_verified`要求Attestation通过（Challenge至少80%的ordinal完全正确且对象身份至多失手一处），`cognition_governed`还要求治理对齐。通用完整读取失败句只用于真实交付故障。

   当Overview响应包含可选`cognition-state/v2`投影时，必须分别解释各维度。其Level止于`model_cognition_usable`；`strict_attestation_verified`、`governance_aligned`与`current_system_cognition_reliable`都是独立状态，绝不参与该Level。ordinal、对象身份、Tag或核心F不匹配可以导致严格Attestation失败，而模型认知仍然可用；不得仅凭这种不匹配就宣称模型没有理解系统。只有`current_system_cognition_reliable=true`允许无保留地声称当前完整系统认知可靠。投影缺失时继续使用上述Legacy解释。

   普通的只读审计、分析、检查、不修改代码或不提交、不push，不自动等于严格零写入，也不改变上述认知有效性判断。Codex Memory和历史Skill只能辅助恢复经验、用户偏好与调查方向，不能替代与当前仓库根、索引摘要、AOCI服务身份和认知范围匹配的当前认知收据；项目AGENTS和当前AOCI身份在AOCI状态上优先于历史Memory。

   只有用户明确禁止Ledger、元数据、`.aoci`运行资产及任何文件写入时，才按严格零写入处理。若必要的认知建立与该边界冲突，必须报告冲突并请求用户裁决或建议使用隔离副本，不得静默以Memory替代当前仓库认知。

3. 仓库没有可用的完整索引，或当前只有最小骨架、Header不完整、Entries未完成、必要Curation尚未裁决时，如果需要建立正式完整AOCI索引，先取得 `aoci_rules`，然后进入当前AOCI Guide。由Guide依据仓库真实状态决定下一阶段并完成必要安全步骤。

   `aoci_maintain` 不替代索引建立流程。

   不在本文件中自行重建或硬编码完整索引生成状态机。

4. 在长程任务中，模型负责保留当前认知收据并正确使用刷新门禁：

   - Host报告上下文压缩或模型已知系统全貌丢失时，执行上述强制 `context_compaction` 重载规则；AOCI不能自行推断Host事件；
   - 进入真正的主要阶段时声明 `phase_transition`，不得把函数、测试运行或小步骤当作阶段；
   - 在有用的稳定检查点通过 `check_only=true` 取得机器语义计数；
   - 除已知压缩的强制重载外，由Agent判断当前任务是否需要再次显式获取指定scope或完整Overview；
   - 在维护和对齐完成前，保留AOCI报告的Dirty或Stale可靠性状态。

### 任务收尾与认知维护

5. 纯只读问答、分析、版本核验，或没有产生受AOCI管理对象变化的任务，不需要调用维护工具。当前AOCI版本是任意`aoci_overview` check_only或`aoci_maintain`响应里的`cognition_receipt.mcp_service_version`；二进制路径是项目`.mcp.json`里的`command`，CLI不必在PATH上。

6. 发生受AOCI管理对象变化时，待其达到本次任务的最终稳定状态后，只调用一次 `aoci_maintain`。不要在每次中间修改后逐文件维护。

7. 若维护结果返回真实语义候选，Host 模型必须基于每个候选绑定的对象和必要证据，独立创作完整标签与F/R/A/S更新。通过 `aoci_update_entry` 一次提交当前机器签发批次的完整候选集合，同时原样保留每项 `source_sha256`、`candidate_id` 与对应domain批次身份。`max_entries`只限制单次请求和原子事务，不限制logical plan、Whole-Index或Managed Scope。`remaining`非零时，在当前批次成功Apply后重新调用Maintain并从新preimage继续；绝不能为满足transport上限缩减Index覆盖或自行截取返回批次。

   没有足够证据且当前布局支持 `aoci_report` 时，使用它而不猜测、套用模板或为消除待办而生成缺乏证据的认知。

8. 必须遵守工具返回的结构化状态和安全边界：

   - `repair_required`：只修复明确命中的候选，再重新提交当前机器签发的完整批次；
   - `stopped`：结束当前写入尝试并检查 `failed_step`、错误、正式写入证据与Recovery。auto模式下，已证明零写入则记录closure并重新Plan；完整Intent和可证明postimage则Resume；策略要求Rollback且preimage可证明则精确恢复后重新Plan。只有证据不足、第三方正式字节冲突、需要审批或外部动作，或命中其他真实安全边界时，才停止整个用户任务；
   - 冲突、审批、人工裁决、权限和安全信号不得忽略；
   - 已经对齐后不得重复维护或重复写入；`refresh_ready_for_overview` 是checkpoint事实，由Agent决定是否为下一阶段请求普通完整Overview。

   维护完成后如果又修改了任何受管理对象，之前的维护结果失效，应在新的最终稳定状态重新完成收尾。

9. 用户只限制业务文件范围，但没有明确禁止仓库托管资产时，AOCI托管资产可以在收尾阶段为保持认知一致而更新，并应在审计和提交中与业务文件区分。

   用户明确禁止修改 `aoci.txt`、`.aoci`、元数据或任何额外文件时，以用户限制为准，不得写入，并如实报告剩余不一致。

### 专项流程

初始化、完整索引生成、Header生成、Entries生成、数据库结构索引、Curation、人工评审和故障恢复，只按当前AOCI Guide或工具在对应阶段返回的指令、命令和安全停点执行。

不预加载、不猜测，也不自行重建这些专项流程。平台调用方式、请求格式、批次上限、审批规则、索引格式细节和恢复步骤由对应Guide、工具说明、模型Prompt和CLI帮助按需提供。
<!-- aoci:end -->
