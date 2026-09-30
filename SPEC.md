# AI 英语短视频内容生产平台 — 技术规格说明书（SPEC）

> 版本：V1.1
> 对应 PRD：V1.0
> 更新日期：2026-09-21（新增 §5.5 工作台聚合与 LLM 引擎状态端点）

---

## 一、文档目的

本文档是《PRD》的技术落地规格，定义系统各层的**接口契约、数据模型、节点逻辑、错误处理**，供开发人员直接按此实现。与项目其他文档的关系：

| 文档 | 角色 | 本文档定位 |
|------|------|------------|
| PRD | 定义做什么、为什么做 | — |
| **SPEC（本文档）** | **定义怎么做、接口长什么样** | ← 你在这里 |
| 04_Content_DTO设计文档 | 数据结构定义 | SPEC 引用其类型定义 |
| 05_Dify_Workflow设计文档.txt（废弃） | Workflow 节点设计（原） | 已由 docs/15 AI 内容生成服务 + 后端 API 取代 |

---

## 二、系统架构

### 2.1 架构图

```
┌──────────────────────────────────────────────────────────────┐
│                 后端 API + 本地 LLM（Ollama）                    │
│                                                               │
│  ① 内容生成服务（content.service）                              │
│     两阶段（主题词 → 故事）+ 代码注入英文词 + 词库验收 + 重试       │
│     LLM 直连（OpenAI 兼容），无 Dify（2026-08-17 架构变更）       │
│                     │                                          │
│                     │  自动落库（contents 表 = 生成记录）          │
│                     ▼                                          │
│  ② TTS 服务（音色可选 + 试听）→ ③ 视频渲染服务（Playwright+FFmpeg）│
│                                                               │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                      后端 API 服务                             │
│                                                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐    │
│  │ 四六级词库服务 │  │   TTS 服务    │  │  视频渲染服务      │    │
│  │              │  │              │  │                  │    │
│  │ validate     │  │ generate     │  │ render           │    │
│  │ random-words │  │              │  │                  │    │
│  └──────────────┘  └──────────────┘  └──────────────────┘    │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐    │
│  │                   数据存储层                            │    │
│  │   contents 表（生成记录 + ContentDTO JSON）              │    │
│  │   四六级词库（cet_words 表）                            │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 技术选型

| 层 | 选型 | 说明 |
|----|------|------|
| 流程编排 | 无（后端 service 直连 LLM） | 内容生成：llm.service 调 OpenAI 兼容 API（Ollama 本地，docs/14）；三模板（scene_word/word_card/quiz）生成器 + 审计档案 |
| 后端语言 | TypeScript (Node.js) | 后端 API 服务统一语言 |
| 后端框架 | Hono | 轻量 TS-first Web 框架，原生 Zod 集成，Edge-ready |
| 数据校验 | Zod | 运行时类型校验，与 Hono zValidator 中间件配合 |
| 数据库 ORM | Drizzle ORM | TS 结构映射 DDL，零代码生成，类型自动推导 |
| 数据库 | MySQL 8.4 | 词库表 + contents 表，JSON 列支持 |
| 前端框架 | Vue 3.5 + Composition API | `<script setup lang="ts">` 语法，与后端共享 TS 类型 |
| UI 组件库 | shadcn-vue（reka-ui 底座） | Vue 版 shadcn/ui，reka-ui（Radix Vue 官方后继）无头底座，源码归己；提示类（toast/确认框）统一基于 reka-ui + lucide 封装 |
| 前端样式 | Tailwind CSS 4 | 原子化 CSS，与 shadcn-vue 原生配合 |
| 前端路由 | Vue Router 4 | CSR 多页面路由：新建视频 / 生成记录 / 文件管理 / 视频资产 / 审计管理 |
| 前端请求 | openapi-fetch | 从 OpenAPI 生成类型安全客户端（Vue Query 已装未全面使用） |
| 前端构建 | Vite 6 | 原生 TS 支持，HMR 秒级 |
| API 文档 | @hono/zod-openapi + Scalar | 从 Hono 路由 + Zod schema 自动生成 OpenAPI 3.1 规范 |
| API 客户端 | openapi-typescript + openapi-fetch | 从 OpenAPI spec 自动生成类型安全的前端请求客户端 |
| 共享类型 | pnpm workspace shared 包 | ContentDTO 类型一次定义，前后端复用 |
| AI 模型 | Ollama qwen2.5:7b（本地） | 纯本地推理（用户决策 2026-08-17）；三模板生成均走 LLM，词汇准确性由词库决定 |
| 视频渲染 | HTML + Playwright + FFmpeg | 模板渲染 → 截图 → 合成；scene_word 可选 Three.js 主题片头（约 1s，npm `three` + 构建期拷贝 vendor）；可选 BGM 混音 |
| 文件存储 | 本地 uploads/（开发与默认部署） | `uploads/{audio,video,bgm}`；生产可换 S3 兼容存储（非当前默认） |
| 测试框架 | Vitest 3 | backend 用 node 环境，frontend 用 jsdom |
| 日志 | pino + pino-pretty | 结构化日志，开发环境彩色输出 |
| 限流 | hono-rate-limiter | 仅生产按 IP 限流，无需 Redis |

### 2.3 API 接口管理方案

前后端类型同步链路：

```
后端 Zod Schema ──→ Hono 路由 ──→ @hono/zod-openapi ──→ OpenAPI 3.1 规范
                                                              │
                                    ┌─────────────────────────┘
                                    ▼
                          openapi-typescript 生成 TS 类型
                                    │
                                    ▼
                      前端 Vue 页面 ──→ openapi-fetch 类型安全调用
```

具体步骤：

1. **后端**：用 `@hono/zod-openapi` 定义路由，Zod schema 自动映射为 OpenAPI schema
2. **生成规范**：`pnpm openapi:gen` 导出 OpenAPI 3.1 JSON（`packages/backend/src/openapi.json`，受版本控制）
3. **生成客户端类型**：`npx openapi-typescript openapi.json -o src/api/schema.d.ts`（`pnpm --filter frontend gen-api`）
4. **前端调用**：用 `openapi-fetch` 创建类型安全的请求客户端，所有 API 调用的请求体和响应体自动获得 TS 类型
5. **覆盖度门禁**：`pnpm openapi:check`（`routes/openapi-coverage.test.ts`）校验代码端点与文档双向一致、命名/状态码/错误格式合规

示例——前端调词库抽取接口，编译期就校验参数：

```typescript
// src/api/client.ts — 自动生成的类型安全客户端
import createClient from "openapi-fetch";
import type { paths } from "./schema"; // ← openapi-typescript 生成

const client = createClient<paths>({ baseUrl: "https://api.example.com" });

