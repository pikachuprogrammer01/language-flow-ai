# LanguageFlow AI · AI 英语短视频内容生产平台

通过 AI、大模型、四六级词库、语音合成以及视频模板，将英语学习类短视频制作流程自动化，降低内容创作者制作成本。

## 项目定位

- **目标用户**：英语学习内容创作者
- **核心价值**：将选题、文案、词汇整理、配音、视频制作等重复工作流程化，提高视频生产效率
- **输出产物**：9:16（1080×1920）MP4 视频，可直接发布到抖音/快手/视频号

## 支持模板

| 模板 | 标识 | 说明 |
|------|------|------|
| 情景背词 | `scene_word` | 中英混合故事，重点词汇高亮 + 底部释义；可选 Three.js 主题片头（约 1s） |
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
│     scene_word 含 Three.js 片头 │
└──────────────┬───────────────┘
               │
               ▼
        ContentDTO + MP4（生成记录 / 视频发布管理可在平台维护）
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
| API 文档 | Hono + Zod → 自动生成 OpenAPI 3.1 → Swagger UI 可视化（自托管，`/doc/`）+ 覆盖度门禁 |
| 共享类型 | pnpm workspace `packages/shared`（前后端复用 ContentDTO 类型） |
| AI 模型 | Ollama 本地 qwen2.5:7b（纯离线；docs/14 / docs/15） |
| TTS | Edge TTS（微软公开 WebSocket 接口，零成本零密钥；音色映射见 SPEC §5.2） |
| 视频渲染 | HTML 模板 + Playwright 截图 + FFmpeg 合成（scene_word Three.js 主题片头，npm `three` + 构建期拷贝 vendor；可选 BGM 混音） |
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
│   │       │   ├── tasks.ts      # 生成记录 CRUD / 搜索 / 批量 / render-settings ✅
│   │       │   ├── topics.ts     # POST /api/topics/suggest ✅
│   │       │   ├── video-analytics.ts # 发布元数据 + 音色/BGM 白名单 ✅
│   │       │   ├── file-manager.ts # 文件列表/删除/清理/reveal ✅
│   │       │   └── upload-marks.ts # 上传标记 CRUD + overview ✅
│   │       ├── services/
│   │       │   ├── cet.service.ts / llm.service.ts / content.service.ts ✅
│   │       │   ├── tts.service.ts ✅
│   │       │   └── video.service.ts ✅（帧合成 + 可选 BGM amix）
│   │       ├── lib/              # logger / api-error / tts-catalog / intro-status ✅
│   │       ├── renderer/         # 三模板 Playwright 渲染器 + Three.js 片头截帧 ✅
│   │       ├── db/               # schema + migrate + seed ✅
│   │       └── openapi.json      # pnpm openapi:gen 生成；/doc JSON · /doc/ Swagger UI ✅
│   │
│   └── frontend/                 ← Vue 3.5 + shadcn-vue + Vite
│       └── src/
│           ├── api/client.ts     # openapi-fetch ✅
│           ├── views/
│           │   ├── CreateTask.vue   # 新建：三模板+主题+音色+BGM+片头开关 ✅
│           │   ├── TaskList.vue     # 生成记录 ✅
│           │   ├── TaskDetail.vue   # 详情/编辑/重配音重渲染/片头开关 ✅
│           │   ├── Files.vue        # 文件管理 ✅
│           │   ├── VideoList.vue    # 视频资产 ✅
│           │   ├── MarksList.vue    # 上传标记一览 ✅
│           │   ├── Analytics.vue    # 视频发布管理（发布元数据）✅
│           │   └── AuditList.vue    # 审计管理 ✅
│           ├── App.vue / router.ts  # 导航：/ /tasks /files /videos /marks /analytics /audit

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

> 片头相关可选子字段（不影响 14 个核心字段契约）：输入意图 `style.introEffect` / `style.introTopic`，输出事实 `video.introStatus`（`rendered | failed | disabled | unknown`，SPEC §3.4）。

## MVP 范围

### 已实现
- ✅ 三种视频模板（静态帧 + 文本高亮 + 配音；可选 BGM 混音，默认钢琴曲）
- ✅ scene_word Three.js 主题片头（本地 LLM 主题归类 + 配色，新建/详情页可开关；introStatus 落库留痕）
- ✅ AI 内容生成（Ollama 本地；scene_word V4 两段式 + 代码注入，验收 ≥8 词）
- ✅ 四六级词库校验与随机抽词
- ✅ 配音可选（多音色 + 语速 + 试听）+ 主题预设 / AI 推荐
- ✅ 生成记录 / 视频资产 / 文件管理 / 审计 / 上传标记一览
- ✅ 视频发布管理页（发布元数据：主题/时间/封面/自定义参数 + 音色/BGM 白名单单一写者）
- ✅ 生成后编辑并重新配音、重新渲染
- ✅ Docker Compose（mysql + backend + frontend）

