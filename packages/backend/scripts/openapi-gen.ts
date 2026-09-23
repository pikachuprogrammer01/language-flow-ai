/**
 * openapi.json 生成脚本 — pnpm openapi:gen
 * 导入完整应用（全部路由注册后）取 getOpenAPIDocument() 落盘，与 GET /doc 共用
 * lib/api-convention.ts 的 OPENAPI_DOC_BASE，文档元信息永不漂移；
 * PORT=0 随机端口规避与运行中 dev server 的 8080 冲突（import 即启动，写完即退出）
 * 用法：tsx scripts/openapi-gen.ts（lefthook pre-commit 在 backend 路由变更时自动执行）
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { OPENAPI_DOC_BASE } from "../src/lib/api-convention";

// 文档生成不执行任何查询：db 池懒建连，无 .env / MySQL 离线环境（如 Docker 构建）用占位串即可
process.env.DATABASE_URL ??= "mysql://docgen:docgen@localhost:3306/docgen";
process.env.PORT = "0";

const { default: app } = await import("../src/index");

const outPath = join(import.meta.dirname, "../src/openapi.json");
writeFileSync(outPath, JSON.stringify(app.getOpenAPIDocument(OPENAPI_DOC_BASE), null, 2));
console.log(`[openapi:gen] written ${outPath}`);
process.exit(0);
