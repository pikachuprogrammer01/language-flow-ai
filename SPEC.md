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
| 05_Dify_Workflow设计文档 | Workflow 节点设计 | SPEC 补充代码细节和边界情况 |

---

## 二、系统架构

### 2.1 架构图

```
┌──────────────────────────────────────────────────────────────┐
│                         Dify 平台                              │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐     │
│  │                  Workflow A：内容生成                  │     │
│  │                                                     │     │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐          │     │
│  │  │ A1       │  │ A2       │  │ A3       │          │     │
│  │  │ scene_   │  │ word_    │  │ quiz     │          │     │
│  │  │ word     │  │ card     │  │          │          │     │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘          │     │
│  │       └──────────────┼─────────────┘                │     │
│  │                      │                              │     │
│  │              输出: partial_dto                       │     │
│  └──────────────────────┼──────────────────────────────┘     │
│                         │                                    │
│                         │  MVP 自动串联                        │
│                         │                                    │
│  ┌──────────────────────┼──────────────────────────────┐     │
│  │                  Workflow B：媒体生产                  │     │
│  │                      │                              │     │
│  │              TTS → 视频渲染 → 输出: final_dto         │     │
│  └─────────────────────────────────────────────────────┘     │
│                                                               │
└──────────────────────────┬───────────────────────────────────┘
                           │
                           │  HTTP Request 节点调用
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
│  │   ContentDTO 持久化（MySQL / PostgreSQL）              │    │
│  │   四六级词库（独立表）                                   │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 技术选型

| 层 | 选型 | 说明 |
|----|------|------|
| 流程编排 | Dify | 工作流引擎，LLM/Code/HTTP 节点编排 |
| 后端语言 | TypeScript (Node.js) | Dify Code 节点 + 后端 API 服务统一语言 |
| 后端框架 | Hono | 轻量 TS-first Web 框架，原生 Zod 集成，Edge-ready |
| 数据校验 | Zod | 运行时类型校验，与 Hono zValidator 中间件配合 |
| 数据库 ORM | Drizzle ORM | TS 结构映射 DDL，零代码生成，类型自动推导 |
| 数据库 | MySQL 8.0 | 词库表 + contents 表，JSON 列支持 |
| 前端框架 | Vue 3.5 + Composition API | `<script setup lang="ts">` 语法，与后端共享 TS 类型 |
| UI 组件库 | shadcn-vue | Vue 版 shadcn/ui，Radix Vue 底座，源码归己 |
| 前端样式 | Tailwind CSS 4 | 原子化 CSS，与 shadcn-vue 原生配合 |
| 前端路由 | Vue Router 4 | CSR 三页面路由，无需 SSR |
| 前端请求 | TanStack Vue Query | API 请求缓存/loading/error 状态管理 |
| 前端构建 | Vite 6 | 原生 TS 支持，HMR 秒级 |
| API 文档 | @hono/zod-openapi + Scalar | 从 Hono 路由 + Zod schema 自动生成 OpenAPI 3.1 规范 |
| API 客户端 | openapi-typescript + openapi-fetch | 从 OpenAPI spec 自动生成类型安全的前端请求客户端 |
| 共享类型 | pnpm workspace shared 包 | ContentDTO 类型一次定义，前后端 + Dify Code 节点复用 |
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
  id: string;              // 音色 ID，如 "female_01"
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

Dify 的 HTTP Request 节点将调用以下后端 API。所有接口的 Content-Type 为 `application/json`。

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

```
POST /api/tts/generate
```

**请求体**：

```typescript
{
  content: ContentArray;     // 同 ContentDTO.content
  template: TemplateType;    // 用于判断文本拼接方式
  voice: VoiceConfig;        // { id, speed? }
}
```

**响应体**：

```typescript
{
  audio: {
    url: string;             // 音频文件 URL
    duration: number;        // 时长（秒）
    format: string;          // "mp3"
  };
}
```

**TTS 文本拼接规则**（后端根据 template 决定）：

| template | 拼接方式 |
|----------|----------|
| scene_word | 将所有 segment.text 用标点连接，每个 segment 后追加其 words 的朗读 |
| word_card | 拼接 "word. pos. example" → "elaborate. adj. She made elaborate preparations for the party." |
| quiz | 拼接 "stem. A. options[0]. B. options[1]. C. options[2]. D. options[3]." |

**错误码**：

| 状态码 | 情况 |
|--------|------|
| 200 | 正常 |
| 400 | content 为空或 voice 格式错误 |
| 500 | TTS 引擎错误 |

### 5.3 视频渲染服务

```
POST /api/video/render
```

**请求体**：完整的 ContentDTO（含 audio 字段，即 Workflow B 的 dto_with_audio）。

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
4. FFmpeg 将图片帧 + ContentDTO.audio + bgm 合成为 MP4
5. 上传到 CDN，返回 URL
```

