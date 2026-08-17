# 项目进度

> 最后更新：2026-08-16
> 当前阶段：后端 API 开发中（video/render 完成，进入 #19 OpenAPI 文档生成）

---

## 一、整体进度

```
设计阶段      [████████████] 100%  14 份设计文档 + PRD + SPEC + README
工程配置      [████████████] 100%  Biome / Lefthook / Commitlint / TSConfig / Vitest / CI / pino
shared 包     [████████████] 100%  enums + ContentDTO + Request/Response DTO + 类型守卫
后端 API      [████░░░░░░░░]  40%  骨架 + TTS 配音 + 文件服务 + validate-words（含测试）
Dify          [░░░░░░░░░░░░]   0%  4 个 Workflow
前端          [██░░░░░░░░░░]  15%  骨架（Vite + Vue + Tailwind + 入口文件）
测试          [██████░░░░░░]  60%  Vitest 就绪，26 用例（cet 13 + tts 13），待补 tts service 与渲染测试
部署          [░░░░░░░░░░░░]   0%
```

---

## 二、当前在做

→ 阶段 3：后端 API — OpenAPI 3.1 自动生成（#19，@hono/zod-openapi）

---

## 三、下一步（优先级顺序）

### 阶段 1：工程地基（✅ 全部完成）

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

### 阶段 2：shared 类型包（✅ 全部完成）

| # | 任务 | 状态 |
|---|------|------|
| 7 | packages/shared/src/enums.ts | ✅ 完成 |
| 8 | packages/shared/src/content.dto.ts（含 isSceneWord/isWordCard/isQuiz 类型守卫） | ✅ 完成 |
| 9 | packages/shared/src/request.dto.ts | ✅ 完成 |
| 10 | packages/shared/src/response.dto.ts | ✅ 完成 |
| 11 | packages/shared/src/index.ts（统一导出） | ✅ 完成 |
| 12 | packages/shared/package.json（补 exports） | ✅ 完成 |

### 阶段 3：后端 API

| # | 任务 | 状态 |
|---|------|------|
| 13 | packages/backend 项目骨架（Hono + tsconfig） | ✅ 完成 |
| 14 | Drizzle ORM schema（cet_words + contents 表） | ✅ 完成 |
| 15 | POST /api/cet/validate-words + 测试（13 用例：service 6 + route 7） | ✅ 完成 |
| 16 | POST /api/cet/random-words + 测试（11 用例：service 4 + route 7，高频池 200 随机抽样） | ✅ 完成 |
| 17 | POST /api/tts/generate（Edge TTS 配音 + 本地文件存储） | ✅ 完成 |
| 17a | GET /files/audio\|video/:filename 静态文件服务（防路径穿越） | ✅ 完成 |
| 17b | POST /api/tts/from-content（ContentArray 拼接 + 合成 + ffprobe 时长，Workflow B 入口） | ✅ 完成 |
| 17c | tts 测试补齐（拼接纯函数 5 + 路由 8，共 13 用例） | ✅ 完成 |
| 18 | POST /api/video/render（Playwright 截图 + FFmpeg 合成，三个模板 renderer）+ 测试（时长分配 7 + 路由 9 用例） | ✅ 完成 |
| 19 | @hono/zod-openapi → openapi.json 自动生成（6 API 全收录，/doc Scalar UI，启动时写入 src/openapi.json） | ✅ 完成 |

### 阶段 4：AI 内容生成（2026-08-17 架构变更：去 Dify，后端直连 LLM）

| # | 任务 | 状态 |
|---|------|------|
| 20 | llm.service（OpenAI 兼容调用，Agnes/Ollama 环境变量切换）+ content.service（生成 story + 词库校验）+ POST /api/content/generate + 测试（14 用例：llm 3 + service 4 + route 7） | ✅ 完成 |
| 21 | prompt 调优：候选词注入（词库高频池随机 4 倍）+ 英文词嵌入 + 主题式标题 + JSON 容错重试 ×3 + 文本英文词自动提取（2026-08-17 实测 qwen2.5:7b） | ✅ 完成 |
| 22 | 端到端：content/generate → tts/from-content → video/render 串联验证（实测：森林探险 12.12s MP4，1080×1920 h264+aac） | ✅ 完成 |

> 原 #20-24（Dify Workflow YAML）已废弃：docs/05 标注废弃，由 docs/15 取代。

