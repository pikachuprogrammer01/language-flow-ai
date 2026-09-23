# 16 · API 接口规范与文档管理

> 版本：V1.0（2026-09-21）
> 适用范围：`packages/backend` 全部 HTTP 端点
> 真相来源：本文件 + `packages/backend/src/lib/api-convention.ts`（契约常量）+ `routes/openapi-coverage.test.ts`（可执行校验）

---

## 一、目标

1. 全后端 RESTful 接口遵循统一的路径命名 / HTTP 方法 / 状态码 / 错误格式规范；
2. OpenAPI 3.1 文档随代码自动生成、随提交自动更新，零手动维护；
3. 提供离线可用的可视化文档页（Swagger UI），并一键返回管理后台；
4. 以可执行门禁保证「代码端点 ⊆ 文档」永不遗漏，且与实现实时同步。

---

## 二、统一接口规范（MUST）

### 2.1 路径命名

```
✅ /api 下业务端点统一 kebab-case，资源用复数名词
   /api/cet/validate-words   /api/upload-marks   /api/video-analytics/{contentId}
✅ 非 CRUD 动作用子路径动词
   /batch-delete   /from-content   /render-settings   /overview
❌ 禁止 camelCase / snake_case / 大写：/api/videoAnalytics、/api/random_words
```

- 动态段用 `{param}`（OpenAPI）/ `:param`（Hono）书写，如 `/api/tasks/{id}`；
- 静态文件服务在 `/files/*`（非 `/api`），业务 API 一律在 `/api/*` 下。

### 2.2 HTTP 方法

| 方法 | 语义 |
|------|------|
| GET | 只读，无副作用（可缓存） |
| POST | 创建资源 / 触发动作（生成、合成、渲染、批量删除） |
| PUT | 整体替换（当前未使用，预留） |
| PATCH | 局部更新（更新任务字段、渲染设置、发布元数据） |
| DELETE | 删除资源 |

方法白名单在 `openapi-coverage.test.ts` 的 `HTTP_METHODS` 强制，越界即测试失败。

### 2.3 状态码

```
成功族：200 确定结果 · 201 已创建 · 204 无内容
客户端错：400 参数不合法 · 401 未认证 · 403 无权限 · 404 不存在 · 409 冲突 · 422 语义错 · 429 限流
服务端错：500 内部错误 · 501 依赖的本地能力缺席（如 Finder reveal）· 503 依赖服务不可用（如 LLM）
```

白名单在 `openapi-coverage.test.ts` 的 `ALLOWED_STATUS` 强制。

### 2.4 错误格式（统一信封）

非 2xx 响应统一为：

```jsonc
{ "error": "Not Found", "message": "路由不存在：GET /api/nope", "code": "NOT_FOUND" }
```

- `error`（必填，string）：错误标题，兼容存量契约；
- `message`（可选）：人类可读详情；
- `code`（可选）：机器可读错误码（大写下划线，如 `INTERNAL`）。

契约 schema 见 `api-convention.ts` 的 `apiErrorSchema`；全局 `onError` / `notFound` 中间件（`index.ts`）已按此信封输出。
新端点的结构化错误（附 `field/received/allowed/hint`）可复用 `lib/api-error.ts` 的 `apiError()`（DX-1 信封），与统一信封并存不破坏存量。

### 2.5 文档化要求（MUST）

所有端点必须经 `OpenAPIHono.openapi(createRoute(...))` 定义，且每个 `createRoute` 齐全：

- `tags`：取自 `API_TAGS`（中文分组，Swagger UI 按此归类）；
- `operationId`：全局唯一 camelCase（如 `validateWords`）；
- `summary`：一句话中文摘要；
- 每个响应含 `description`。

**禁止裸 `new Hono().get(...)` 定义业务端点**（会游离于文档体系）。健康检查、静态文件服务已作为例外纳入文档（`routes/health.ts` / `routes/files.ts`）。

新增端点推荐用 `buildApiRoute()` 归一化入参：自动补 `tags`/`operationId` 与统一错误信封，减少样板。

---

## 三、OpenAPI 自动生成与可视化

### 3.1 生成链路

