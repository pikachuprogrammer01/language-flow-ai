# AGENTS.md — AI 辅助开发行为约束

> 版本：V1.0
> 本文件在每次会话启动时自动加载，定义 AI Agent 的行为边界。
> 违反任何 MUST 规则视为严重错误。

---

## 一、架构边界（MUST）

### 1.1 可修改范围

```
✅ 可自由修改：
  packages/shared/src/     — 类型定义（同步更新所有引用方）
  packages/backend/src/    — 后端路由、service、DB、渲染器
  packages/frontend/src/   — Vue 页面、组件
  dify/                    — Workflow YAML 文件
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
| 数据库 | MySQL 8.0 | PostgreSQL（后续可加，但现在不行） |
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
  ✅ 单个函数不超过 50 行（Dify Code 节点 main 函数例外）
  ✅ 导出函数必须有显式返回类型注解
  ✅ 修改入参视为错误（immutable）

MUST NOT:
  ❌ 任何 any 类型（Dify Code 节点输入参数用 Record<string, unknown> 例外）
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
scope    — shared / backend / frontend / dify / docs
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
✅ 修改 Dify Workflow 后确认所有节点引用的变量名存在
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
