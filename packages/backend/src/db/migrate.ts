/**
 * 迁移脚本（Docker 启动用，避免运行时依赖 drizzle-kit）
 * 运行：node dist/db/migrate.js
 * 行为：按 drizzle/meta/_journal.json 顺序执行未应用的迁移（幂等）
 */
import { join } from "node:path";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { db } from "./index";

async function main(): Promise<void> {
  await migrate(db, { migrationsFolder: join(import.meta.dirname, "../../drizzle") });
  process.exit(0);
}

main().catch((err) => {
  // biome-ignore lint/suspicious/noConsole: 迁移失败必须输出到 stdout/stderr（Docker 启动日志）
  console.error("migrate failed", err);
  process.exit(1);
});
