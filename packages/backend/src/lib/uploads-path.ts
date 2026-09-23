/**
 * 上传资产根目录 — 全站唯一解析入口
 * 可用环境变量 UPLOADS_DIR 覆盖：测试环境指向独立目录（如 ~/language-flow-uploads-test），
 * 与生产文件资产彻底隔离（数据库隔离由 DATABASE_URL 承担）。
 */
import { join } from "node:path";

export const UPLOADS_DIR =
  process.env.UPLOADS_DIR?.trim() || join(import.meta.dirname, "../../uploads");
