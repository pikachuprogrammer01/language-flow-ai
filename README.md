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
用户输入（主题/等级/音色）
       │
       ▼
┌──────────────────────────────┐
│  后端 API + 本地 LLM（Ollama） │
│  ① 内容生成：两阶段 + 代码注入  │
│     + 词库验收（自动落库记录）   │
│  ② TTS 配音（音色可选 + 试听）  │
│  ③ 视频渲染（Playwright+FFmpeg）│
└──────────────┬───────────────┘
               │
               ▼
        ContentDTO + MP4（生成记录可在平台管理）
```

## 技术方案

| 层 | 选型 |
|----|------|
| 流程编排 | 无（后端 service 直连本地 LLM：Ollama qwen2.5:7b，docs/14） |
| 后端框架 | Hono + Zod + Drizzle ORM |
| 后端语言 | TypeScript (Node.js) |
| 数据库 | MySQL 8.4（Docker Compose） |
| 前端框架 | Vue 3.5 + Composition API + `<script setup lang="ts">` |
| UI 组件 | shadcn-vue + Tailwind CSS 4 |
| 前端路由 | Vue Router 4 |
| 前端请求 | openapi-fetch（类型安全客户端；schema 由 openapi-typescript 生成） |
| 构建工具 | Vite 6 |
| API 文档 | Hono + Zod → 自动生成 OpenAPI 3.1 → Scalar 可视化 |
| 共享类型 | pnpm workspace `packages/shared`（前后端复用 ContentDTO 类型） |
| AI 模型 | Ollama 本地 qwen2.5:7b（纯离线；docs/14 / docs/15） |
| TTS | Edge TTS（微软公开 WebSocket 接口，零成本零密钥；音色映射见 SPEC §5.2） |
| 视频渲染 | HTML 模板 + Playwright 截图 + FFmpeg 合成（可选 BGM 混音） |
| 文件存储 | 本地 `uploads/{audio,video,bgm}`（生产可换对象存储，非当前默认） |
| 测试框架 | Vitest 3（backend=node / frontend=jsdom） |
| 日志 | pino + pino-pretty |
| 限流 | hono-rate-limiter（仅生产按 IP） |

## 项目结构

```
language-flow-ai/
├── tsconfig.base.json            # 根 TypeScript 配置基准
├── .gitignore
├── .env.example                  # 环境变量模板
│
├── packages/
│   ├── shared/                   ← 前后端共享
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
│   │       │   ├── health.ts     # GET /health ✅
│   │       │   ├── cet.ts        # validate-words / random-words ✅
│   │       │   ├── content.ts    # POST /api/content/generate ✅
│   │       │   ├── tts.ts        # generate / from-content / voices ✅
│   │       │   ├── video.ts      # POST /api/video/render ✅
│   │       │   ├── tasks.ts      # 生成记录 CRUD / 搜索 / 批量删除 ✅
│   │       │   ├── topics.ts     # POST /api/topics/suggest ✅
│   │       │   ├── file-manager.ts # 文件列表/删除/清理/reveal ✅
│   │       │   └── upload-marks.ts # 上传标记 CRUD + overview ✅
│   │       ├── services/
│   │       │   ├── cet.service.ts / llm.service.ts / content.service.ts ✅
│   │       │   ├── tts.service.ts ✅
│   │       │   └── video.service.ts ✅（帧合成 + 可选 BGM amix）
│   │       ├── renderer/         # 三模板 Playwright 渲染器 ✅
│   │       ├── db/               # schema + migrate + seed ✅
│   │       └── openapi.json      # 启动时生成；/doc Scalar ✅
│   │
│   └── frontend/                 ← Vue 3.5 + shadcn-vue + Vite
│       └── src/
│           ├── api/client.ts     # openapi-fetch ✅
│           ├── views/
│           │   ├── CreateTask.vue   # 新建：三模板+主题+音色+BGM ✅
│           │   ├── TaskList.vue     # 生成记录 ✅
│           │   ├── TaskDetail.vue   # 详情/编辑/重配音重渲染 ✅
│           │   ├── Files.vue        # 文件管理 ✅
│           │   ├── VideoList.vue    # 视频资产 ✅
│           │   ├── MarksList.vue    # 上传标记一览 ✅
│           │   └── AuditList.vue    # 审计管理 ✅
│           ├── App.vue / router.ts  # 导航：/ /tasks /files /videos /marks /audit

docs/                            ← 设计文档（01–15 + 模板规范）
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

