/**
 * 「继续生产」编排 — 把 content_ready / audio_ready / failed 记录推进到 completed
 * 决策是纯函数 planAdvance（有音频产物 → 直接渲染；无 → 先合成再渲染），
 * 副作用集中在 advanceTask 一处；组装口径与详情页 revoice 同源（style 透传、completed 回写）
 */
import {
  type RenderVideoInput,
  getTask,
  renderVideo,
  synthesizeFromContent,
  updateTask,
} from "../api/client";

type TemplateId = "scene_word" | "word_card" | "quiz";

interface AudioInfo {
  url: string;
  duration: number;
  format: string;
}

export type AdvanceAction = "render" | "tts-then-render";

/** 音频产物判定（宽松记录 → 结构收窄，避免 any） */
export function hasAudioInfo(a: unknown): a is AudioInfo {
  return (
    !!a &&
    typeof a === "object" &&
    typeof (a as { url?: unknown }).url === "string" &&
    typeof (a as { duration?: unknown }).duration === "number"
  );
}

/** 推进决策（纯函数）：配音完成 → 只差渲染；内容就绪/失败无音频 → 先配音再渲染 */
export function planAdvance(task: { audio?: unknown }): AdvanceAction {
  return hasAudioInfo(task.audio) ? "render" : "tts-then-render";
}

/** 可推进状态（列表按钮可见性口径：已完成/进行中不出现推进入口） */
export const ADVANCEABLE_STATUSES = ["content_ready", "audio_ready", "failed"];

export function canAdvance(status: string): boolean {
  return ADVANCEABLE_STATUSES.includes(status);
}

/** 执行一条记录的推进并回写 completed；返回本次实际动作与视频 URL */
export async function advanceTask(
  id: string,
): Promise<{ action: AdvanceAction; videoUrl: string }> {
  const task = (await getTask(id)) as Record<string, unknown>;
  const content = Array.isArray(task.content) ? (task.content as Record<string, unknown>[]) : [];
  if (content.length === 0) throw new Error("记录没有生成内容，无法继续生产");
  const template: TemplateId =
    task.template === "word_card" || task.template === "quiz" ? task.template : "scene_word";
  const action = planAdvance(task);
  // 配音用记录归属的规范音色（缺省由后端按默认音色合成），语速走默认 1.0
  const voiceId = (task.voice as { id?: unknown } | undefined)?.id;
  const audioInfo: AudioInfo = hasAudioInfo(task.audio)
    ? task.audio
    : await synthesizeFromContent(
        template,
        content,
        String(task.title ?? ""),
        typeof voiceId === "string" && voiceId ? voiceId : undefined,
      );
  const dto: RenderVideoInput = {
    ...task,
    template,
    content,
    audio: audioInfo,
    style: { ...((task.style as Record<string, unknown> | undefined) ?? {}) },
  };
  const video = await renderVideo(dto);
  await updateTask(id, { audio: audioInfo, video, status: "completed" });
  return { action, videoUrl: video.url };
}