**错误码**：

| 状态码 | 情况 |
|--------|------|
| 200 | 正常 |
| 400 | ContentDTO 格式错误或缺少必要字段 |
| 500 | 渲染引擎错误 |

---

## 六、Dify Workflow A — 内容生成

### 6.1 通用约定

#### 6.1.1 节点命名

| 类型 | 前缀 | 示例 |
|------|------|------|
| Start | start | start |
| LLM | llm_ | llm_generate_story |
| Code | code_ | code_extract_words |
| HTTP Request | http_ | http_query_cet_db |
| End | end | end |

#### 6.1.2 变量传递

每个节点的输出为一个 Dify 变量，下游节点通过 `{{变量名}}` 引用。

#### 6.1.3 Code 节点规范

- 语言：TypeScript
- 函数签名：`function main(...): ResultType`
- 不允许使用 Python 语法
- 所有输入参数必须显式声明类型
- JSON 操作使用 `JSON.parse` / `JSON.stringify`

### 6.2 Workflow A1：scene_word 情景背词

#### 6.2.1 节点列表

```
start → llm_generate_story → code_extract_words → http_query_cet_db → code_validate_words → code_assemble_dto → end
```

#### 6.2.2 start

| 属性 | 值 |
|------|-----|
| 类型 | Start |
| 输出变量 | user_input |

**输入字段**：

| 字段 | 类型 | 必填 | 默认值 |
|------|------|------|--------|
| topic | string | 是 | — |
| template | string | 是 | — |
| level | string | 是 | — |
| wordCount | number | 否 | 10 |
| targetDuration | number | 否 | 60 |
| voice | object | 否 | — |
| style | object | 否 | — |

#### 6.2.3 llm_generate_story

| 属性 | 值 |
|------|-----|
| 类型 | LLM |
| 模型 | GPT-4o / Claude 3.5 Sonnet |
| 输入 | {{user_input.topic}}, {{user_input.level}}, {{user_input.wordCount}} |
| 输出变量 | story_result |

**System Prompt**：

```
你是一名英语短视频内容创作者，为抖音制作四六级词汇学习视频。

任务：根据用户提供的主题，创作一个中英混合的短故事。

要求：
1. 使用中文作为主要叙述语言
2. 自然嵌入指定数量的四六级词汇（以英文原文呈现，不翻译）
3. 故事情节简单紧凑，适合 60 秒阅读
4. 每个句子作为一个独立段落（segment）
5. 输出严格 JSON 格式

输出格式：
{
  "title": "具有吸引力的视频标题",
  "segments": [
    {
      "text": "中英混合文本，如：Leo接到一份contract，任务是前往未知的continent寻找文明遗迹。",
      "candidateWords": [
        { "word": "contract", "wordIndex": 3 },
        { "word": "continent", "wordIndex": 10 }
      ]
    }
  ]
}

wordIndex 说明：对 text 按空格和标点进行分词后，该英文单词在分词数组中的 0-based 索引。
```

**User Prompt**：

```
主题：{{user_input.topic}}
等级：{{user_input.level}}
词汇数量：{{user_input.wordCount}}
目标时长：{{user_input.targetDuration}} 秒

请生成故事。
```

**输出格式**：JSON Structured Output，严格按上述 schema。