// 使用时：参数、响应全部有类型提示和校验
const { data, error } = await client.POST("/api/cet/random-words", {
  body: { level: "CET4", count: 10 },   // ← 类型错误直接爆红
});
// data.words 自动推导为 Array<{ word: string; level: string; meaning: string }>
```

这套方案的好处：
- 后端改一个接口参数 → 重新生成 `schema.d.ts` → 前端编译报错，零时差发现不一致
- 不需要手动在前后端之间复制粘贴类型定义
- OpenAPI 规范文件可直接导入 Swagger UI 做可视化的 API 文档浏览和调试（见下方 2.3.1）

### 2.3.1 API 文档可视化

采用 **Swagger UI（自托管，离线可用）** 作为文档前端展示层（完整规范见 docs/16）：

| 路由 | 内容 |
|------|------|
| `GET /doc` | OpenAPI 3.1 JSON（`app.doc`，与代码实时同步） |
| `GET /doc/` | Swagger UI 浏览/调试页（右上角「返回管理界面」导航） |
| `GET /swagger-ui/*` | 本地 `swagger-ui-dist` 静态资源 |

本地预览：`pnpm docs`（= backend dev）→ http://localhost:8080/doc/。生产经 nginx `/doc` 反代同源。
> 为何自托管而非 CDN：项目本地/离线优先，Docker 运行时无外网保证。`openapi.json` 由 lefthook pre-commit 在 backend 源码变更时自动重生成并补 stage，无需手动维护。

### 2.4 完整技术栈

---

> **TTS 引擎（2026-08-18）**：音色按 id 自动分发——Edge TTS（8 音色，默认）或 Mac 本地 say（Tingting/Sinji/Meijia，离线稳定）；语速倍率 rate（0.5-2，SSML prosody / say -r）；Edge 合成失败自动重试 1 次。

## 三、枚举与类型定义

以下为 SPEC 层面的类型表格（完整 TypeScript 定义见 `04_Content_DTO设计文档.txt`）。

### 3.1 模板类型

```typescript
type TemplateType = "scene_word" | "word_card" | "quiz";
```

### 3.2 内容状态

```typescript
type ContentStatus =
  | "draft"
  | "ai_generating"
  | "content_ready"
  | "tts_processing"
  | "audio_ready"
  | "video_rendering"
  | "completed"
  | "failed";
```

**状态流转规则**（仅允许以下状态变更）：

```
draft          → ai_generating
ai_generating  → content_ready | failed
content_ready  → tts_processing
tts_processing → audio_ready | failed
audio_ready    → video_rendering
video_rendering → completed | failed
```

`failed` 为终态，不允许从 failed 恢复（MVP 阶段）。

### 3.3 四六级等级

```typescript
type CefrLevel = "CET4" | "CET6";
```

### 3.4 片头渲染结果状态（IntroStatus，scene_word 专属）

```typescript
// rendered: 片头已生成 · failed: 生成失败已跳过 · disabled: 用户关闭 · unknown: 旧记录缺省
type IntroStatus = "rendered" | "failed" | "disabled" | "unknown";
```

> 输出事实（由渲染器产出，随 `contents.video` JSON 落库），与输入意图 `style.introEffect` 区分。
> shared 包为纯源码类型包不导出运行时值；运行时校验元组见 `backend/src/lib/intro-status.ts`。

---

## 四、ContentDTO 完整定义

### 4.1 子结构

```typescript
// ── 词汇信息 ──
interface WordInfo {
  word: string;            // 英文单词
  meaning: string;         // 中文释义
  level: CefrLevel;        // 四六级等级
  wordIndex?: number;      // 在 text 中的词序号（0-based），scene_word 专用
  frequency?: number;      // 词频
}

// ── 音色配置 ──
interface VoiceConfig {
  id: string;              // 业务音色 ID（如 "female_01" / "male_01"），到 Edge TTS 音色的映射见 §5.2
  speed?: number;          // 语速 0.5~2.0，默认 1.0
}

// ── 视觉样式 ──
interface StyleConfig {
  /**
   * 背景。当前阶段统一使用纯白背景，固定值 "white"；
   * 后续如需多套视觉，再扩展为预设背景图枚举。
   */
  background: string;
  font?: string;           // 字体
  colorScheme?: string;    // 配色方案
  bgm?: string;            // 背景音乐曲目 ID
  /** scene_word 片头 Three.js 动效，默认 true；false 跳过 */
  introEffect?: boolean;
  /** 片头配色用主题文案（生成 topic）；缺省用 title */
  introTopic?: string;
}

// ── 媒体产物 ──
interface AudioInfo {
  url: string;             // 音频文件地址
  duration: number;        // 时长（秒）
  format: string;          // "mp3" | "wav"
}

interface VideoInfo {
  url: string;             // 视频文件地址
  duration: number;        // 时长（秒）
  resolution: string;      // 分辨率，"1080x1920"
  format: string;          // "mp4"
  size?: number;           // 文件大小（bytes）
  introStatus?: IntroStatus; // scene_word 片头渲染结果（§3.4；旧记录缺省视为 unknown）
}
```

### 4.2 模板差异化内容

```typescript
// ── scene_word ──
interface SceneWordSegment {
  text: string;            // 中英混合文本片段
  words: WordInfo[];       // 本片段包含的四六级词汇
}

// ── word_card ──
interface WordCardItem {
  word: string;            // 英文单词
  pos: string;             // 词性
  meaning: string;         // 中文释义
  example: string;         // 例句
  exampleMeaning?: string; // 例句翻译
  imageUrl?: string;       // 配图地址
}

// ── quiz ──
interface QuizItem {
  stem: string;            // 题干
  options: string[];       // 4 个选项
  correctIndex: number;    // 正确答案索引（0-based）
  explanation: string;     // 解析
  word: WordInfo;          // 对应词汇
}

// ── 联合类型 ──
type ContentArray =
  | SceneWordSegment[]
  | WordCardItem[]
  | QuizItem[];
```

### 4.3 ContentDTO

```typescript
interface ContentDTO {
  id: string;                    // cnt_YYYYMMDD_XXXXXX
  template: TemplateType;
  title: string;
  level: CefrLevel;
  targetDuration: number;
  content: ContentArray;
  words: WordInfo[];
  style: StyleConfig;
  voice: VoiceConfig;
  audio?: AudioInfo;
  video?: VideoInfo;
  status: ContentStatus;
  createdAt: string;             // ISO 8601 UTC
  updatedAt: string;             // ISO 8601 UTC
}
```

### 4.4 ID 生成规则

```
格式: cnt_YYYYMMDD_XXXXXX

YYYYMMDD: UTC 日期，如 20260728
XXXXXX:   6 位十六进制随机数（小写），如 a1b2c3

TypeScript 生成代码:
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const hexId = Math.random().toString(16).slice(2, 8);
  const id = `cnt_${dateStr}_${hexId}`;