### 已实现
- ✅ 三种视频模板（静态帧 + 文本高亮 + 配音；可选 BGM 混音，默认钢琴曲）
- ✅ AI 内容生成（Ollama 本地；scene_word V4 两段式 + 代码注入，验收 ≥8 词）
- ✅ 四六级词库校验与随机抽词
- ✅ 配音可选（多音色 + 语速 + 试听）+ 主题预设 / AI 推荐
- ✅ 生成记录 / 视频资产 / 文件管理 / 审计 / 上传标记一览
- ✅ 生成后编辑并重新配音、重新渲染
- ✅ Docker Compose（mysql + backend + frontend）

### 暂不实现 / 后续
- ❌ 正式「待审核 → 通过」状态机（当前为生成后直接可编辑定稿）
- ❌ 用户系统 / 视频动画 / 自动发布 / 数据分析 / 多人协作
- ❌ 批量多主题生产、词汇运营看板、对象存储（S3）默认化
- ❌ 背景图预设库（当前固定纯白）

## 文档索引

| 文档 | 内容 |
|------|------|
| [`01_项目概述文档.txt`](./docs/01_项目概述文档.txt) | 项目定位、核心流程、发展方向 |
| [`02_MVP需求文档.txt`](./docs/02_MVP需求文档.txt) | MVP 功能需求与成功标准 |
| [`03_系统模块设计文档.txt`](./docs/03_系统模块设计文档.txt) | 模块划分 |
| [`04_Content_DTO设计文档.txt`](./docs/04_Content_DTO设计文档.txt) | 统一数据结构定义（What） |
| [`05_Dify_Workflow设计文档.txt`](./docs/05_Dify_Workflow设计文档.txt) | Workflow 节点设计（原，已废弃，由 docs/15 取代） |
| [`06_视频生产SOP文档.txt`](./docs/06_视频生产SOP文档.txt) | 选题→生成→审核→制作→发布 SOP |
| [`07_后续扩展规划文档.txt`](./docs/07_后续扩展规划文档.txt) | 批量生产、数据分析、平台化 |
| [`情景词汇阅读视频模板设计规范 V1.0.txt`](./docs/情景词汇阅读视频模板设计规范%20V1.0.txt) | scene_word 模板视觉/内容规范 |
| [`四级词汇情景记忆卡片设计方案.md`](./docs/四级词汇情景记忆卡片设计方案.md) | word_card 模板卡片设计方案 |
| [`08_TTS服务设计文档.md`](./docs/08_TTS服务设计文档.md) | Edge TTS 方案、音色映射、存储与错误处理 |
| [`09_词库数据方案.md`](./docs/09_词库数据方案.md) | cet_words 词库数据来源与 seed 方案 |
| [`10_视频渲染设计文档.md`](./docs/10_视频渲染设计文档.md) | renderer 接口、HTML 模板、Playwright + FFmpeg 管线 |
| [`11_前端页面设计文档.md`](./docs/11_前端页面设计文档.md) | 前端路由与页面规格 |
| [`12_部署与运行指南.md`](./docs/12_部署与运行指南.md) | 本地开发、数据库迁移、Docker / 生产部署 |
| [`14_模型层设计方案.md`](./docs/14_模型层设计方案.md) | Ollama 本地模型配置 |
| [`15_AI内容生成服务设计.md`](./docs/15_AI内容生成服务设计.md) | content/generate（V4 策略） |

## 快速开始

1. `pnpm install`
2. 配置 `packages/backend/.env`（`DATABASE_URL`、`LLM_*`）
3. **本地开发**（推荐日常）：`pnpm dev`  
   （自动：停 Docker 应用容器 → 校准 MySQL → 起前后端；http://localhost:5173）
4. **Docker 全栈**：`pnpm docker:up`（与本地互斥，脚本会先释放 8080/5173）
5. 切换回本地：`pnpm docker:stop` 后 `pnpm dev`（或直接 `pnpm dev`）

详见 [`docs/12_部署与运行指南.md`](./docs/12_部署与运行指南.md)。模式切换脚本：`scripts/stack.sh`。

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
scope — shared / backend / frontend / docs
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

## 版权与许可

本项目为**专有软件**，版权所有，保留一切权利。未经事先书面授权，不得使用、复制、修改或分发。详见仓库根目录 [LICENSE](./LICENSE)。

`package.json` 中 `"license": "UNLICENSED"` 与 `"private": true` 表示本仓库不是可自由使用的开源包。
