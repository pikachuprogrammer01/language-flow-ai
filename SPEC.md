# AI 英语短视频内容生产平台 — 技术规格说明书（SPEC）

> 版本：V1.0
> 对应 PRD：V1.0
> 更新日期：2026-07-28

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
| 流程编排 | 无（后端 service 直连 LLM） | 内容生成：llm.service 调 OpenAI 兼容 API（Ollama 本地，docs/14） |
| 后端语言 | TypeScript (Node.js) | 后端 API 服务统一语言 |
| 后端框架 | Hono | 轻量 TS-first Web 框架，原生 Zod 集成，Edge-ready |
| 数据校验 | Zod | 运行时类型校验，与 Hono zValidator 中间件配合 |
| 数据库 ORM | Drizzle ORM | TS 结构映射 DDL，零代码生成，类型自动推导 |
| 数据库 | MySQL 8.4 | 词库表 + contents 表，JSON 列支持 |
| 前端框架 | Vue 3.5 + Composition API | `<script setup lang="ts">` 语法，与后端共享 TS 类型 |
| UI 组件库 | shadcn-vue | Vue 版 shadcn/ui，Radix Vue 底座，源码归己 |
| 前端样式 | Tailwind CSS 4 | 原子化 CSS，与 shadcn-vue 原生配合 |
| 前端路由 | Vue Router 4 | CSR 三页面路由，无需 SSR |
| 前端请求 | TanStack Vue Query | API 请求缓存/loading/error 状态管理 |
| 前端构建 | Vite 6 | 原生 TS 支持，HMR 秒级 |
| API 文档 | @hono/zod-openapi + Scalar | 从 Hono 路由 + Zod schema 自动生成 OpenAPI 3.1 规范 |
| API 客户端 | openapi-typescript + openapi-fetch | 从 OpenAPI spec 自动生成类型安全的前端请求客户端 |
| 共享类型 | pnpm workspace shared 包 | ContentDTO 类型一次定义，前后端复用 |
| AI 模型 | GPT-4o / Claude 3.5 Sonnet | 必须支持 JSON Structured Output |
| 视频渲染 | HTML + Playwright + FFmpeg | 模板渲染 → 截图 → 合成 |
| 文件存储 | S3 兼容对象存储 / CDN | 存储音频和视频文件 |
| 测试框架 | Vitest 3 | backend 用 node 环境，frontend 用 jsdom |
| 日志 | pino + pino-pretty | 结构化日志，开发环境彩色输出 |
| 限流 | hono-rate-limiter | 按 IP 限流，无需 Redis |
| CI/CD | GitHub Actions | push/PR 自动 typecheck + test + lint |

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
2. **生成规范**：Hono 应用导出 OpenAPI 3.1 JSON 文件（`openapi.json`）
3. **生成客户端类型**：`npx openapi-typescript openapi.json -o src/api/schema.d.ts`
4. **前端调用**：用 `openapi-fetch` 创建类型安全的请求客户端，所有 API 调用的请求体和响应体自动获得 TS 类型

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
- OpenAPI 规范文件可直接导入 Scalar/Swagger UI 做可视化的 API 文档浏览和调试（见下方 2.3.1）

### 2.3.1 API 文档可视化

Scalar 是一个现代化的 API 文档 UI（替代 Swagger UI），支持直接从 OpenAPI 规范文件渲染交互式文档。开发时启动一个独立页面即可浏览和测试所有 API 端点，不需要额外维护文档。

```
npx scalar-reference openapi.json --port 3001
```

### 2.4 完整技术栈

---

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

#### 5.2.1 POST /api/tts/generate — 底层文本合成

**请求体**（已发布契约，保持兼容）：

```typescript
{
  text: string;            // 待朗读的纯文本（1~500 字符）
  voice: string;           // Edge TTS 音色名，默认 "zh-CN-XiaoxiaoNeural"
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
  voice: string;           // Edge TTS 音色名，默认 "zh-CN-XiaoxiaoNeural"
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
3. Playwright/Puppeteer 打开 HTML，按 segments/items 逐帧截图
4. FFmpeg 将图片帧 + ContentDTO.audio 合成 MP4（MVP 静音合成，bgm 后续扩展）
5. 上传到 CDN，返回 URL
```

**错误码**：

