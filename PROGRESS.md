# 项目进度

> 最后更新：2026-07-28
> 当前阶段：开发准备（工程配置完成，进入 shared 类型包编码）

---

## 一、整体进度

```
设计阶段      [████████████] 100%  8 份设计文档 + PRD + SPEC + README
工程配置      [████████████] 100%  Biome / Lefthook / Commitlint / TSConfig / Vitest / CI / pino
shared 包     [█░░░░░░░░░░░]   5%  index.ts 占位 + tsconfig
后端 API      [█░░░░░░░░░░░]   5%  骨架（Hono + 健康检查 + CORS + 限流 + Drizzle schema + logger）
Dify          [░░░░░░░░░░░░]   0%  4 个 Workflow
前端          [█░░░░░░░░░░░]   5%  骨架（index.ts 占位 + tsconfig + env.d.ts）
测试          [██░░░░░░░░░░]  15%  Vitest 配置就绪，待写用例
部署          [░░░░░░░░░░░░]   0%
```

---

## 二、当前在做

→ 阶段 2：shared 类型包（enums.ts → content.dto.ts → request.dto.ts → response.dto.ts）

---

## 三、下一步（优先级顺序）

### 阶段 1：工程地基（当前）

| # | 任务 | 状态 |
|---|------|------|
| 1 | 创建 AGENTS.md 行为约束 | ✅ 完成 |
| 2 | 创建 PROGRESS.md 进度文件 | ✅ 完成 |
| 3 | 配置 biome.json | ✅ 完成 |
| 4 | 配置 lefthook.yml | ✅ 完成 |
| 5 | 配置 commitlint | ✅ 完成 |
| 6 | 初始化 pnpm workspace + tsconfig | ✅ 完成 |
| 6a | 创建 .gitignore | ✅ 完成 |
| 6b | 创建 .env.example | ✅ 完成 |
| 6c | 创建 tsconfig.base.json + 3 个子包 tsconfig.json | ✅ 完成 |
| 6d | 创建 3 个 vitest.config.ts + shared 补 test 脚本 | ✅ 完成 |
| 6e | 创建 .github/workflows/ci.yml | ✅ 完成 |
| 6f | 引入 pino 日志库 + logger.ts | ✅ 完成 |
| 6g | 健康检查端点 + CORS + Rate Limiting | ✅ 完成 |
| 6h | Drizzle ORM schema + drizzle.config.ts | ✅ 完成 |

### 阶段 2：shared 类型包

| # | 任务 | 状态 |
|---|------|------|
| 7 | packages/shared/src/enums.ts | ⬜ |
| 8 | packages/shared/src/content.dto.ts | ⬜ |
| 9 | packages/shared/src/request.dto.ts | ⬜ |
| 10 | packages/shared/src/response.dto.ts | ⬜ |
| 11 | packages/shared/src/index.ts（统一导出） | ⬜ |
| 12 | packages/shared/package.json | ⬜ |

### 阶段 3：后端 API

| # | 任务 | 状态 |
|---|------|------|
| 13 | packages/backend 项目骨架（Hono + tsconfig） | ✅ 完成 |
| 14 | Drizzle ORM schema（cet_words + contents 表） | ✅ 完成 |
| 15 | POST /api/cet/validate-words + 测试 | ⬜ |
| 16 | POST /api/cet/random-words + 测试 | ⬜ |
| 17 | POST /api/tts/generate + 测试 | ⬜ |
| 18 | POST /api/video/render（含 Playwright + FFmpeg 管线）+ 测试 | ⬜ |
| 19 | @hono/zod-openapi → openapi.json 自动生成 | ⬜ |

### 阶段 4：Dify Workflow

| # | 任务 | 状态 |
|---|------|------|
| 20 | Workflow A1（scene_word）YAML | ⬜ |
| 21 | Workflow A2（word_card）YAML | ⬜ |
| 22 | Workflow A3（quiz）YAML | ⬜ |
| 23 | Workflow B（媒体生产）YAML | ⬜ |
| 24 | Workflow A → B 串联测试 | ⬜ |

### 阶段 5：Vue 前端

| # | 任务 | 状态 |
|---|------|------|
| 25 | packages/frontend 项目骨架（Vite + Vue 3 + Tailwind + shadcn-vue） | ⬜ |
| 26 | openapi-typescript 生成 schema.d.ts | ⬜ |
| 27 | openapi-fetch 客户端封装 | ⬜ |
| 28 | 新建任务页（CreateTask.vue） | ⬜ |
| 29 | 任务列表页（TaskList.vue） | ⬜ |
| 30 | 任务详情页（TaskDetail.vue）+ 视频播放 | ⬜ |

### 阶段 6：集成验证

| # | 任务 | 状态 |
|---|------|------|
| 31 | 端到端流程验证（用户输入 → Dify → API → MP4） | ⬜ |
| 32 | 读取情景词汇阅读视频模板设计规范，实现 HTML 模板 | ⬜ |

---

## 四、已完成

- [x] 项目定位与需求（PRD.md）
- [x] 技术选型（SPEC.md §2.2）
- [x] ContentDTO 数据结构设计（04 文档）
- [x] Dify Workflow 节点设计（05 文档）
- [x] 系统模块划分（03 文档）
- [x] API 接口契约定义（SPEC.md §五）
- [x] 模板设计规范（情景词汇阅读视频模板设计规范）
- [x] README 项目概览
- [x] AGENTS.md 行为约束
- [x] Git 自动化方案确定（lefthook + commitlint + Biome + Vitest）
- [x] 分支策略确定（main + feature/*，PR 自审）
- [x] tsconfig 配置文件（base + 3 个子包）
- [x] .gitignore + .env.example
- [x] Vitest 测试基础设施配置
- [x] GitHub Actions CI 流程
- [x] pino 日志方案集成
- [x] 后端骨架：健康检查 + CORS + Rate Limiting
- [x] Drizzle ORM schema 定义（contents + cet_words 表）

---

## 五、关键决策记录

| 日期 | 决策 | 理由 |
|------|------|------|
| 2026-07-28 | 前端选 Vue 不选 React | 开发者更熟 Vue |
| 2026-07-28 | 技术栈：Hono + Drizzle + Vue 3 + shadcn-vue | 轻量 TS 全栈，与 Dify Code 节点语言统一 |
| 2026-07-28 | API 管理：@hono/zod-openapi → openapi-typescript → openapi-fetch | 编译期类型安全，零手动同步 |
| 2026-07-28 | typecheck 放 pre-push 不放 pre-commit | commit 高频不应卡，push 是聚合检查点 |
| 2026-07-28 | commitlint 强制 | 保证历史可读，后续自动化 changelog |
| 2026-07-28 | 分支策略：main + feature/*，PR 自审 | solo 开发够用，不重 |
| 2026-07-28 | 代码检查：Biome 替代 ESLint + Prettier | 一个工具替代两个，速度快 30-50x |
| 2026-07-28 | 日志方案：pino + pino-pretty | Node.js 最快结构化日志，Hono 原生支持 |
| 2026-07-28 | 限流方案：hono-rate-limiter | 轻量，按 IP 限流，无需 Redis |
| 2026-07-28 | CI/CD：GitHub Actions | push/PR 自动跑 typecheck + test + lint，Node 20/22 双版本 |
| 2026-07-28 | 测试框架：Vitest 3 | 与 Vite 共享配置，backend=node / frontend=jsdom |

---

## 六、阻塞项

无
