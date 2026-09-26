import { createRequire } from "node:module";
import { dirname } from "node:path";
/**
 * API 文档可视化层（docs/16 §三）— 自托管 Swagger UI（离线可用，不依赖 CDN）
 *
 * - GET /doc      → OpenAPI 3.1 JSON（app.doc 提供，见 index.ts）
 * - GET /doc/     → Swagger UI 浏览/调试页（本地 swagger-ui-dist 资源 + 「返回管理界面」按钮）
 * - /swagger-ui/* → 本地静态资源（css/js，从 node_modules/swagger-ui-dist 提供）
 *
 * 采用本地资源而非 @hono/swagger-ui 的 CDN 渲染：项目本地/离线优先，Docker 运行时亦无外网保证。
 */
import { serveStatic } from "@hono/node-server/serve-static";
import type { OpenAPIHono } from "@hono/zod-openapi";

// swagger-ui-dist 无类型声明且主入口会拉入遥测副作用：仅用 createRequire 解析其资源目录（包无 exports 字段，子路径按文件解析）
const SWAGGER_UI_DIR = dirname(
  createRequire(import.meta.url).resolve("swagger-ui-dist/swagger-ui-bundle.js"),
);

/** Swagger UI 页面：加载本地资源，url 指向 /doc，右上角注入「返回管理界面」导航 */
function renderDocsHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>LanguageFlow AI · API 文档</title>
    <link rel="stylesheet" href="/swagger-ui/swagger-ui.css" />
    <style>
      body { margin: 0; }
      .lf-back {
        position: fixed; top: 12px; right: 16px; z-index: 9999;
        padding: 8px 16px; background: #2882f6; color: #fff;
        border-radius: 6px; font-size: 14px; text-decoration: none;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
      }
      .lf-back:hover { background: #1a6fd6; }
    </style>
  </head>
  <body>
    <a class="lf-back" href="/">← 返回管理界面</a>
    <div id="swagger-ui"></div>
    <script src="/swagger-ui/swagger-ui-bundle.js" crossorigin></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: "/doc",
        dom_id: "#swagger-ui",
        deepLinking: true,
        tryItOutEnabled: true,
        persistAuthorization: true,
      });
    </script>
  </body>
</html>`;
}

/** 挂载文档相关路由：本地静态资源 + /doc/ HTML 页（/doc JSON 由 index.ts 的 app.doc 提供） */
export function registerApiDocs(app: OpenAPIHono): void {
  app.use(
    "/swagger-ui/*",
    serveStatic({
      root: SWAGGER_UI_DIR,
      rewriteRequestPath: (path) => path.replace(/^\/swagger-ui/, ""),
    }),
  );
  app.get("/doc/", (c) => c.html(renderDocsHtml()));
}
