# AI 英语短视频内容生产平台

通过 AI、大模型、四六级词库、语音合成以及视频模板，将英语学习类短视频制作流程自动化，降低内容创作者制作成本。

## 项目定位

- **目标用户**：英语学习内容创作者
- **核心价值**：将选题、文案、词汇整理、配音、视频制作等重复工作流程化，提高视频生产效率
- **输出产物**：9:16（1080×1920）MP4 视频，可直接发布到抖音/快手/视频号

## 支持模板

| 模板 | 标识 | 说明 |
|------|------|------|
| 情景背词 | `scene_word` | 中英混合故事，重点词汇高亮 + 底部释义 |
| 单词卡片 | `word_card` | 单词、词性、释义、例句卡片式展示 |
| 选择题 | `quiz` | 题干 + 4 选项 + 答案解析 |

## 整体流程

```
用户输入（主题/模板/等级）
       │
       ▼
┌──────────────────────┐
│  Workflow A：内容生成  │  三个模板各一个 Workflow
│  AI 生成 → 词库校验    │  输出 partial_dto
└─────────┬────────────┘
          │
          ▼  （MVP 自动串联 / 后续可插入人工审核）
          │
┌──────────────────────┐
│  Workflow B：媒体生产  │  三个模板共用
│  TTS 配音 → 视频渲染   │  输出 final_dto
└─────────┬────────────┘
          │
          ▼
      完整的 ContentDTO + MP4
```

## 技术方案

| 层 | 选型 |
|----|------|
| 流程编排 | Dify（Workflow A × 3 + Workflow B） |
| 后端框架 | Hono + Zod + Drizzle ORM |
| 后端语言 | TypeScript (Node.js) |
| 数据库 | MySQL 8.0 |
| 前端框架 | Vue 3.5 + Composition API + `<script setup lang="ts">` |
| UI 组件 | shadcn-vue + Tailwind CSS 4 |
| 前端路由 | Vue Router 4 |
| 前端请求 | TanStack Vue Query + openapi-fetch（类型安全客户端） |
| 构建工具 | Vite 6 |
| API 文档 | Hono + Zod → 自动生成 OpenAPI 3.1 → Scalar 可视化 |
| 共享类型 | pnpm workspace `packages/shared`（前后端复用 ContentDTO 类型） |
| AI 模型 | GPT-4o / Claude 3.5 Sonnet（Structured Output） |
| TTS | 外部 TTS API 服务 |
| 视频渲染 | HTML 模板 + Playwright 截图 + FFmpeg 合成 |
| 测试框架 | Vitest 3（backend=node / frontend=jsdom） |
| 日志 | pino + pino-pretty |
| 限流 | hono-rate-limiter（按 IP） |
| CI/CD | GitHub Actions（typecheck + test + lint） |

## 项目结构

