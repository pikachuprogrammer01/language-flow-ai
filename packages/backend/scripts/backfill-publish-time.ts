/**
 * 历史空发布时间回填（docs/22 §4.4）
 *
 * 只更新 publish_time IS NULL 的发布记录，用关联 contents.created_at 兜底并标
 * LOCAL_GENERATED；已有非空时间（人工填写或平台导入）一律不碰——它们的来处不可知，
 * 事后编一个 publish_time_source 比留 NULL 更坏。
 *
 * 默认 dry-run，先给出「空值多少 / 可回填多少 / 冲突多少」，`--apply` 才写库。
 * 幂等：回填后不再满足 IS NULL，第二次执行零变更。
 *
 * 用法（开发/测试库 :3307；目标为生产库时被 requireSafeWriteTarget 拦截）：
 *   pnpm --filter @ai-english/backend db:backfill:publish-time
 *   pnpm --filter @ai-english/backend db:backfill:publish-time -- --apply
 */
import { requireSafeWriteTarget } from "../src/db/index";
import { backfillMissingPublishTime } from "../src/services/analytics-metrics.service";

export async function main(apply: boolean): Promise<void> {
  console.log(apply ? "== APPLY 模式（写库）==" : "== DRY-RUN（加 -- --apply 才写库）==");
  if (apply) requireSafeWriteTarget("backfill-publish-time");
  const first = await backfillMissingPublishTime(apply);
  console.table(first);
  if (!apply) {
    console.log("未写入任何行。确认无误后加 -- --apply 执行。");
    return;
  }
  // 复跑一次自证幂等：回填后应零变更
  const second = await backfillMissingPublishTime(true);
  console.log("幂等复跑：", second);
  if (second.updated !== 0) {
    throw new Error(`回填不幂等：第二次仍更新 ${second.updated} 行，请检查 publish_time 写入路径`);
  }
}

if (process.argv[1]?.includes("backfill-publish-time")) {
  main(process.argv.includes("--apply"))
    .then(() => process.exit(0))
    .catch((e: unknown) => {
      console.error(e);
      process.exit(1);
    });
}