| 状态码 | 情况 |
|--------|------|
| 200 | 正常 |
| 400 | ContentDTO 格式错误或缺少必要字段 |
| 500 | 渲染引擎错误 |

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
（实现以 `db/schema.ts` 为准，与 docs/09 一致）

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
│   │       ├── routes/
│   │       │   ├── cet.ts         # /api/cet/*（validate-words ✅，random-words ⏳）
│   │       │   ├── tts.ts         # /api/tts/*（generate + from-content ✅）
│   │       │   └── video.ts       # /api/video/* ⏳ 待实现（#18）
│   │       ├── services/
│   │       │   ├── cet.service.ts   # 词库校验 ✅
│   │       │   ├── tts.service.ts   # Edge TTS 合成 + 拼接 + 时长 ✅
│   │       │   └── video.service.ts # ⏳ 待实现（#18）
│   │       ├── renderer/           # ⏳ 待实现（#18）
│   │       │   ├── renderer.interface.ts
│   │       │   ├── scene-word.renderer.ts
│   │       │   ├── word-card.renderer.ts
│   │       │   └── quiz.renderer.ts
│   │       ├── db/
│   │       │   ├── schema.ts      # Drizzle ORM 表定义 ✅
│   │       │   └── index.ts       # 数据库连接 ✅
│   │       └── openapi.json       # 自动生成的 OpenAPI 3.1 规范 ⏳ 待实现（#19）
│   │
│   └── frontend/                  ← Vue 3.5 + shadcn-vue + Vite
│       └── src/
│           ├── api/               # ⏳ 待实现（#26）
│           │   ├── client.ts      # openapi-fetch 类型安全客户端
│           │   └── schema.d.ts    # openapi-typescript 自动生成
│           ├── pages/             # ⏳ 待实现（#28-#30）
│           │   ├── CreateTask.vue
│           │   ├── TaskList.vue
│           │   └── TaskDetail.vue
│           ├── components/
│           │   └── ui/            # shadcn-vue 组件 ⏳ 待生成
│           └── router.ts
│
```

> 目录结构 2026-08-17 更新：dify/ 目录已废弃（去 Dify 架构，见 §12.3）；实际结构以仓库为准
> （packages/backend + packages/frontend + uploads + docs）。

---

## 十二、实现检查清单

### 12.1 基础设施

- [ ] pnpm workspace 初始化（`pnpm-workspace.yaml`）
- [ ] MySQL 数据库建库 + 四六级词库数据导入（CET4 + CET6）
- [ ] S3 兼容存储配置（MinIO 本地 / 云 S3）

### 12.2 后端 API

- [x] `POST /api/cet/validate-words` — 候选词批量验证 ✅
- [ ] `POST /api/cet/random-words` — 按等级随机抽取
- [x] `POST /api/tts/generate` — 底层文本合成 ✅
- [x] `POST /api/tts/from-content` — ContentArray 拼接合成 ✅
- [ ] `POST /api/video/render` — HTML 模板渲染 + FFmpeg 合成
- [ ] OpenAPI 3.1 规范自动生成（`@hono/zod-openapi`）

### 12.3 AI 内容生成（去 Dify，2026-08-17 架构变更）

- [ ] `POST /api/content/generate` — LLM 生成情景故事 + 词库校验（docs/15）
- [x] 模型配置：Ollama 本地（qwen2.5:7b）环境变量配置（docs/14，2026-08-17 完成）
- [ ] 串联逻辑：content/generate → tts/from-content → video/render

### 12.4 shared 类型包

- [ ] `enums.ts` — TemplateType, ContentStatus, CefrLevel
- [ ] `content.dto.ts` — 所有子结构 + ContentDTO + ContentArray
- [ ] `request.dto.ts` — CreateContentRequest + EditContentRequest
- [ ] `response.dto.ts` — ContentListItem + ContentDetail + PaginatedResponse

### 12.5 模板渲染器

- [ ] TemplateRenderer 接口定义
- [ ] SceneWordRenderer（HTML 模板 + Playwright 截图）
- [ ] WordCardRenderer
- [ ] QuizRenderer

### 12.6 Vue 前端

- [ ] 项目脚手架（Vite + Vue 3.5 + TypeScript + Tailwind CSS 4）
- [ ] shadcn-vue 组件初始化
- [ ] `openapi-typescript` 从 `openapi.json` 生成 `schema.d.ts`
- [ ] `openapi-fetch` 类型安全客户端封装
- [ ] 新建任务页（`CreateTask.vue`）— 模板选择 + 参数表单
- [ ] 任务列表页（`TaskList.vue`）— 分页列表 + 状态标签
- [ ] 任务详情页（`TaskDetail.vue`）— 内容预览 + 视频播放

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