```
language-flow-ai/
├── tsconfig.base.json            # 根 TypeScript 配置基准
├── .gitignore
├── .env.example                  # 环境变量模板
├── .github/workflows/
│   └── ci.yml                    # CI 流程
│
├── packages/
│   ├── shared/                   ← 前后端 + Dify Code 节点共享
│   │   ├── tsconfig.json
│   │   ├── vitest.config.ts
│   │   └── src/
│   │       ├── index.ts          # 导出入口
│   │       ├── content.dto.ts    # ContentDTO, ContentArray, 所有子结构
│   │       ├── request.dto.ts    # CreateContentRequest, EditContentRequest
│   │       ├── response.dto.ts   # ContentListItem, ContentDetail, PaginatedResponse
│   │       └── enums.ts          # TemplateType, ContentStatus, CefrLevel
│   │
│   ├── backend/                  ← Hono + Drizzle + Zod
│   │   ├── tsconfig.json
│   │   ├── vitest.config.ts
│   │   ├── drizzle.config.ts     # Drizzle Kit 迁移配置
│   │   └── src/
│   │       ├── index.ts          # Hono app 入口（CORS / Rate Limit / 路由）
│   │       ├── lib/
│   │       │   └── logger.ts     # pino 结构化日志
│   │       ├── routes/
│   │       │   ├── health.ts     # GET /health 健康检查
│   │       │   ├── cet.ts        # /api/cet/validate-words, /api/cet/random-words
│   │       │   ├── tts.ts        # /api/tts/generate
│   │       │   └── video.ts      # /api/video/render
│   │       ├── services/
│   │       │   ├── cet.service.ts
│   │       │   ├── tts.service.ts
│   │       │   └── video.service.ts
│   │       ├── renderer/         # 模板渲染器（Playwright + HTML 模板）
│   │       │   ├── renderer.interface.ts
│   │       │   ├── scene-word.renderer.ts
│   │       │   ├── word-card.renderer.ts
│   │       │   └── quiz.renderer.ts
│   │       ├── db/
│   │       │   ├── schema.ts     # Drizzle ORM 表定义
│   │       │   └── index.ts      # 数据库连接
│   │       └── openapi.json      # 自动生成的 OpenAPI 3.1 规范
│   │
│   └── frontend/                 ← Vue 3.5 + shadcn-vue + Vite
│       ├── tsconfig.json
│       ├── vitest.config.ts
│       ├── env.d.ts              # Vue SFC + Vite 类型声明
│       └── src/
│           ├── api/
│           │   ├── client.ts     # openapi-fetch 类型安全客户端
│           │   └── schema.d.ts   # openapi-typescript 自动生成
│           ├── pages/
│           │   ├── CreateTask.vue
│           │   ├── TaskList.vue
│           │   └── TaskDetail.vue
│           ├── components/
│           │   └── ui/           # shadcn-vue 组件
│           └── router.ts

dify/
├── content_generation/
│   ├── scene_word.yml           # Workflow A1：情景背词
│   ├── word_card.yml            # Workflow A2：单词卡片
│   └── quiz.yml                 # Workflow A3：选择题
└── media_production/
    └── media_production.yml     # Workflow B：TTS + 视频渲染（三模板共用）

docs/                            ← 设计文档
├── 01_项目概述文档.txt
├── 02_MVP需求文档.txt
├── 03_系统模块设计文档.txt
├── 04_Content_DTO设计文档.txt
├── 05_Dify_Workflow设计文档.txt
├── 06_视频生产SOP文档.txt
├── 07_后续扩展规划文档.txt
└── 情景词汇阅读视频模板设计规范 V1.0.txt
```

## ContentDTO 核心字段

```typescript
interface ContentDTO {
  id: string;                    // cnt_YYYYMMDD_XXXXXX（6位hex）
  template: TemplateType;        // "scene_word" | "word_card" | "quiz"
  title: string;
  level: CefrLevel;              // "CET4" | "CET6"
  targetDuration: number;        // 目标视频时长（秒）
  content: ContentArray;         // discriminated union，依 template 而定
  words: WordInfo[];             // 去重后的词汇汇总
  style: StyleConfig;            // 视觉样式（背景/字体/BGM）
  voice: VoiceConfig;            // 音色配置
  audio?: AudioInfo;             // TTS 后填充
  video?: VideoInfo;             // 渲染后填充
  status: ContentStatus;         // 8 个状态：draft → … → completed
  createdAt: string;             // ISO 8601 UTC
  updatedAt: string;
}
```

完整定义见 [`04_Content_DTO设计文档.txt`](./docs/04_Content_DTO设计文档.txt)。

## MVP 范围

### 实现
- ✅ 三种视频模板（静态图片 + 文本 + 高亮 + 配音 + BGM）
- ✅ AI 文本生成（通过 LLM）
- ✅ 四六级词汇校验（通过独立词库 API）
- ✅ AI 配音（TTS）
- ✅ 视频合成（FFmpeg）

### 暂不实现
- ❌ 用户系统
- ❌ 视频动画
- ❌ 自动发布抖音
- ❌ 数据分析
- ❌ 多人协作

