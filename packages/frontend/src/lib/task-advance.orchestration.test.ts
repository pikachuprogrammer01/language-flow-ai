/**
 * 「继续生产」编排单测 — advanceTask 的产物判定/音色透传/回写口径（mock API 层）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api/client";
import { advanceTask } from "./task-advance";

vi.mock("../api/client", () => ({
  getTask: vi.fn(),
  renderVideo: vi.fn(),
  synthesizeFromContent: vi.fn(),
  updateTask: vi.fn(),
}));

const AUDIO = { url: "/files/audio/a.mp3", duration: 8, format: "mp3" };
const VIDEO = { url: "/files/video/v.mp4", duration: 10, format: "mp4" };

beforeEach(() => {
  vi.mocked(api.getTask).mockReset();
  vi.mocked(api.renderVideo).mockReset();
  vi.mocked(api.synthesizeFromContent).mockReset();
  vi.mocked(api.updateTask).mockReset();
  vi.mocked(api.renderVideo).mockResolvedValue(VIDEO as never);
  vi.mocked(api.updateTask).mockResolvedValue({} as never);
});

describe("advanceTask", () => {
  it("audio_ready（已有配音）：只渲染，不重复合成，回写 completed", async () => {
    vi.mocked(api.getTask).mockResolvedValue({
      id: "t1",
      template: "scene_word",
      content: [{ text: "a", words: [] }],
      audio: AUDIO,
    } as never);
    const result = await advanceTask("t1");
    expect(result.action).toBe("render");
    expect(api.synthesizeFromContent).not.toHaveBeenCalled();
    expect(api.updateTask).toHaveBeenCalledWith("t1", {
      audio: AUDIO,
      video: VIDEO,
      status: "completed",
    });
    expect(result.videoUrl).toBe(VIDEO.url);
  });

  it("content_ready（无配音）：先合成再渲染，透传记录规范音色", async () => {
    vi.mocked(api.getTask).mockResolvedValue({
      id: "t2",
      template: "quiz",
      title: "标题",
      voice: { id: "zh-CN-XiaoyiNeural" },
      content: [{ stem: "s", options: ["a", "b", "c", "d"], correctIndex: 0, explanation: "e" }],
    } as never);
    vi.mocked(api.synthesizeFromContent).mockResolvedValue(AUDIO as never);
    const result = await advanceTask("t2");
    expect(result.action).toBe("tts-then-render");
    expect(api.synthesizeFromContent).toHaveBeenCalledWith(
      "quiz",
      expect.any(Array),
      "标题",
      "zh-CN-XiaoyiNeural",
    );
    expect(api.renderVideo).toHaveBeenCalledWith(expect.objectContaining({ audio: AUDIO }));
  });

  it("无内容记录：抛可读错误且不触发渲染", async () => {
    vi.mocked(api.getTask).mockResolvedValue({
      id: "t3",
      template: "scene_word",
      content: [],
    } as never);
    await expect(advanceTask("t3")).rejects.toThrow("没有生成内容");
    expect(api.renderVideo).not.toHaveBeenCalled();
  });

  it("渲染失败：不回写 completed（状态留在原处可重试）", async () => {
    vi.mocked(api.getTask).mockResolvedValue({
      id: "t4",
      template: "scene_word",
      content: [{ text: "a", words: [] }],
      audio: AUDIO,
    } as never);
    vi.mocked(api.renderVideo).mockRejectedValue(new Error("render boom"));
    await expect(advanceTask("t4")).rejects.toThrow("render boom");
    expect(api.updateTask).not.toHaveBeenCalled();
  });
});