```

### 4.5 命名规范

| 规范 | 要求 | 示例 |
|------|------|------|
| 字段命名 | camelCase | targetDuration |
| 枚举值 | snake_case 字符串 | scene_word, audio_ready |
| 时间格式 | ISO 8601 UTC | 2026-07-28T10:30:00Z |
| ID 前缀 | cnt_ | cnt_20260728_a1b2c3 |

---

## 五、API 接口契约

前端将调用以下后端 API。所有接口的 Content-Type 为 `application/json`。

### 5.1 四六级词库服务

#### 5.1.1 验证候选词

```
POST /api/cet/validate-words
```

**请求体**：

```typescript
{
  words: string[];       // 候选英文单词列表，如 ["contract","continent","consult"]
  level: CefrLevel;      // 目标等级，"CET4" | "CET6"
}
```

**响应体**：

```typescript
{
  matchedWords: Array<{
    word: string;
    level: CefrLevel;
    meaning: string;
    frequency?: number;
  }>;
  unmatchedWords: string[];  // 未在词库中匹配到的单词
}
```

**响应示例**：

```json
{
  "matchedWords": [
    { "word": "contract", "level": "CET4", "meaning": "合同", "frequency": 0.85 },
    { "word": "continent", "level": "CET4", "meaning": "大陆", "frequency": 0.72 }
  ],
  "unmatchedWords": ["consultation"]
}
```

**错误码**：

| 状态码 | 情况 |
|--------|------|
| 200 | 正常（即使全部 unmatched 也返回 200） |
| 400 | words 为空或格式错误 |
| 500 | 服务器内部错误 |

#### 5.1.2 随机抽取词汇

```
POST /api/cet/random-words
```

**请求体**：

```typescript
{
  level: CefrLevel;
  count: number;         // 1~15
}
```

**响应体**：

```typescript
{
  words: Array<{
    word: string;
    level: CefrLevel;
    meaning: string;
    frequency?: number;
  }>;
}
```

**错误码**：

| 状态码 | 情况 |
|--------|------|
| 200 | 正常（返回数量可能少于 count，如果词库不足） |
| 400 | count 不在有效范围 |
| 500 | 服务器内部错误 |

### 5.2 TTS 服务

TTS 提供两个端点：`generate`（底层，已发布契约）与 `from-content`（ContentArray 拼接合成，场景内容用）。
`GET /api/tts/voices` 返回混合音色列表（Edge 8 + Mac 本地 3：婷婷/阿欣/美佳）与默认音色；词性缩写不朗读（释义前缀剥离，2026-08-18 用户确认）。

#### 5.2.1 POST /api/tts/generate — 底层文本合成

**请求体**（已发布契约，保持兼容）：

```typescript
{
  text: string;            // 待朗读的纯文本（1~2000 字符，2026-08-18 中文朗读内容变长后上调）
  voice: string;           // 音色名（Edge 8 + Mac 本地 3 混合列表），默认 "zh-CN-XiaoxiaoNeural"
  rate: number;            // 语速倍率 0.5~2（可选，默认 1；Edge SSML prosody / Mac say -r）
}
```

**响应体**：

```typescript
{
  success: true;
  filename: string;        // 文件名（UUID.mp3）
  url: string;             // 音频文件 URL，如 /files/audio/xxx.mp3
}
```

#### 5.2.2 POST /api/tts/from-content — ContentArray 拼接合成（场景内容配音入口）

**请求体**：

```typescript
{
  content: ContentArray;   // 同 ContentDTO.content
  template: TemplateType;  // scene_word | word_card | quiz，决定拼接方式
  voice: string;           // 音色名（Edge 8 + Mac 3 混合，按 id 自动分发引擎），默认 "zh-CN-XiaoxiaoNeural"
  rate: number;            // 语速倍率 0.5~2（可选，默认 1）
}
```

**响应体**：

```typescript
{
  audio: {
    url: string;             // 音频文件 URL，如 /files/audio/xxx.mp3
    duration: number;        // 时长（秒，ffprobe 探测）
    format: string;          // "mp3"
  };
}
```

**TTS 文本拼接规则**（后端 service 实现，见 08_TTS服务设计文档.md §七）：

| template | 拼接方式 |
|----------|----------|
| scene_word | 各 `segment.text` 连接，**text 中英文词原位替换为中文释义**（全中文朗读，用户确认 2026-08-17），空段跳过 | "Leo接到一份合同，任务是前往…。" |
| word_card | 拼接 "word. pos. example." → "elaborate. adj. She made elaborate preparations for the party." |
| quiz | 拼接 "stem. A. options[0]. B. options[1]. C. options[2]. D. options[3]." |

**音色映射表**（业务抽象 ID → Edge TTS 音色）：

| VoiceConfig.id | Edge TTS 音色 | 说明 |
|----------------|---------------|------|
| female_01 | zh-CN-XiaoxiaoNeural | 晓晓，默认女声 |
| male_01 | zh-CN-YunxiNeural | 云希，男声 |
| female_02 | zh-CN-XiaoyiNeural | 晓伊，女声 |
| male_02 | zh-CN-YunjianNeural | 云健，男声 |

> 调用方（前端）在调用 TTS 端点前，将 VoiceConfig.id 按上表转换为 Edge TTS 音色名。
> 后端默认值 zh-CN-XiaoxiaoNeural 与 female_01 对应。
> 完整音色列表见 08_TTS服务设计文档.md。

**错误码**（两个端点通用）：

| 状态码 | 情况 |
|--------|------|
| 200 | 正常 |
| 400 | generate：text 为空/超长（>500 字符），或 voice 非字符串；from-content：content 为空/拼不出朗读文本/拼接文本超 500 字符，或 template 非法 |
| 500 | TTS 引擎错误 |

> 注：后端不校验 voice 是否为合法 Edge 音色名（仅校验类型），
> 非法音色名由 Edge TTS 服务端拒绝时返回 500。

### 5.3 视频渲染服务

```
POST /api/video/render
```

**请求体**：完整的 ContentDTO（含 audio 字段，即渲染入参）。

```typescript
// 完整的 ContentDTO
```

**响应体**：

```typescript
{
  video: {
    url: string;             // 视频文件 URL
    duration: number;        // 时长（秒）
    resolution: string;      // 分辨率，"1080x1920"
    format: string;          // "mp4"
    size?: number;           // 文件大小（bytes）
  };
}
```

**渲染流程**（后端内部实现）：

```
1. 根据 ContentDTO.template 选择对应的 HTML 模板
2. 注入 ContentDTO.content + ContentDTO.style 到 HTML 模板（背景当前为纯白 CSS，不做图片注入）
3. Playwright 打开 HTML，按 segments/items 逐帧截图（1080×1920）
4. FFmpeg 将图片帧 + ContentDTO.audio 合成 MP4；若 `style.bgm` 有值则循环混入 BGM（音量约 0.12，配音为主）
5. scene_word 且片头成功时：帧序列前含约 1s 主题化 Three.js 截帧，TTS 前垫等长静音
6. 写入本地 `uploads/video/`，经 `/files/video/:filename` 提供访问（非 CDN）
```

**错误码**：

| 状态码 | 情况 |
|--------|------|
| 200 | 正常 |
| 400 | ContentDTO 格式错误或缺少必要字段 |
| 500 | 渲染引擎错误 |

### 5.4 视频分析与渲染设置

视频分析配置与内容的 canonical 音色、BGM 配置通过以下接口管理：

```text
GET   /api/video-analytics?ids=id1,id2
GET   /api/video-analytics/:contentId
PATCH /api/video-analytics/:contentId
PATCH /api/tasks/:id/render-settings
```

批量查询最多接收 100 个内容 ID，并返回按请求顺序排列的分析配置。分析配置包含故事主题、发布时间、封面、保存权限、自定义参数、音色和 BGM；`allowSave` 对外始终为布尔值。

`PATCH /api/tasks/:id/render-settings` 只更新 `contents.style.introEffect`（事务内对 `contents` 行 `FOR UPDATE`，与下方 analytics 写者同锁），不改变已有任务 PATCH 契约，也不改变任务状态流转。

**配置所有权**（避免多入口歧义）：音色 / BGM 的 canonical 值由 `/api/video-analytics` 单一写者维护（`voice`/`bgm` 经 `lib/tts-catalog` 白名单校验，未知值以 `VOICE_NOT_ALLOWED`/`BGM_NOT_ALLOWED` 结构化 400 拒绝）；`introEffect`（输入意图）由 `render-settings` 维护。

**片头渲染结果**：`contents.video.introStatus` ∈ `rendered | failed | disabled | unknown`（`unknown` 为旧记录缺省），由渲染器产出、经任务 PATCH 的 `video` 对象回写，是输出事实（与 `style.introEffect` 输入意图区分）。对应前端页由“视频数据分析”更名为“视频发布管理”（API 路径 `/api/video-analytics` 与表名 `video_analytics` 保持契约不变）。

### 5.5 工作台聚合与 LLM 引擎状态（2026-09-21 新增）

```text
GET  /api/dashboard/summary
GET  /api/llm/status
GET  /api/llm/stream
POST /api/llm/wake
POST /api/llm/sleep
```

**`GET /api/dashboard/summary`** — 工作台实时聚合（前端 500ms 轮询，仅 Dashboard 组件存活期间）。响应：`today`/`yesterday`（按 `date(created_at)` 分组）、`pendingRender`（content_ready+audio_ready）、`ttsActive`（tts_processing）、`completedVideos`、`topTemplate {name,share}`、`failed`、`failureReasons[]`（从最近 20 条失败记录的 `contents.audit.process.attempts` 最后拒绝原因与 `video.introStatus=failed` 聚合，形如「片头生成失败 ×2」）、`pipeline {generating,validating,tts,rendering,publishable}`（可发布 = completed 且有成片且无任何 `upload_marks` 关联）、`recent[]`（最5条，含 `intro` 片头列）。实现在 `services/dashboard.service.ts`，六个子查询 `Promise.all` 并行。

**`GET /api/llm/status`** — LLM 引擎三级就绪探测（失败不抛异常，恒 200，状态是数据不是错误）：响应 `{ connected, model, installed?, loaded?, reason? }`。① 服务可达：OpenAI 兼容 `GET {LLM_BASE_URL}/models`（3s 超时）；② 模型已安装：列表内含 `LLM_MODEL`（`matchModelName` 精确或补 `:latest`）；③ 已加载进内存：Ollama 原生 `GET {host}/api/ps`（非 Ollama 端点 404 时 `loaded` 省略）。

**`GET /api/llm/stream`** — LLM 引擎状态 SSE 事件流（`text/event-stream`，替代前端定时轮询）。实现在 `services/llm-engine.ts`（状态机 + 事件发布单例）：连接即推当前 `EngineSnapshot` 快照，此后仅状态变化才推（`event: status`），25s 心跳 `event: ping` 防代理空闲断连；服务端仅在 ≥ 1 个订阅者时跑 30s 低频对账探测，无订阅者不起定时器。`EngineSnapshot = { phase, progress?, status, error?, notice? }`：`phase` ∈ `idle | starting | stopping`（过渡态，`progress` 为人话进度文案），`error` 为操作失败原因（红 toast）、`notice` 为非致命降级提示（黄 toast，如容器内无 brew 只能卸载模型）。客户端为 `EventSource`（自带断线退避重连），响应体携 `X-Accel-Buffering: no` 且 nginx 为 `/api/llm/stream` 单独关缓冲/长读超时。前端不支持 EventSource 时才回退 30s 低频探测。

**`POST /api/llm/wake`** — 一键启动引擎并加载模型（仅本机开发环境，顶栏「▶ 启动 {模型名}」按钮触发，`wakeEngine()` 接管）：即时返回当前 `LlmStatus`，后续全生命周期走 SSE——`phase=starting` → `brew services start ollama`（幂等、失败不阻断）→ 轮询 `/api/version` 等服务就绪（最多 10s）→ fire-and-forget `POST /api/generate {model, keep_alive:"1h"}` 触发冷加载 → 看门狗 4s 探测直至 `loaded` 或 5 分钟超时（成功转绿/超时或失联都回 `idle` 并广播 error）。过渡态重复调用幂等（不二次拉起）。云端 `LLM_BASE_URL`（非 localhost）直接回退探测不执行本地拉起。

**`POST /api/llm/sleep`** — 一键关闭（wake 的镜像操作，`sleepEngine()`）：即时返回后走 SSE `phase=stopping` → 本机端点（localhost / 127.0.0.1 / host.docker.internal）先 `POST {host}/api/generate {model, keep_alive:0}` 卸载模型，再 `brew services stop ollama`（幂等；容器内无 brew/非 brew 安装失败仅记 warn 不阻断）→ 回探一次。回探红灯=完全停止（成功终态），仍连但 `loaded=false`=只卸载未停服务（`notice` 降级提示），`loaded=true`=关闭失败（`error`）。前端仅在就绪/待机态露出关闭按钮，首次点击武装（确认关闭？，3s 无操作自动取消）防误触。

### 5.6 视频数据分析 API（Phase 1~4 + Phase 6 全链路，2026-09-24 新增；同日砍除 抖音开放平台通道并落地导入向导；2026-09-26 审查修正批次 1/3/5；2026-09-28 四步精准匹配导入上线替代旧逐行向导，现 33 路径 41 操作）

> 模块需求源与完整设计见 docs/17_视频数据分析模块设计.md；本节为契约摘要。实现在 `routes/analytics.ts`（批次 5C 已按领域拆分为 `routes/analytics/{records,import,features,dashboard,insights}.ts`，共用实例组合导出，对外路径/operationId 不变；服务 `analytics-metrics.service` / `analytics-feature.service`，领域目录 `lib/analytics-taxonomy.ts`）。

```text
GET    /api/analytics/publish-records                 发布记录列表（platform/contentId 过滤 + 分页）
POST   /api/analytics/publish-records                 创建发布记录（自动派生 video_asset_id 并触发生产特征落库）
PATCH  /api/analytics/publish-records/{recordId}      更新发布记录
DELETE /api/analytics/publish-records/{recordId}      删除发布记录（指标级联删除）
GET    /api/analytics/videos/{contentId}/metrics      单视频指标：最新值 + 每日快照（含 provenance 与 emptyReason）
POST   /api/analytics/import                          Creator Import（动态字段映射）
GET    /api/analytics/metric-catalog                  canonical 指标目录（availability 分级）
GET    /api/analytics/features/{contentId}            内容特征读取（即取即重算）
POST   /api/analytics/features/{contentId}/sync       生产特征重算（保留人工标签）
PATCH  /api/analytics/features/{contentId}            人工标签覆盖（taxonomy 校验，来源 USER_INPUT）
GET|POST /api/analytics/creator-daily                 账号每日聚合（(platform,date) 幂等 upsert；查询支持日期范围，含 5 个账号级漏斗/节奏列）
POST   /api/analytics/creator-daily/import            账号日汇总批量导入（动态列映射 + 逐行归属裁决：account 仅账号级 / video 近似归因落视频指标）
GET    /api/analytics/overview                        分析首页：视频观看漏斗（播放→2秒→5秒→完播→主页）+ 账号增长独立项（上一等长周期环比，Phase 2）
GET    /api/analytics/videos                          视频表现列表（排序白名单 play/completion/engagement/fans/publish_time，缺数据恒排末，Phase 2）
GET    /api/analytics/videos/{contentId}/benchmark    同类 Benchmark（账号自身分组：同模板×时长带×已标注场景/形态；lowSample 强制样本量提示，Phase 2）
GET    /api/analytics/videos/{contentId}/trend        每日快照趋势序列（不补 0、缺日无点，Phase 2）
GET    /api/analytics/factors                         内容因子分析（白名单指标×维度分组统计，中位数/均值/样本数，lowSample<8 强制标记；纯读不写库，批次 5B）
POST   /api/analytics/factors                         因子分析显式重算并留档 analysis_result 快照（批次 5B：留档不再藏在 GET 里）
GET    /api/analytics/videos/{contentId}/timeline     内容段落时间轴（片头事实 + 字符权重 allocateDurations 派生，非逐帧实测；未派生回 not_derived，Phase 3）
GET    /api/analytics/recommendations                 生产建议清单（每条必携理由/样本数/依据指标；含采纳汇总 total/pending/accepted/rejected/applied，Phase 4）
POST   /api/analytics/recommendations/generate        按最新数据重新生成建议（清待处理项重建；已采纳/已忽略历史保留，Phase 4）
PATCH  /api/analytics/recommendations/{recommendationId} 建议采纳/忽略与采纳后新建内容回写（accepted + appliedToContentId 效果回路，Phase 4）
GET    /api/analytics/videos/{contentId}/structure    可复用成功结构（从段落时间轴提取结构序列与时长占比，不复制内容，Phase 4）
GET    /api/analytics/experiments                     内容实验清单（含评估快照，Phase 6）
POST   /api/analytics/experiments                     创建实验（变量白名单 hook/template/duration/structure/prompt_version/cta/voice；两组非空不相交，Phase 6）
POST   /api/analytics/experiments/{experimentId}/evaluate 评估归档（A/B 描述统计：中位/差值/样本数/lowSample，小样本不下结论，Phase 6）
PATCH  /api/analytics/experiments/{experimentId}/status   状态流转（completed 仅由 evaluate 写入防手改结论，Phase 6）
```

> 抖音开放平台同步端点 `POST /api/analytics/sync` 已砍除（需企业资质，项目不具备，2026-09-24 用户决策）：外部绩效数据唯一入口 = `POST /api/analytics/import`；`source_type` 枚举收敛为五值，不保留 DOUYIN_* 死值。

**统一 ID 链路**：`content_id → publish_record（platform + platform_video_id 唯一）→ 指标`；创建发布记录要求内容存在（404），同平台重复绑定拒绝（409 `DUPLICATE_PLATFORM_VIDEO`；插入竞态撞唯一键同样回 409 不再是 500，2026-09-26 审查批次 3）；DELETE 发布记录对不存在的 recordId 回 404（不再假报删除成功）；导入匹配只允许 `recordId / platformVideoId / platform+contentId` 三种方式，禁止标题模糊匹配。

**Creator Import**（`POST /api/analytics/import`）：`sourceType` 白名单仅 `CREATOR_IMPORT | USER_INPUT`（导入伪装平台官方 API 被 zod 400 拒绝）；`metricMapping` 为外部列名→canonical 指标名的动态映射（列名不写死）；未映射/未知指标/派生指标/非法值逐行返回 `skipped {field, reason}` 不静默丢弃；部分成功语义（逐行 ok/error，不整单回滚），但**单行内原始写入+派生重算同一事务全有或全无**（重算失败不留半写，2026-09-26 审查批次 3）。导入后平台统一重算派生指标（`PLATFORM_CALCULATED`，缺输入的旧派生行同事务内删除不留陈旧值）；视频级 `new_fan_count` 自动标记 `isEstimated`（时间窗口归因，不得伪装精确归因）。前端入口：`/insights/data` 四步导入向导（①导入表格：xlsx 文件（SheetJS）或粘贴 TSV/CSV，表类型自动探测 ②字段映射 ③匹配确认 ④提交落库；解析/预匹配/匹配引擎纯函数 `lib/analytics-import.ts`）。

**账号日汇总导入**（`POST /api/analytics/creator-daily/import`，≤366 行）：每行由操作者裁决 `attribution`（discriminated union，白名单外 mode 400）：`account`=只写 creator_metric_daily；`video`=同时把可归属字段（play/like/comment/share/profile/newFans/bounce2s/watch5s/avgWatchTime）写 video_metrics，必携 `isEstimated=true` + `matched_by=operator_confirmed` 与长尾近似声明；postCount/coverClickRate/totalFans 账号级专属拒写视频指标（逐列回 reason）。(platform,stat_date) upsert 仅覆盖本次提供的列不清空存量。匹配引擎纪律（前端纯函数 `matchRowByDate`）：仅按年月日对齐（发布记录取 publishTime 日期回退 createdAt）；当日 1 条且条数设置=1 → unique 预选；多条 → ambiguous 必人工裁决（系统绝不拆数）；0 条 → none 默认仅账号级；未绑定作品 ID 的记录不参与自动匹配仅可人工指派；条数设置（默认 1）超出即提醒不阻断。

**指标真实性与 Empty State**：每个指标值必携 `sourceType / sourceField / dataDate / fetchedAt / isEstimated / confidence / metadata`；派生计算除零或缺输入→不落该指标（无数据 ≠ 0）；`videos/{id}/metrics` 的 `emptyReason` ∈ `not_published | not_imported | null`；`overview` 阶段级 `emptyReason`（not_imported / missing_rate_or_plays）+ 全局 `emptyReason`（no_records / no_metrics）。指标目录的 `availability` ∈ `AVAILABLE | IMPORT_ONLY | DERIVED | FUTURE`（CONDITIONAL 档已随抖音通道砍除；当前无已接入外部源，计数类/漏斗类均为 IMPORT_ONLY）。

**Phase 2 漏斗口径（2026-09-26 审查批次 1 升级：口径诚实，绝不截断伪装）**：阶段值 = 窗口内发布记录（有 publishTime 按发布时间，否则回退 createdAt）的 Σ播放 / Σ(播放×对应比例)；每阶段附**覆盖元数据** `coverageCount`（参与折算记录数，creator=导入天数）/ `windowRecordCount`（窗口记录总数）/ `basisPlays`（覆盖记录播放合计）。逐级转化 `stepRate` **仅在相邻阶段覆盖记录集一致且数值不倒挂时给出**（`stepRateState="computed"`）；否则置 null 并以枚举说明原因（`first / coverage-mismatch / inverted / missing / standalone`），前端对不可比阶段显示「—」+原因，**不得把百分比截断到 100% 掩盖口径错位**。`shareOfPlays` 分母改为本阶段覆盖播放（与分子同覆盖，杜绝混合覆盖低估）。「关注」= creator_metric_daily 同窗口日新增合计，**账号级独立指标不入观看漏斗链路**（stepRate/shareOfPlays 恒 null，前端独立分区展示）；环比对上一等长窗口同口径，无对比数据 changePct=null 呈现「—」。导入比例类指标无单调性承诺（如完播率可高于 5 秒观看率），倒挂一律走 `inverted` 提示。前端页面：`/insights`（页面 A）、`/insights/videos`（页面 B，排序表头为真 button + aria-sort、行标题真链接，审查批次 4A）、`/insights/videos/:id`（页面 C，生产参数×表现同屏 + 趋势 + 同类 Benchmark + 秒级留存不造假声明）。

**Phase 3 因子分析与时间轴（批次 5B 留档显式化）**：`/factors` 自发分组统计（model_version=group-stats-v1，不冒充模型）：目标指标白名单 10 项、维度白名单 15 项（hook/scene/内容形态/情绪/CTA/模板/等级/时长带/语速带/段落带/音色/BGM/字幕/Prompt 版本/发布时段），未标注入「未标注」桶不剔除样本，每组必携 sampleCount 且 <8 标 lowSample，响应 note 声明相关性非因果；**GET /factors 纯读（批次 5B 消除读副作用），留档只经 POST /factors（页面 D 显式「重算并留档」按钮），写失败报错不静默**。`/videos/{id}/timeline` 读 video_segment 表：段落时长由生产事实派生（scene_word 片头 rendered 占 0~1s + 各段按字符权重 allocateDurations，与渲染链路同源），无产物时长不派生（not_derived）；重建入口 = POST features/{id}/sync 与创建发布记录链路。

**看板查询下推（批次 5A）**：`/overview` 只装载 [上一窗口起点, 现在) coalesce(publish_time, created_at) 区间记录（UTC 字面量比较免会话时区漂移）；`/videos` 排序/分页/总数全部 SQL（指标排序经 (record,metric) 别名左连，`IS NULL` 前置位实现「缺数据恒排末」，同值按 created_at desc 决胜）；loadAllVideoRows 仅供确实需要全分组集的 benchmark/因子路径。

**Phase 4 优化闭环**：建议从因子分组派生（`analytics-recommend.service`）：仅样本 ≥8（MIN_GROUP_SAMPLES）的组出参数建议（§十四 小样本不下结论），无合格组只出 data_readiness 诚实建议；每条必携 reason/sourceSampleCount/sourceMetric/confidence（可解释，§十二）。采纳回路：前端「使用推荐参数创建」经 create-session prefill 单例预填 Create 流程（模板/主题/语速 + hook/scene 标签），生成成功后回写 recommendation.applied_to_content_id 并将标签写入新内容 content_features（USER_INPUT，进入下次同类分组）；「复用此视频结构」（页面 C）提取骨架预填（参考横幅展示占比，不假装生成器能按骨架执行）。实体现：recommendations（§八.8，migration 0009）。

**Phase 6 内容实验**：`experiments` 表（§八.9，migration 0010）= 一个变量 × 两变体（各挂 contentIds）+ 控制变量 + 目标指标；`POST /experiments/{id}/evaluate` 用发布指标做分组描述统计（model_version=ab-descriptive-v1）：任一组样本 <8 → lowSample 且 verdict 只给「不构成结论」；缺指标不补 0（无数据时 verdict=无法评估）；completed 仅由 evaluate 写入（状态 PATCH 拒绝手改结论态）；结论恒附相关≠因果声明。前端 `/insights/experiments`（登记表单两组内容多选 + 冲突即时拦截 + 评估卡片）。Phase 5（停留/完播/涨粉模型 + SHAP）按文档门槛在数据量达标后启动，不提前实现。

**数据源 Adapter**（需求 §二十三）：`AnalyticsDataProvider` 接口统一映射到平台 Domain Model，业务层不依赖抖音 Response DTO；`douyinOpenApiProvider` 为未接入占位（`isAvailable()=false`，sync 诚实返回 501 `DATA_SOURCE_NOT_CONFIGURED`）。

**四步精准匹配导入（2026-09-28，`routes/analytics/import-batches.ts`，11 路径 13 操作）**：平台导出数据（抖音/快手/视频号…）经中间层四表（import_batch/import_row/match_candidate/match_decision，migration 0008）与作品建立一一对应，「系统自动完成确定性匹配，用户只处理异常」。
- 端点：`POST/GET /import-batches`（创建即服务端字段识别 12 角色 + 粒度三态判定 work_level_strong/weak/account_day_level，判定依据可解释；同 file_hash 已提交 → 409 重复拦截）· `GET/DELETE /import-batches/{id}`（刷新恢复/未提交可删）· `POST .../confirm-granularity`（只允许降级，账号日级升格 400）· `PUT .../rules`（账号/平台映射、时区、发布时间容差、标题标准化 5 开关、相似度阈值 + dry-run 四类预估）· `POST .../prematch`（确定性引擎零 LLM；有人工裁决未 force → 409 needs_confirmation）· `GET .../rows`（分页/状态筛选/关键词）· `GET .../rows/{rowId}`（候选+结构化 evidence）· `POST .../decisions`（confirm/assign/ignore/external/account_day/reset 批量裁决；账号日级行 assign → 400 红线）· `POST .../preflight`（十项校验，③重复导入/④未处理冲突/⑨非法数值/⑩重复提交阻断）· `POST .../commit`（服务端重验 preflight 不过 409 携报告；单事务写 video_metrics/creator_metric_daily 复用单一口径，metadata.batch_id 溯源，commit_preimage 快照）· `POST .../rollback`（按 preimage 精确恢复，含派生行与每日快照）。
- 匹配优先级固定（`lib/import-matcher.ts` 纯函数）：作品 ID 精确 > URL 解析 ID > 账号+发布时间容差 > 账号+日+标题相似（编辑距离口径）> +时长辅助；强证据（方法1/2）单候选才 unique_match 可批量确认，弱证据单候选一律 conflict（已裁决）；未绑定作品 ID 的发布记录不参与自动匹配仅可人工绑定；每候选必存 evidence（禁裸置信度）。
- 前端 `/insights/import` 四步工作台（导入数据→匹配规则→匹配校验→提交落库）：统计卡筛选/批量操作/高密度表/右侧详情证据 checklist；旧逐行下拉框向导（analytics-import-wizard.vue）已删除，`/insights/data` 保留发布记录绑定 + 入口卡；`POST /import`、`POST /creator-daily/import` 后端端点保留（已发布契约）。

**错误信封**：非 2xx 统一 `{ error: { code, message, ... } }`（DX-1，lib/api-error）。

---

## 六、AI 内容生成服务（替代原 Dify Workflow A）

> 架构变更（2026-08-17，用户决策）：**去掉 Dify**，后端直连 LLM（OpenAI 兼容 API）。
> 完整设计见 docs/15_AI内容生成服务设计.md；原 Dify Workflow A 设计（§6.x 节点）已废弃，
> 由 POST /api/content/generate 取代。本节只保留契约摘要。

### 6.1 接口摘要

```
POST /api/content/generate
请求: { topic: string, level: "CET4"|"CET6", wordCount?: int(3~15), targetDuration?: int(15~300) }
响应: { content: ContentDTO }   // template=scene_word, status=content_ready
错误: 400 参数校验 / 503 LLM 未配置 / 500 LLM 失败或词汇校验无可用词
```

### 6.2 生成流程（后端 service，替代原 Workflow A1）

```
输入 {topic, level, wordCount, targetDuration}
  → llm.service.chatCompletion(prompt)   // 调用 LLM_BASE_URL/LLM_API_KEY/LLM_MODEL（OpenAI 兼容）
  → 解析 JSON { title, segments: [{text, words}] }
  → 词汇校验：cet.service.validateWords 过滤（词库命中为准，LLM 自造词丢弃）
  → 组装 ContentDTO（scene_word, status=content_ready）
  → 返回