#### 6.2.4 code_extract_words

| 属性 | 值 |
|------|-----|
| 类型 | Code (TypeScript) |
| 输入 | story_result |
| 输出变量 | extracted_words |

**代码逻辑**：

```typescript
function main(story_result: {
  title: string;
  segments: Array<{
    text: string;
    candidateWords: Array<{ word: string; wordIndex: number }>;
  }>;
}): { candidateWords: Array<{ word: string; wordIndex: number; segmentIndex: number }> } {

  const seen = new Set<string>();
  const candidateWords: Array<{ word: string; wordIndex: number; segmentIndex: number }> = [];

  (story_result.segments || []).forEach((seg, segIdx) => {
    (seg.candidateWords || []).forEach(cw => {
      const key = (cw.word || "").toLowerCase();
      if (key && !seen.has(key)) {
        seen.add(key);
        candidateWords.push({
          word: cw.word,
          wordIndex: cw.wordIndex,
          segmentIndex: segIdx
        });
      }
    });
  });

  return { candidateWords };
}
```

#### 6.2.5 http_query_cet_db

| 属性 | 值 |
|------|-----|
| 类型 | HTTP Request |
| 方法 | POST |
| URL | https://your-api.com/api/cet/validate-words |
| 输入 | extracted_words |
| 输出变量 | cet_result |

**请求体构造**：

```json
{
  "words": [{{extracted_words.candidateWords 中提取 word 字段的数组}}],
  "level": "{{user_input.level}}"
}
```

#### 6.2.6 code_validate_words

| 属性 | 值 |
|------|-----|
| 类型 | Code (TypeScript) |
| 输入 | story_result, cet_result |
| 输出变量 | validated_content |

**代码逻辑**：

```typescript
function main(
  story_result: {
    title: string;
    segments: Array<{
      text: string;
      candidateWords: Array<{ word: string; wordIndex: number }>;
    }>;
  },
  cet_result: {
    matchedWords: Array<{ word: string; level: string; meaning: string; frequency?: number }>;
    unmatchedWords: string[];
  }
): { content: SceneWordSegment[]; words: WordInfo[] } {

  // 构建匹配词查找表
  const matchMap = new Map<string, { level: string; meaning: string; frequency?: number }>();
  (cet_result.matchedWords || []).forEach(m => {
    matchMap.set(m.word.toLowerCase(), m);
  });

  const seen = new Set<string>();
  const allWords: WordInfo[] = [];
  const content: SceneWordSegment[] = [];

  (story_result.segments || []).forEach(seg => {
    const validWords: WordInfo[] = [];
    (seg.candidateWords || []).forEach(cw => {
      const match = matchMap.get((cw.word || "").toLowerCase());
      if (match) {
        validWords.push({
          word: cw.word,
          meaning: match.meaning,
          level: match.level as CefrLevel,
          wordIndex: cw.wordIndex,
          frequency: match.frequency
        });
        const key = cw.word.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          allWords.push({
            word: cw.word,
            meaning: match.meaning,
            level: match.level as CefrLevel
          });
        }
      }
      // 未匹配到的词丢弃
    });

    if (validWords.length > 0) {
      content.push({ text: seg.text, words: validWords });
    }
  });

  return { content, words: allWords };
}
```

**注意**：如果一个 segment 中所有 candidateWords 都未通过词库校验，该 segment 整体丢弃。

#### 6.2.7 code_assemble_dto

| 属性 | 值 |
|------|-----|
| 类型 | Code (TypeScript) |
| 输入 | user_input, story_result, validated_content |
| 输出变量 | partial_dto |

**代码逻辑**：

```typescript
function main(
  user_input: Record<string, unknown>,
  story_result: { title: string },
  validated_content: { content: SceneWordSegment[]; words: WordInfo[] }
): ContentDTO {

  const now = new Date().toISOString();
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const hexId = Math.random().toString(16).slice(2, 8);

  return {
    id: `cnt_${dateStr}_${hexId}`,
    template: "scene_word",
    title: story_result.title || "",
    level: (user_input.level as CefrLevel) || "CET4",
    targetDuration: (user_input.targetDuration as number) || 60,
    content: validated_content.content,
    words: validated_content.words,
    style: (user_input.style as StyleConfig) || { background: "white" },
    voice: (user_input.voice as VoiceConfig) || { id: "female_01", speed: 1.0 },
    status: "content_ready",
    createdAt: now,
    updatedAt: now
  };
}
```

