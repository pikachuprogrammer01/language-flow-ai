/**
 * 上传标记索引 — TaskList/Files/AuditList/VideoList 共用
 * 一次全量拉取，双索引：byFilename（文件维度）+ byTaskId（任务维度）
 * 任务维度优先（task_id 关联）：重新渲染后文件名变化，标记仍按任务归属保持一致
 */
import { ref } from "vue";
import { type UploadMark, listUploadMarks } from "../api/client";

/** 从记录 video 字段提取文件名（结构收窄避免 any） */
function videoNameOf(t: { video?: unknown }): string | null {
  if (
    t.video &&
    typeof t.video === "object" &&
    "url" in t.video &&
    typeof t.video.url === "string"
  ) {
    return t.video.url.split("/").pop() ?? null;
  }
  return null;
}

export function useUploadMarks() {
  const marksByFile = ref<Record<string, UploadMark[]>>({});
  const marksByTask = ref<Record<string, UploadMark[]>>({});

  async function loadMarks(): Promise<void> {
    try {
      const marks = await listUploadMarks();
      const fileIndex: Record<string, UploadMark[]> = {};
      const taskIndex: Record<string, UploadMark[]> = {};
      for (const m of marks) {
        const fileList = fileIndex[m.videoFilename] ?? [];
        fileList.push(m);
        fileIndex[m.videoFilename] = fileList;
        if (m.taskId) {
          const taskList = taskIndex[m.taskId] ?? [];
          taskList.push(m);
          taskIndex[m.taskId] = taskList;
        }
      }
      marksByFile.value = fileIndex;
      marksByTask.value = taskIndex;
    } catch {
      // 标记加载失败不阻塞列表
    }
  }

  /** 按文件名取标记（Files 页用） */
  function marksOf(filename: string): UploadMark[] {
    return marksByFile.value[filename] ?? [];
  }

  /** 按任务取标记：优先 task_id 关联，回退文件名匹配（兼容历史/未绑定标记） */
  function marksOfTask(t: { id: string; video?: unknown }): UploadMark[] {
    const byTask = marksByTask.value[t.id];
    if (byTask?.length) return byTask;
    const name = videoNameOf(t);
    return name ? (marksByFile.value[name] ?? []) : [];
  }

  return { marksByFile, marksByTask, loadMarks, marksOf, marksOfTask };
}
