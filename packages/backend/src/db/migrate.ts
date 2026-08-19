/**
 * 迁移脚本（Docker 启动用，避免运行时依赖 drizzle-kit）
 * 运行：node dist/db/migrate.js
 * 行为：按 drizzle/meta/_journal.json 顺序执行未应用的迁移（幂等）+ 历史标记回填 task_id
 */
import { join } from "node:path";
import { eq, isNull } from "drizzle-orm";
import { migrate } from "drizzle-orm/mysql2/migrator";
import { db } from "./index";
import { uploadMarks } from "./schema";
import { resolveTaskIdByVideoFilename } from "./upload-marks-helper";

/** 迁移后回填：历史标记（task_id 为空）按 videoFilename 反查任务并绑定（幂等） */
async function backfillUploadMarkTaskIds(): Promise<void> {
  const marks = await db
    .select({ id: uploadMarks.id, videoFilename: uploadMarks.videoFilename })
    .from(uploadMarks)
    .where(isNull(uploadMarks.taskId));
  for (const m of marks) {
    const taskId = await resolveTaskIdByVideoFilename(m.videoFilename);
    if (taskId) {
      await db.update(uploadMarks).set({ taskId }).where(eq(uploadMarks.id, m.id));
    }
  }
}

async function main(): Promise<void> {
  await migrate(db, { migrationsFolder: join(import.meta.dirname, "../../drizzle") });
  await backfillUploadMarkTaskIds();
  process.exit(0);
}

main().catch((err) => {
  // biome-ignore lint/suspicious/noConsole: 迁移失败必须输出到 stdout/stderr（Docker 启动日志）
  console.error("migrate failed", err);
  process.exit(1);
});