#### 6.2.8 end

| 属性 | 值 |
|------|-----|
| 类型 | End |
| 输出 | {{partial_dto}} |

---

### 6.3 Workflow A2：word_card 单词卡片

#### 6.3.1 节点列表

```
start → http_query_cet_db → llm_generate_cards → code_assemble_dto → end
```

#### 6.3.2 start

与 A1 的 start 相同，但 topic 为可选字段（作为 LLM 出题方向提示）。

#### 6.3.3 http_query_cet_db

| 属性 | 值 |
|------|-----|
| 方法 | POST |
| URL | https://your-api.com/api/cet/random-words |
| 请求 | { "level": "{{user_input.level}}", "count": {{user_input.wordCount}} } |
| 输出变量 | cet_words |

#### 6.3.4 llm_generate_cards

| 属性 | 值 |
|------|-----|
| 类型 | LLM |
| 输入 | {{cet_words.words}} |
| 输出变量 | card_result |

**System Prompt**：

```
你是一名英语四六级教学专家。为每个词汇生成一张单词卡片。

要求：
1. 给出准确的词性（n. / v. / adj. / adv. / prep. 等）
2. 中文释义准确
3. 例句自然地道，能体现词的典型用法
4. 例句翻译通顺
5. 输出严格 JSON 格式

输出格式：
{
  "title": "每日5个四六级高频词汇",
  "cards": [
    {
      "word": "elaborate",
      "pos": "adj.",
      "meaning": "精心制作的；详尽的",
      "example": "She made elaborate preparations for the party.",
      "exampleMeaning": "她为聚会做了精心的准备。"
    }
  ]
}
```

#### 6.3.5 code_assemble_dto

```typescript
function main(
  user_input: Record<string, unknown>,
  cet_words: { words: Array<{ word: string; level: string; meaning: string }> },
  card_result: { title: string; cards: WordCardItem[] }
): ContentDTO {

  const now = new Date().toISOString();
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const hexId = Math.random().toString(16).slice(2, 8);

  const words: WordInfo[] = (cet_words.words || []).map(w => ({
    word: w.word,
    meaning: w.meaning,
    level: w.level as CefrLevel
  }));

  return {
    id: `cnt_${dateStr}_${hexId}`,
    template: "word_card",
    title: card_result.title || "",
    level: (user_input.level as CefrLevel) || "",
    targetDuration: (user_input.targetDuration as number) || 45,
    content: card_result.cards || [],
    words,
    style: (user_input.style as StyleConfig) || { background: "white" },
    voice: (user_input.voice as VoiceConfig) || { id: "female_01", speed: 1.0 },
    status: "content_ready",
    createdAt: now,
    updatedAt: now
  };
}
```

---

### 6.4 Workflow A3：quiz 选择题

#### 6.4.1 节点列表

```
start → http_query_cet_db → llm_generate_quiz → code_assemble_dto → end
```

#### 6.4.2 llm_generate_quiz

**System Prompt**：

```
你是一名英语四六级考试出题专家。为每个词汇生成一道选择题。

要求：
1. 题干：询问该词的中文含义，如 ""contract" 的意思是？"
2. 提供 4 个中文选项，其中 1 个正确答案
3. 干扰项应是同等级别的其他 CET 词汇释义，不能明显不相关
4. 提供答案解析
5. 标注正确答案索引（0-based）
6. 输出严格 JSON 格式

输出格式：
{
  "title": "四六级词汇挑战 — 你能答对几题？",
  "questions": [
    {
      "word": { "word": "contract", "meaning": "合同", "level": "CET4" },
      "stem": ""contract" 的意思是？",
      "options": ["合同", "联系", "对比", "建造"],
      "correctIndex": 0,
      "explanation": "contract 作为名词意为"合同、契约"，作为动词意为"收缩"。"
    }
  ]
}
```