### 阶段 5：Vue 前端

| # | 任务 | 状态 |
|---|------|------|
| 25 | packages/frontend 项目骨架（Vite + Vue 3 + Tailwind） | ✅ 完成 |
| 26 | openapi-typescript 生成 schema.d.ts（592 行，6 API 全收录） | ✅ 完成 |
| 27 | openapi-fetch 客户端封装（src/api/client.ts，类型安全） | ✅ 完成 |
| 28 | 新建任务页（CreateTask.vue，单页全流程：生成→配音→渲染→播放） | ✅ 完成 |
| 29 | 任务列表页（TaskList.vue） | ⏳ 搁置（无任务持久化 API，YAGNI；做任务 API 时补） |
| 30 | 任务详情页（TaskDetail.vue）+ 视频播放 | ⏳ 同上（播放已在 CreateTask 实现） |

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
- [x] Backend serve() 启动 + 错误处理 + 请求日志中间件
- [x] db/index.ts 数据库连接初始化
- [x] POST /api/tts/generate：Edge TTS WebSocket 合成 MP3 + 本地文件存储（2026-07-29）
- [x] GET /files/audio|video/:filename 静态文件服务（校验路径穿越）
- [x] POST /api/tts/from-content：拼接 + 合成 + ffprobe 时长探测，TTS 契约唯一化（2026-08-16）
- [x] 文档冲突修复：TTS 契约统一（SPEC §5.2 双端点/§7.3、docs/05 全链）、空 segment 丢弃、wordList 转换、清单类对齐（2026-08-16）
- [x] shared 类型包：enums + ContentDTO + Request/Response DTO + 类型守卫（2026-08-16）
- [x] POST /api/cet/validate-words：词库精确匹配（Drizzle inArray + level 过滤）+ 13 用例测试（2026-08-16）
- [x] 数据库对接：MySQL 8.4 容器（arm64v8/mysql:8.4）+ drizzle migration 建表（cet_words + contents）（2026-08-16）
- [x] 文档全面完善：新增 08-12 五份设计文档（TTS/词库/渲染/前端/部署），修订 README + SPEC §5.2 音色契约（2026-08-16）
- [x] Frontend 入口文件（vite.config.ts / index.html / main.ts / App.vue）
- [x] Tailwind CSS 4 Vite 插件接入
- [x] .nvmrc + .node-version（Node 24）
- [x] docker-compose.yml（MySQL 8.4）
- [x] .editorconfig

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
| 2026-07-28 | CI/CD：GitHub Actions | push/PR 自动跑 typecheck + test + lint，Node 24 |
| 2026-07-28 | 测试框架：Vitest 3 | 与 Vite 共享配置，backend=node / frontend=jsdom |
| 2026-08-17 | 去 Dify：后端直连 LLM（/api/content/generate） | 简化架构，少一个部署依赖，env 切换模型 |
| 2026-08-17 | 模型：纯本地 Ollama qwen2.5:7b（不用 Agnes） | 完全免费离线；质量不足可换 14b 或接免费云 API |
| 2026-07-28 | Node 版本：24 | 最新 LTS，与 pnpm 11 配套 |
| 2026-07-28 | Tailwind 4 Vite 插件 | 替代 PostCSS，零配置启动 |
| 2026-07-28 | 本地数据库：Docker Compose | MySQL 8.4，一键启动 |
| 2026-08-16 | 背景图方案：暂用纯白背景（background 固定 "white"），不做预设图片库 | 最小可用，视觉方案后续再扩展 |
| 2026-08-16 | shared 类型包落地：TS 字面量联合 + const 对象（satisfies）替代 TS enum | 值仍为 snake_case 字符串，编译期可穷尽检查，无 enum 运行时开销 |
| 2026-07-29 | TTS 方案：Edge TTS（微软公开 WebSocket 接口）而非 Azure SDK / 云服务 | 零成本、零密钥，中文女声质量高；无需新依赖，ws 直连 |
| 2026-08-16 | TTS 音色：VoiceConfig.id 抽象 ID（female_01 等）→ Edge TTS 音色映射表（SPEC §5.2）；tts 接口直接收 Edge 音色名 | Mac 本地 say 不可作生产方案（仅 macOS、音色少、不可部署），按用户决定直接用 Edge TTS |

---

## 六、阻塞项

无