### 暂不实现 / 后续
- ❌ 正式「待审核 → 通过」状态机（当前为生成后直接可编辑定稿）
- ❌ 用户系统 / 视频动画 / 自动发布 / 多人协作
- ❌ 平台数据回采（播放/完播率等；当前「视频发布管理」页仅维护发布元数据）
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
| [`13_背景音乐素材清单.md`](./docs/13_背景音乐素材清单.md) | BGM 素材来源与曲目清单 |
| [`14_模型层设计方案.md`](./docs/14_模型层设计方案.md) | Ollama 本地模型配置 |
| [`15_AI内容生成服务设计.md`](./docs/15_AI内容生成服务设计.md) | content/generate（V4 策略） |
| [`16_API接口规范与文档管理.md`](./docs/16_API接口规范与文档管理.md) | RESTful 统一规范、OpenAPI 自动生成、Swagger UI、覆盖度门禁 |

## 快速开始

1. `pnpm install`
2. 配置 `packages/backend/.env`（`DATABASE_URL`、`LLM_*`）
3. **本地开发**（推荐日常）：`pnpm dev`  
   （自动：拉起测试栈 MySQL → 生成 Three.js vendor → 起前后端；http://localhost:5173 · API :8080；数据源固定为测试库 :3307 + `~/language-flow-uploads-test`）
4. **Docker 测试栈**（跑当前工作树代码的全栈形态）：`pnpm docker:test` → http://localhost:5174
5. **生产栈（版本锁定）**：`pnpm docker:up` → http://localhost:15173  
   只跑 `deploy/prod.env` 里 `APP_VERSION` 指向的固定镜像（不构建、不拉取），与本地 dev / 测试栈端口不重叠，可并行常驻；
   版本变更只发生在 `pnpm docker:release`（构建并切到新 `v<git SHA>` tag），回滚用 `pnpm docker:rollback <tag>`，现状查看用 `pnpm docker:version`

### 三轨端口与地址总表

| 轨道 | 容器/进程 | 宿主端口 | 容器内端口 | 访问方式 |
|---|---|---|---|---|
| **Docker 测试栈**（`pnpm docker:test`，工作树代码） | `language-flow-test-frontend` | **5174**（0.0.0.0） | 80 | http://localhost:5174 |
| | `language-flow-test-backend` | 不映射 | 8080 | 经 test-frontend nginx 反代（`/api`、`/files`、`/health`） |
| | `language-flow-test-mysql` | **3307**（仅 127.0.0.1） | 3306 | `mysql://dev:dev@localhost:3307/language_flow` |
| **本地 dev**（`pnpm dev`，宿主机进程） | Vite 前端 | **5173** | — | http://localhost:5173 |
| | Hono 后端（tsx watch） | **8080** | — | http://localhost:8080（`/health`、`/doc`）；数据源固定测试库 :3307 + `~/language-flow-uploads-test` |
| **生产栈**（`pnpm docker:up`，`APP_VERSION` 锁定镜像） | `language-flow-frontend` | **15173**（仅 127.0.0.1） | 80 | http://localhost:15173 |
| | `language-flow-backend` | 不映射 | 8080 | 经 frontend nginx 反代 |
| | `language-flow-mysql` | **3306**（0.0.0.0） | 3306 | 生产库，dev/发布脚本默认不连（写需 `DB_ALLOW_PROD=1`） |

要点：三轨端口互不重叠可并行常驻；两个后端容器均**不映射宿主 8080**（避免与本地 dev 互踩，8080 专属 dev）；MySQL 的 `33060` 为 X Protocol 附带映射，日常用不到；Ollama 常驻宿主机 `11434`，三轨共用（容器栈经 `host.docker.internal` 访问）。

**⚠️ 访问不上 ≠ 故障：先分清常驻轨与临时轨**

| 轨道 | 生命周期 | 打不开时的判断 |
|---|---|---|
| 5174（测试栈）/ 15173（生产栈） | **常驻**：Docker 容器，`docker compose up` 后一直在线（重启机器后由 OrbStack/Docker 拉起或重跑对应命令） | 真异常：`docker ps` 看容器是否在跑；不在则 `pnpm docker:test` / `pnpm docker:up` |
| **5173 / 宿主 8080（本地 dev）** | **临时**：前台进程，仅 `pnpm dev` 运行期间存在，Ctrl+C / 终端关闭 / 验收完清理即停 | **正常现象**（ERR_CONNECTION_REFUSED 不代表服务坏了）：想用就重新 `pnpm dev`；不想跑就用常驻的 5174 看最新代码 |

一句话记法：**看当前最新代码用 5174（永远常驻）；5173 只有 dev 开着才在；15173 是旧版生产，不随工作树变。**

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