```
@hono/zod-openapi 路由定义
        │  app.getOpenAPIDocument(OPENAPI_DOC_BASE)
        ▼
scripts/openapi-gen.ts  ──pnpm openapi:gen──▶  packages/backend/src/openapi.json（受版本控制）
        │
        ├─▶ openapi-typescript ──▶ 前端 src/api/schema.d.ts（openapi-fetch 类型安全）
        └─▶ GET /doc（实时 JSON）──▶ Swagger UI（GET /doc/）
```

- `OPENAPI_DOC_BASE`（`api-convention.ts`）是 `/doc` 实时页与落盘 `openapi.json` 的**共享元信息源**，二者永不漂移；
- 生成脚本设 `PORT=0` 随机端口 + `DATABASE_URL` 占位（db 池懒建连），故**无需 MySQL 在线、不与 dev server 抢端口**即可生成。

### 3.2 可视化层（Swagger UI，自托管）

`lib/api-docs.ts` 的 `registerApiDocs(app)`：

| 路由 | 内容 |
|------|------|
| `GET /doc` | OpenAPI 3.1 JSON（`app.doc`） |
| `GET /doc/` | Swagger UI 浏览/调试页 |
| `GET /swagger-ui/*` | 本地 swagger-ui-dist 静态资源（css/js） |

**为何自托管而非 CDN**：项目本地/离线优先，Docker 运行时无外网保证。资源从 `node_modules/swagger-ui-dist` 经 `serveStatic` 提供，完全离线可用。
文档页右上角固定「← 返回管理界面」链接指向 `/`，开发（`:8080/doc/`）与生产（nginx 反代同源）均可一键回主页。

生产经 nginx：`/doc` 反代后端，`/openapi.json` → 后端 `/doc`（供外部工具拉取）。见 `nginx.conf`。

---

## 四、完整性保障（覆盖度门禁）

`routes/openapi-coverage.test.ts` 以可执行测试强制：

1. **零遗漏**：代码注册的每条路由都出现在文档 paths 中（杜绝裸 Hono 端点）；
2. **无幽灵**：文档 ⊆ 代码注册路由（不文档化不存在的端点）；
3. **字段齐全**：每个 operation 有 summary/tags/operationId，每个响应有 description，状态码/方法在白名单内；
4. **operationId 唯一**；
5. **路径 kebab-case**；
6. **实时一致**：`GET /doc` 与代码 `getOpenAPIDocument()` 完全相等；
7. **文档页可用**：`GET /doc/` 返回含返回按钮的 Swagger UI。

> 文档自举路由（`/doc`、`/doc/`）不参与双向比对（`DOC_ROUTES` 排除）。

本地随时校验：`pnpm openapi:check`。

---

## 五、工作流整合

| 环节 | 触发 | 动作 |
|------|------|------|
| Git 提交 | `lefthook` pre-commit（`packages/backend/src/**` 变更） | `openapi:gen` 重生成 → `git add openapi.json` → 跑覆盖度门禁，违规拒绝提交 |
| Git 推送 | `lefthook` pre-push | `pnpm -r typecheck` + `pnpm -r test`（含覆盖度测试） |
| 前端构建 | `prebuild` | `openapi:gen` → `gen-api`（schema.d.ts 与后端对齐） |
| Docker 镜像 | `Dockerfile.frontend` | 构建前 `openapi:gen` 再校验兜底 |
| 本地预览 | `pnpm docs`（= backend dev） | 打开 http://localhost:8080/doc/ |

> 本仓库不使用远程 CI（2026-08-29 决策），质量门禁由 lefthook 本地 hooks 承担；覆盖度测试同时纳入 pre-push 全量测试。

---

## 六、新增 API 端点 SOP

1. 在 `routes/*.ts` 用 `OpenAPIHono.openapi()`（或 `buildApiRoute()`）定义，填 `tag`/`operationId`/`summary` 与各响应 `description`；
2. 非 2xx 用统一错误信封（`apiErrorSchema` / `apiError()`）；
3. 路径 kebab-case、方法/状态码在 §2 白名单内；
4. `pnpm openapi:gen` 刷新 `openapi.json`（提交时 lefthook 自动执行）；
5. `pnpm openapi:check` 确认覆盖度与规范通过；
6. 前端 `pnpm --filter frontend gen-api` 获得类型（或 typecheck 自动触发）。

无需手动维护任何文档清单——遗漏端点会被门禁测试拦下。
