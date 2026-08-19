/**
 * 上传标记 ↔ 任务关联工具
 * 标记按任务归属（task_id）保证一致性：重新渲染后视频文件名变化，标记仍挂在任务上
 */
import { db } from "./index";
import { contents } from "./schema";

/**
 * 按视频文件名反查任务 id（匹配 contents.video.url 的 basename）
 * 用于：标记创建时绑定 task_id；迁移回填历史标记
 */
export async function resolveTaskIdByVideoFilename(videoFilename: string): Promise<string | null> {
  const rows = await db.select({ id: contents.id, video: contents.video }).from(contents);
  for (const r of rows) {
    if (
      r.video &&
      typeof r.video === "object" &&
      "url" in r.video &&
      typeof r.video.url === "string" &&
      r.video.url.split("/").pop() === videoFilename
    ) {
      return r.id;
    }
  }
  return null;
}