#### 6.4.3 code_assemble_dto

```typescript
function main(
  user_input: Record<string, unknown>,
  quiz_result: { title: string; questions: QuizItem[] }
): ContentDTO {

  const now = new Date().toISOString();
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const hexId = Math.random().toString(16).slice(2, 8);

  // 从 questions 中提取去重 words
  const seen = new Set<string>();
  const words: WordInfo[] = [];
  (quiz_result.questions || []).forEach(q => {
    const w = q.word;
    const key = (w.word || "").toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      words.push({ word: w.word, meaning: w.meaning, level: w.level as CefrLevel });
    }
  });

  return {
    id: `cnt_${dateStr}_${hexId}`,
    template: "quiz",
    title: quiz_result.title || "",
    level: (user_input.level as CefrLevel) || "",
    targetDuration: (user_input.targetDuration as number) || 30,
    content: quiz_result.questions || [],
    words,
    style: (user_input.style as StyleConfig) || { background: "white" },
    voice: (user_input.voice as VoiceConfig) || { id: "female_01", speed: 1.0 },
    status: "content_ready",
    createdAt: now,
    updatedAt: now
  };
}
```

---

## 七、Dify Workflow B — 媒体生产（三个模板共用）

### 7.1 节点列表

```
start → http_tts → code_merge_audio → http_render_video → code_merge_video → end
```

### 7.2 start

| 属性 | 值 |
|------|-----|
| 类型 | Start |
| 输入 | partial_dto（来自 Workflow A 的 end 输出） |
| 输出变量 | partial_dto |

**说明**：MVP 阶段由调用方串联 —
1. 调用 Workflow A，阻塞等待返回 `partial_dto`
2. 将 `partial_dto` 作为输入调用 Workflow B

### 7.3 http_tts

| 属性 | 值 |
|------|-----|
| 方法 | POST |
| URL | https://your-api.com/api/tts/generate |
| 输出变量 | tts_result |

**请求体**：

```json
{
  "content": {{partial_dto.content}},
  "template": "{{partial_dto.template}}",
  "voice": {{partial_dto.voice}}
}
```

### 7.4 code_merge_audio

```typescript
function main(
  partial_dto: Record<string, unknown>,
  tts_result: { audio: { url: string; duration: number; format: string } }
): ContentDTO {
  return {
    ...partial_dto,
    audio: tts_result.audio,
    status: "audio_ready",
    updatedAt: new Date().toISOString()
  } as ContentDTO;
}
```

输出变量名：`dto_with_audio`

### 7.5 http_render_video

| 属性 | 值 |
|------|-----|
| 方法 | POST |
| URL | https://your-api.com/api/video/render |
| 请求体 | 完整的 dto_with_audio（即 ContentDTO + audio） |
| 输出变量 | video_result |

### 7.6 code_merge_video

```typescript
function main(
  dto_with_audio: Record<string, unknown>,
  video_result: { video: { url: string; duration: number; resolution: string; format: string; size?: number } }
): ContentDTO {
  return {
    ...dto_with_audio,
    video: video_result.video,
    status: "completed",
    updatedAt: new Date().toISOString()
  } as ContentDTO;
}
```

输出变量名：`final_dto`

### 7.7 end

| 属性 | 值 |
|------|-----|
| 类型 | End |
| 输出 | {{final_dto}} |

---

## 八、Dify Request / Response DTO

### 8.1 输入（创建视频任务）