## 文档索引

| 文档 | 内容 |
|------|------|
| [`01_项目概述文档.txt`](./docs/01_项目概述文档.txt) | 项目定位、核心流程、发展方向 |
| [`02_MVP需求文档.txt`](./docs/02_MVP需求文档.txt) | MVP 功能需求与成功标准 |
| [`03_系统模块设计文档.txt`](./docs/03_系统模块设计文档.txt) | 模块划分 |
| [`04_Content_DTO设计文档.txt`](./docs/04_Content_DTO设计文档.txt) | 统一数据结构定义（What） |
| [`05_Dify_Workflow设计文档.txt`](./docs/05_Dify_Workflow设计文档.txt) | Workflow 节点设计（How） |
| [`06_视频生产SOP文档.txt`](./docs/06_视频生产SOP文档.txt) | 选题→生成→审核→制作→发布 SOP |
| [`07_后续扩展规划文档.txt`](./docs/07_后续扩展规划文档.txt) | 批量生产、数据分析、平台化 |
| [`情景词汇阅读视频模板设计规范 V1.0.txt`](./docs/情景词汇阅读视频模板设计规范%20V1.0.txt) | scene_word 模板视觉/内容规范 |

## 快速开始

1. 克隆项目
   ```bash
   git clone git@github.com:your-org/language-flow-ai.git
   cd language-flow-ai
   ```
2. 安装依赖
   ```bash
   pnpm install
   ```
3. 启动数据库（MySQL 8.0）
   ```bash
   docker compose up -d
   ```
4. 配置环境变量
   ```bash
   cp .env.example .env
   # 按需编辑 .env 中的 API Key 等配置
   ```
5. 启动开发服务器
   ```bash
   pnpm dev
   # 后端 http://localhost:3000
   # 前端 http://localhost:5173
   ```
6. （后续）生成 API 客户端类型
   ```bash
   pnpm --filter frontend gen-api     # 从 openapi.json 生成 schema.d.ts
   ```
7. （后续）在 Dify 中导入 `dify/` 下的 Workflow YAML，配置 LLM 节点（详见 [SPEC.md](./SPEC.md)）

## 开发规范

### 项目治理文件

| 文件 | 作用 |
|------|------|
| [`AGENTS.md`](./AGENTS.md) | AI 辅助开发行为约束（自动加载） |
| [`PROGRESS.md`](./PROGRESS.md) | 项目进度地图 + 任务清单 |
| [`biome.json`](./biome.json) | 代码格式 + Lint 规则（替代 ESLint + Prettier） |
| [`lefthook.yml`](./lefthook.yml) | Git hooks 自动化（pre-commit/commit-msg/pre-push） |
| [`commitlint.config.js`](./commitlint.config.js) | Commit 信息格式校验 |

### Git 自动化流程

```
git commit
  └→ pre-commit:  Biome format + lint（< 1s，仅 staged files）
       └→ commit-msg: commitlint 格式校验
            └→ commit 成功

git push
  └→ pre-push:  pnpm -r typecheck + pnpm -r test
       └→ 全部通过 → push 成功
```

### Commit 格式

```
type(scope): 中文描述

type  — feat / fix / refactor / docs / test / chore / style
scope — shared / backend / frontend / dify / docs
```

示例：`feat(backend): 实现 /api/cet/random-words 接口`

### 分支策略

```
main           ← 始终可运行，不允许直接 push
feature/*      ← 功能分支（如 feature/cet-api）
fix/*          ← 修 bug
```

开发流程：`main → feature/xxx → PR → 自审 → squash merge → main`

## 新增模板

只需三步（详见 [04_Content_DTO设计文档.txt](./docs/04_Content_DTO设计文档.txt) 第十三节）：

1. 定义一个 ContentItem 子类型
2. 加入 `ContentArray` 联合类型和 `TemplateType`
3. 实现对应的 `TemplateRenderer`

核心 DTO 和 Workflow 逻辑不变。
