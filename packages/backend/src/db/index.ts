import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";
import { logger } from "../lib/logger";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set");
}

/**
 * 生产库护栏（docs/12 §二）：回环 :3306 = 生产栈 MySQL（跑老版本镜像 + 生产数据），
 * 开发/测试的一切换库应连测试栈 :3307。命中回环 3306 时：服务启动仅告警（不阻断 openapi:gen
 * 等只导入不连库的脚本），写操作（migrate / seed）必须 DB_ALLOW_PROD=1 显式放行。
 * 容器内 DATABASE_URL 主机名是服务名 mysql，不受影响。
 */
const LOOPBACK_PROD_DB = /^mysql:\/\/[^@]*@(?:localhost|127\.0\.0\.1|\[::1\]):3306\//;
const targetsProdDb = LOOPBACK_PROD_DB.test(databaseUrl);
const prodDbAllowed = process.env.DB_ALLOW_PROD === "1";

if (targetsProdDb && !prodDbAllowed) {
  logger.warn(
    { databaseUrl: databaseUrl.replace(/\/\/[^@]*@/, "//***@") },
    "DATABASE_URL 指向生产库（回环 :3306），本地开发应连测试库 :3307；写操作会被拦截，确需操作生产库请设 DB_ALLOW_PROD=1",
  );
}

/** 写库脚本入口守卫：目标是生产库且未显式放行则中止（不建连、不改一行数据） */
export function requireSafeWriteTarget(action: string): void {
  if (targetsProdDb && !prodDbAllowed) {
    throw new Error(
      `${action} 的目标是生产库（回环 :3306）。开发期请连测试库 :3307；确需对生产库执行请显式设 DB_ALLOW_PROD=1（生产迁移通常由发布流程在容器内完成）`,
    );
  }
}

// createPool 懒建连（首次查询才连接）：文档生成脚本 openapi:gen / 覆盖度测试导入路由时不要求 MySQL 在线；
// MySQL 重启后旧连接失效由池自愈（connectionLimit 小池 + 自动重连）
export const pool = mysql.createPool(databaseUrl);

export const db = drizzle(pool);

logger.info("Database pool initialized");