```typescript
// Dify API 调用时的 inputs 字段
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
| JSON 输出格式不符合 schema | Dify Structured Output 模式会自动重试，最多 3 次；仍失败则标记 failed |
| LLM API 超时（>30s） | Dify 自动重试 1 次；仍失败则标记 failed |
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
| 类型转换失败 | Dify 自动捕获异常，标记 failed |
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
| word | VARCHAR(128) | 英文单词 |
| level | VARCHAR(8) | CET4 / CET6 |
| meaning | VARCHAR(512) | 中文释义 |
| frequency | FLOAT | 词频（0~1） |

**索引**：`UNIQUE(word, level)`, `INDEX(level)`, `INDEX(frequency)`

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
│   ├── 05_Dify_Workflow设计文档.txt
│   ├── 06_视频生产SOP文档.txt
│   ├── 07_后续扩展规划文档.txt
│   └── 情景词汇阅读视频模板设计规范 V1.0.txt
│
├── packages/
│   ├── shared/                    ← 前后端 + Dify Code 节点共享
│   │   └── src/
│   │       ├── content.dto.ts
│   │       ├── request.dto.ts
│   │       ├── response.dto.ts
│   │       └── enums.ts
│   │
│   ├── backend/                   ← Hono + Drizzle + Zod
│   │   └── src/
│   │       ├── routes/
│   │       │   ├── cet.ts         # /api/cet/*
│   │       │   ├── tts.ts         # /api/tts/*
│   │       │   └── video.ts       # /api/video/*
│   │       ├── services/
│   │       │   ├── cet.service.ts
│   │       │   ├── tts.service.ts
│   │       │   └── video.service.ts
│   │       ├── renderer/
│   │       │   ├── renderer.interface.ts
│   │       │   ├── scene-word.renderer.ts
│   │       │   ├── word-card.renderer.ts
│   │       │   └── quiz.renderer.ts
│   │       ├── db/
│   │       │   ├── schema.ts      # Drizzle ORM 表定义
│   │       │   └── index.ts       # 数据库连接
│   │       └── openapi.json       # 自动生成的 OpenAPI 3.1 规范
│   │
│   └── frontend/                  ← Vue 3.5 + shadcn-vue + Vite
│       └── src/
│           ├── api/
│           │   ├── client.ts      # openapi-fetch 类型安全客户端
│           │   └── schema.d.ts    # openapi-typescript 自动生成
│           ├── pages/
│           │   ├── CreateTask.vue
│           │   ├── TaskList.vue
│           │   └── TaskDetail.vue
│           ├── components/
│           │   └── ui/            # shadcn-vue 组件
│           └── router.ts
│
└── dify/
    ├── content_generation/
    │   ├── scene_word.yml         # Workflow A1
    │   ├── word_card.yml          # Workflow A2
    │   └── quiz.yml               # Workflow A3
    └── media_production/
        └── media_production.yml   # Workflow B
```

---

## 十二、实现检查清单

### 12.1 基础设施

- [ ] pnpm workspace 初始化（`pnpm-workspace.yaml`）
- [ ] MySQL 数据库建库 + 四六级词库数据导入（CET4 + CET6）
- [ ] S3 兼容存储配置（MinIO 本地 / 云 S3）

### 12.2 后端 API

- [ ] `POST /api/cet/validate-words` — 候选词批量验证
- [ ] `POST /api/cet/random-words` — 按等级随机抽取
- [ ] `POST /api/tts/generate` — 文本转语音（含 template 路由拼接逻辑）
- [ ] `POST /api/video/render` — HTML 模板渲染 + FFmpeg 合成
- [ ] OpenAPI 3.1 规范自动生成（`@hono/zod-openapi`）

### 12.3 Dify Workflow

- [ ] Workflow A1（scene_word）— 6 个节点
- [ ] Workflow A2（word_card）— 4 个节点
- [ ] Workflow A3（quiz）— 4 个节点
- [ ] Workflow B（媒体生产）— 6 个节点
- [ ] 串联逻辑：A 输出 → B 输入

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
| partial_dto | Workflow A 输出的半成品（缺 audio/video） |
| final_dto | Workflow B 输出的完整 DTO |
| Dify | AI 应用开发平台，提供 Workflow 编排 |
| TTS | Text-to-Speech，文本转语音 |
| CET4/CET6 | 大学英语四六级 |
| FFmpeg | 开源音视频处理工具 |
| Structured Output | LLM 按预定义 JSON Schema 输出，保证格式一致性 |
| discriminated union | TypeScript 通过共有的字面量字段区分联合类型的不同分支 |