```

### 6.3 模型切换

- Ollama 本地（qwen2.5:7b）通过环境变量 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 配置（docs/14），
  **代码零改动**（docs/14 §2）。
- Prompt 规范（主题式标题、中文故事嵌入英文词、JSON 输出格式）见 docs/15 §五。

### 6.4 原 Workflow A 设计

原 §6.1~§6.x 节点设计（llm_generate_story / code_extract_words / http_query_cet_db 等）
已废弃，保留于 docs/05_Dify_Workflow设计文档.txt（标注废弃，供参考）。

## 七、媒体生产链路（原 Dify Workflow B 已由后端 API 实现）

> 架构变更（2026-08-17）：原 Workflow B 的节点（http_tts / code_merge_audio /
> http_render_video / code_merge_video）**已全部由后端 API 实现**，无需 Dify：

| 原 Workflow B 节点 | 现实现 |
|---------------------|--------|
| http_tts（拼接 + 合成） | POST /api/tts/from-content（docs/08 §3.1） |
| code_merge_audio（audio 回填） | tts 响应直接返回 audio 元数据 |
| http_render_video | POST /api/video/render（docs/10） |
| code_merge_video（video 回填） | render 响应直接返回 video 元数据 |

- 调用链：`/api/content/generate → /api/tts/from-content → /api/video/render`（前端或脚本串联）
- 原 §7.1~§7.x 节点设计保留于 docs/05（标注废弃，供参考）

## 八、Request / Response DTO

### 8.1 输入（创建视频任务）

```typescript
// /api/content/generate 的 inputs 字段
interface CreateContentRequest {
  topic?: string;
  template: TemplateType;
  level: CefrLevel;
  wordCount?: number;        // 3~15，默认 10
  targetDuration?: number;   // 秒，默认 60/45/30
  voice?: VoiceConfig;
  style?: StyleConfig;
}
```

### 8.2 编辑内容

```typescript
interface EditContentRequest {
  title?: string;
  content?: ContentArray;
  words?: WordInfo[];
  voice?: VoiceConfig;
  style?: StyleConfig;
}
```

### 8.3 响应

#### 8.3.1 列表项

```typescript
interface ContentListItem {
  id: string;
  template: TemplateType;
  title: string;
  level: CefrLevel;
  targetDuration: number;
  wordCount: number;
  status: ContentStatus;
  thumbnailUrl?: string;
  createdAt: string;
}
```

#### 8.3.2 详情

```typescript
interface ContentDetail extends ContentListItem {
  content: ContentArray;
  words: WordInfo[];
  style: StyleConfig;
  voice: VoiceConfig;
  audio?: AudioInfo;
  video?: VideoInfo;
  updatedAt: string;
}
```

#### 8.3.3 分页

```typescript
interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
```

---

## 九、错误处理

### 9.1 LLM 节点异常

| 异常 | 处理 |
|------|------|
| JSON 输出格式不符合 schema | 解析失败记录原始输出，标记 failed（可重试 1 次） |
| LLM API 超时（>60s） | 标记 failed（可重试 1 次） |
| LLM 返回空内容 | 标记 failed，不确定状态传递 |

### 9.2 HTTP 节点异常

| 异常 | 处理 |
|------|------|
| 4xx | 记录日志，标记 failed |
| 5xx | 自动重试 1 次（间隔 3s）；仍失败则标记 failed |
| 超时（>60s） | 标记 failed |
| 词库返回空 matchedWords | 正常流程，继续处理（丢弃所有候选词） |

### 9.3 Code 节点异常

| 异常 | 处理 |
|------|------|
| 类型转换失败 | 捕获异常，标记 failed |
| 运行时异常（null access 等） | 同上 |

### 9.4 状态一致性

- 任何节点异常时，该 Workflow 产出的 DTO 的 status 必须为 `failed`
- 不允许出现半成品（如 TTS 成功但渲染失败时，不保留 audio_ready 状态，直接 failed）
- 将来如果需要断点续传，再引入中间态持久化

---

## 十、数据库设计建议

### 10.1 主表：contents

| 字段 | 类型 | 说明 |
|------|------|------|
| id | VARCHAR(32) PK | cnt_YYYYMMDD_XXXXXX |
| template | VARCHAR(32) | scene_word / word_card / quiz |
| title | VARCHAR(256) | 视频标题 |
| level | VARCHAR(8) | CET4 / CET6 |
| target_duration | INT | 目标时长（秒） |
| content | JSON | ContentArray（模板差异化内容） |
| words | JSON | WordInfo[]（去重词汇汇总） |
| style | JSON | StyleConfig |
| voice | JSON | VoiceConfig |
| audio | JSON NULL | AudioInfo |
| video | JSON NULL | VideoInfo |
| audit | JSON NULL | 生成审计档案（PRD 10.1.4）：input/候选词来源/重试历史/修改日志 |
| status | VARCHAR(32) | ContentStatus |
| created_at | DATETIME(3) | ISO 8601 UTC |
| updated_at | DATETIME(3) | ISO 8601 UTC |

### 10.2 词库表：cet_words

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INT PK AUTO_INCREMENT | 自增 |
| word | VARCHAR(100) NOT NULL | 英文单词（小写） |
| meaning | VARCHAR(500) NOT NULL | 中文释义 |
| level | ENUM('CET4','CET6') NOT NULL | 词汇等级 |
| frequency | FLOAT DEFAULT 0 | 词频（0~1） |

**索引**：`idx_level_freq(level, frequency)`

> **词库规模（2026-08-18）**：5999 词（CET4 4686 含高中基础词补齐 + CET6 1313 增量）；抽词池过滤功能词（art./prep./conj. 等词性前缀）且 frequency 全 0 时全表洗牌（不固定前 200）。
（实现以 `db/schema.ts` 为准，与 docs/09 一致）

### 10.3 上传标记表：upload_marks

| 字段 | 类型 | 说明 |
|------|------|------|
| id | VARCHAR(32) PK | 标记 ID |
| task_id | VARCHAR(32) NULL | 关联任务 id（按任务归属，重渲染不丢失；建索引） |
| video_filename | VARCHAR(100) NOT NULL | uploads/video/ 下的文件名（建索引） |
| platform | VARCHAR(50) NOT NULL | 上传平台（抖音/小红书/视频号/B站/快手/其他；varchar 不锁死枚举） |
| url | VARCHAR(500) NULL | 作品链接 |
| note | VARCHAR(500) NULL | 备注（预设文案 + 自定义） |
| created_at / updated_at | TIMESTAMP | 自动维护 |

### 10.4 视频发布元数据表：video_analytics

一条内容最多一份配置（migration 0004 建表，0005 补 FK 级联与 publish_at 改型）：

| 字段 | 类型 | 说明 |
|------|------|------|
| content_id | VARCHAR(32) PK | FK → contents.id，`ON DELETE CASCADE`（migration 0005） |
| story_topic | VARCHAR(255) NULL | 发布故事主题 |
| publish_at | DATETIME NULL | 计划发布时间（mode:"date"，免 timestamp 2038 上限与时区隐式转换） |
| cover_url | VARCHAR(500) NULL | 封面地址 |
| allow_save | INT NOT NULL DEFAULT 1 | 是否允许保存（API 层对外为布尔） |
| custom_params | JSON NULL | 自定义参数数组 `Array<{ key, label, type: "text"\|"image", value }>` |
| created_at / updated_at | TIMESTAMP | 自动维护 |

> API 响应中的 `voice` / `bgm` 不落本表：由本表单一写者在同一事务内回写 `contents.voice.id` / `contents.style.bgm`（白名单校验见 §5.4）。
> 表名 `video_analytics` 与 API 路径为冻结契约，页面已更名「视频发布管理」（§5.4）。

### 10.5 发布记录表：publish_records（视频数据分析，migration 0007）

生产→发布→分析的统一 ID 链路中枢（需求 §七），实现见 `db/schema.ts`：

| 字段 | 类型 | 说明 |
|------|------|------|
| id | VARCHAR(32) PK | `pub_YYYYMMDD_XXXXXX` |
| content_id | VARCHAR(32) NOT NULL | FK → contents.id，`ON DELETE CASCADE`（建索引） |
| video_asset_id | VARCHAR(100) NULL | 视频资产标识 = uploads/video 下文件名（创建时自 contents.video.url 派生） |
| platform | VARCHAR(50) NOT NULL | 发布平台（与 upload_marks.platform 同口径自由文本，加平台免迁移） |
| platform_video_id | VARCHAR(100) NULL | 平台侧作品 ID（抖音 = item_id） |
| publish_title / cover_url | VARCHAR | 发布标题与封面 |
| publish_time | DATETIME NULL | 实际发布时间（mode:"date"） |
| publish_status | ENUM('scheduled','published','deleted') | 默认 published |
| created_at / updated_at | TIMESTAMP | 自动维护 |

**唯一约束** `(platform, platform_video_id)`：禁止按标题模糊匹配维护生产视频↔平台作品关系。

### 10.6 视频指标表：video_metrics（最新值）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INT AUTO PK | 自增 |
| publish_record_id | VARCHAR(32) NOT NULL | FK → publish_records.id，CASCADE |
| metric_name | VARCHAR(64) NOT NULL | canonical 指标名（lib/analytics-taxonomy 注册表） |
| metric_value | DOUBLE NOT NULL | 指标值 |
| source_type | ENUM(5 值) NOT NULL | CREATOR_IMPORT / PLATFORM_PRODUCTION / PLATFORM_CALCULATED / AI_EXTRACTED / USER_INPUT（DOUYIN_* 已随通道砍除） |
| source_field | VARCHAR(100) NULL | 来源原始字段名（如导出列名，溯源展示用） |
| data_date | DATE NULL | 数据所属日期（string 模式存 YYYY-MM-DD；累计值可空） |
| fetched_at | TIMESTAMP NOT NULL | 获取时间 |
| is_estimated | INT NOT NULL DEFAULT 0 | 估算/窗口归因标记（不得伪装精确归因） |
| confidence | FLOAT NULL | 置信度 |
| metadata | JSON NULL | 附加留痕（如派生公式、目录备注） |

唯一约束 `(publish_record_id, metric_name)`；导入后派生指标由平台统一重算（PLATFORM_CALCULATED）。

### 10.7 视频指标每日快照：video_metric_daily

结构同 10.6 但 `data_date NOT NULL`，唯一约束 `(publish_record_id, metric_name, data_date)`；支撑 D0/D1/D2/D3/D7/D14/D30 增长观察（不只存累计值）。

### 10.8 账号每日聚合：creator_metric_daily

| 字段 | 类型 | 说明 |
|------|------|------|
| (platform, stat_date) | 复合 PK | 日期 string 模式 YYYY-MM-DD |
| play/like/comment/share_increment | INT NULL | 日增量（缺失≠0，null 表未采集） |
| profile_uv / new_fans / total_fans | INT NULL | 主页访问/新增/总粉丝 |
| bounce_rate_2s / watch_rate_5s / avg_watch_time | DOUBLE NULL | 2026-09-24 扩展：账号级漏斗比率/均时长（创作者「全量指标」导出，账号级加权口径） |
| post_count / cover_click_rate | INT / DOUBLE NULL | 投稿量（当日）/封面点击率（漏斗首环，账号级） |
| source_type | ENUM(5 值) NOT NULL | 来源（DOUYIN_* 已随通道砍除） |
| fetched_at / metadata | TIMESTAMP / JSON | 留痕 |

账号级数据默认不归因到单视频（需求 §五C）；例外路径 = 导入向导操作者逐行人工裁决归属（`creator-daily/import` attribution=video），落视频指标必携 isEstimated + matched_by=operator_confirmed 近似声明，系统绝不自动拆数。

### 10.9 内容特征表：content_features

Production Feature 落库（需求 §五A）：生产可直取字段从 ContentDTO/产物事实提取（`field_sources` 记 PLATFORM_PRODUCTION）；

- 生产字段：template / level / duration（成片优先，回退配音）/ knowledge_point_count（words 去重）/ segment_count / dialogue_count（仅 scene_word 具台词语义）/ speech_rate（voice.speed 契约默认 1）/ voice_id / bgm / subtitle_type（当前固定 burned_in）/ shot_count（渲染器事实：片头 rendered + 每段/卡/题 1 镜头）/ intro_effect（输出事实 introStatus 映射）/ intro_topic；prompt_version / renderer_version 当前 audit 未留痕→保持 null 不猜测。
- 人工标签字段（生产未建模）：scene / hook / content_format / emotion / cta_type / cta_start_time，仅 PATCH 写入并记 USER_INPUT；重算不覆盖人工值。
- 主键 content_id FK → contents.id CASCADE；字段级来源映射存 `field_sources` JSON（需求 §六：每个值可溯源）。

### 10.10 内容时间轴表：video_segments（Phase 3，migration 0008）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INT AUTO PK | 自增 |
| content_id | VARCHAR(32) NOT NULL | FK → contents.id CASCADE；唯一约束 (content_id, idx) |
| idx | INT NOT NULL | 段序（片头已渲染时占第 0 段） |
| start_time / end_time | DOUBLE NOT NULL | 秒；片头事实 0~1s，正文按字符权重 allocateDurations 分配，总长守恒 |
| segment_type | VARCHAR(32) | intro / story_segment / word_card / quiz_question |
| dialogue / knowledge_point | VARCHAR | 台词文本（截 2000）/ 本段知识点（截 500） |
| scene / emotion / shot_type | VARCHAR(32) NULL | 生产未建模，人工/AI 补充位 |
| source_type | ENUM(7 值) | 派生行固定 PLATFORM_CALCULATED（不伪装逐帧实测） |

### 10.11 分析结果快照表：analysis_result（Phase 3，migration 0008）

追加式留痕：`analysis_type`（如 factors:completion_rate）/ `subject_id`（null=账号级）/ `result` JSON / `evidence` JSON（参与样本 recordId 与总样本量）/ `confidence` / `model_version`（分组统计为 group-stats-v1，不冒充模型）/ `created_at`；索引 (analysis_type, subject_id)。

### 10.12 生产建议表：recommendations（Phase 4，migration 0009）

§八.8 全字段落地：`id`（rec_前缀）/ `recommendation_type`（hook/scene/duration/knowledge_points/speech_rate/cta/template/structure/data_readiness）/ `recommendation` JSON `{value,label,kindLabel}` / `reason`（必携：哪个指标、组中位 vs 账号中位、样本数）/ `source_sample_count` / `source_metric` / `confidence` / `accepted`（NULL 待处理 · 1 采纳 · 0 忽略）/ `applied_to_content_id`（采纳后新建内容，效果回路接入点）/ created_at、updated_at。生成纪律：仅 ≥8 样本组出参数建议，否则 data_readiness 诚实建议。

### 10.13 内容实验表：experiments（Phase 6，migration 0010）

§八.9 预留实体落地：`id`（exp_前缀）/ `variable`（实验变量白名单）/ `variant_a` 、`variant_b` JSON `{label, contentIds[]}`（两组不相交）/ `control_variables` JSON / `target_metric`（canonical，默认 completion_rate）/ `start_at`、`end_at` DATETIME / `status` ENUM(draft/running/completed/cancelled) / `result` JSON（评估 快照：medianA/B、diff、sampleA/B、lowSample、verdict、note、model_version）/ created_at、updated_at；索引 status。

### 10.14 导入批次表：import_batch（四步精准匹配，migration 0008）

`id`（imp_前缀）/ `filename`、`file_size`、`file_hash`（sha256，重复导入检测，索引）/ `platform`（批次声明，自由文本同 publish_records 口径）/ `row_count` / `data_granularity` ENUM(work_level_strong/work_level_weak/account_day_level) / `granularity_evidence` JSON（判定依据可解释）/ `headers`、`field_detection` JSON / `match_rules` JSON（STEP2 快照）/ `status` ENUM(draft→granularity_confirmed→rules_set→prematched→preflight_ok→committed→rolled_back，另有 cancelled) / `commit_summary`、`commit_preimage` JSON（回滚依据）/ created_at、completed_at。

### 10.15 导入行表：import_row（migration 0008）

`id` 自增 PK / `batch_id` FK(cascade) / `row_number`（1-based，UNIQUE(batch_id,row_number)）/ `raw_data` JSON（原始整行，**永久保留永不删改**）/ `normalized_data` JSON（字段识别后标准数据）/ `data_granularity` ENUM / `match_status` ENUM(unique_match/conflict/unmatched/account_day_level/confirmed/ignored，六态禁增) / `validation_status` ENUM(pending/ok/warning/error，preflight 行级结果)；索引 (batch_id, match_status)。

### 10.16 匹配候选表：match_candidate（migration 0008）

`id` 自增 PK / `import_row_id` FK(cascade) / `video_id` FK→publish_records.id(cascade)（一个 import_row 可多候选）/ `match_method` ENUM(platform_work_id_exact/work_url_id/account_publish_time/account_date_title/account_date_title_duration) / `match_score` FLOAT / `evidence` JSON（结构化必存，禁裸分数）/ `rank`（1=最强）；UNIQUE(import_row_id,video_id)。

### 10.17 匹配裁决表：match_decision（migration 0008）

`import_row_id` PK FK(cascade)（一行一决定）/ `batch_id` FK / `match_status` 同六态 / `matched_video_id`（无 FK：发布记录删除不抹裁决历史，提交时服务端校验存在性）/ `match_method`、`confidence` / `decision_type` ENUM(system_auto/operator_confirm/operator_assign/operator_external/operator_account_day/operator_ignore) / `operator`（本机无认证固定 local，字段留位）/ `confirmed_at` / `metadata` JSON（external 留档、系统建议态回退依据）。

---

## 十一、文件组织

```
project-root/
├── README.md                  # 项目概览
├── PRD.md                     # 产品需求文档
├── SPEC.md                    # 本文档
├── pnpm-workspace.yaml        # pnpm workspace 配置
├── package.json               # 根 package.json
│
├── docs/
│   ├── 01_项目概述文档.txt
│   ├── 02_MVP需求文档.txt
│   ├── 03_系统模块设计文档.txt
│   ├── 04_Content_DTO设计文档.txt
│   ├── 05_Dify_Workflow设计文档.txt（废弃，参考 docs/15）│
│   ├── 06_视频生产SOP文档.txt │
│   ├── 07_后续扩展规划文档.txt │
│   ├── 08_TTS服务设计文档.md │
│   ├── 09_词库数据方案.md │
│   ├── 10_视频渲染设计文档.md │
│   ├── 11_前端页面设计文档.md │
│   ├── 12_部署与运行指南.md │
│   ├── 13_背景音乐素材清单.md │
│   ├── 14_模型层设计方案.md │
│   ├── 15_AI内容生成服务设计.md │
│   ├── 情景词汇阅读视频模板设计规范 V1.0.txt
│   └── 四级词汇情景记忆卡片设计方案.md
│
├── packages/
│   ├── shared/                    ← 前后端共享
│   │   └── src/
│   │       ├── content.dto.ts
│   │       ├── request.dto.ts
│   │       ├── response.dto.ts
│   │       └── enums.ts
│   │
│   ├── backend/                   ← Hono + Drizzle + Zod
│   │   └── src/
│   │       ├── routes/            # cet / content / tts / video / tasks /
│   │       │                      # topics / files / upload-marks /
│   │       │                      # video-analytics / health ✅
│   │       ├── services/          # cet / llm / content / tts / video ✅
│   │       ├── lib/               # logger / api-error / tts-catalog / intro-status ✅
│   │       ├── renderer/          # 三模板 Playwright 渲染器 + Three.js 片头截帧 ✅
│   │       ├── db/                # schema + migrate + seed ✅
│   │       └── openapi.json       # 经 pnpm openapi:gen 生成（非启动时写文件）✅
│   │
│   └── frontend/                  ← Vue 3.5 + shadcn-vue + Vite
│       └── src/
│           ├── api/               # openapi-fetch 客户端 ✅
│           ├── views/             # CreateTask / TaskList / TaskDetail /
│           │                      # Files / VideoList / MarksList / AuditList /
│           │                      # Analytics（视频发布管理）✅
│           └── router.ts          # / /tasks /files /videos /marks /audit /analytics
│
```

> 目录结构以仓库为准。去 Dify 架构见 §12.3。

---

## 十二、实现检查清单

### 12.1 基础设施

- [x] pnpm workspace 初始化（`pnpm-workspace.yaml`）
- [x] MySQL 数据库建库 + 四六级词库数据导入（CET4 + CET6，5999 词）
- [ ] （可选）S3 兼容存储替换本地 uploads/

### 12.2 后端 API

- [x] `POST /api/cet/validate-words` / `random-words`
- [x] `POST /api/tts/generate` / `from-content`；`GET /api/tts/voices`
- [x] `POST /api/video/render`
- [x] `POST /api/content/generate`
- [x] `GET|PATCH|DELETE /api/tasks`（及搜索、批量删除）
- [x] `GET|POST|PATCH|DELETE /api/upload-marks`；`GET /api/upload-marks/overview`
- [x] `POST /api/topics/suggest`；文件管理 `/api/files*`
- [x] `GET /api/video-analytics`（批量）· `GET|PATCH /api/video-analytics/:contentId` · `PATCH /api/tasks/:id/render-settings`（§5.4）
- [x] OpenAPI 3.1 自动生成（`pnpm openapi:gen` 命令生成，不随启动写文件）+ `/doc` Scalar

### 12.3 AI 内容生成（去 Dify）

- [x] `POST /api/content/generate`（docs/15 V4）
- [x] Ollama 本地模型配置（docs/14）
- [x] 前端串联：content/generate → tts/from-content → video/render

### 12.4 shared 类型包

- [x] enums / content.dto / request.dto / response.dto

### 12.5 模板渲染器

- [x] TemplateRenderer + SceneWord / WordCard / Quiz
- [x] Three.js 片头截帧（three-intro.capture，截帧超时 + 黑屏 fail-closed，产出 introStatus）

### 12.6 Vue 前端

- [x] Vite + Vue 3.5 + Tailwind 4 + shadcn-vue
- [x] openapi-typescript + openapi-fetch
- [x] 新建 / 记录 / 详情 / 文件 / 视频资产 / 上传标记 / 审计 / 发布管理

---

## 十三、术语表


| 术语 | 说明 |
|------|------|
| DTO | Data Transfer Object，层间数据结构 |
| ContentDTO | 统一的视频内容数据载体 |
| partial_dto | 原 Workflow A 输出的半成品（缺 audio/video，术语保留供历史文档阅读） |
| final_dto | 原 Workflow B 输出的完整 DTO（术语保留供历史文档阅读） |
| Dify（已废弃） | 原 AI 编排平台，2026-08-17 起由后端直连 LLM 取代 |
| TTS | Text-to-Speech，文本转语音 |
| CET4/CET6 | 大学英语四六级 |
| FFmpeg | 开源音视频处理工具 |
| Structured Output | LLM 按预定义 JSON Schema 输出，保证格式一致性 |
| discriminated union | TypeScript 通过共有的字面量字段区分联合类型的不同分支 |
