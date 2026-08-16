/**
 * POST /api/video/render 测试
 * 覆盖：三模板合法请求 200 / 缺 audio 400 / 非法 template 400 / content 结构错 400
 *       / content 空 400 / 非 JSON 400 / 渲染失败 500
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as videoService from "../services/video.service";
import { video } from "./video";

vi.mock("../services/video.service", () => ({
  renderVideo: vi.fn(),
}));

const renderVideoMock = vi.mocked(videoService.renderVideo);

const BASE_DTO = {
  id: "cnt_20260728_000001",
  template: "scene_word",
  title: "四级核心词汇",
  level: "CET4",
  targetDuration: 12,
  words: [{ word: "contract", meaning: "合同", level: "CET4" }],
  style: { background: "white" },
  voice: { id: "female_01" },
  audio: { url: "/files/audio/abc.mp3", duration: 12, format: "mp3" },
  status: "audio_ready",
  createdAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
};

const CONTENT: Record<string, unknown> = {
  scene_word: [
    {
      text: "This is a contract example.",
      words: [{ word: "contract", meaning: "合同", level: "CET4" }],
    },
  ],
  word_card: [
    {
      word: "contract",
      pos: "n.",
      meaning: "合同",
      example: "They signed a contract.",
      exampleMeaning: "他们签了合同。",
    },
  ],
  quiz: [
    {
      stem: "contract 的意思是？",
      options: ["合同", "大陆", "取消", "分析"],
      correctIndex: 0,
      explanation: "contract 作名词意为合同。",
      word: { word: "contract", meaning: "合同", level: "CET4" },
    },
  ],
};

async function postRender(body: unknown): Promise<Response> {
  return video.request("/render", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  renderVideoMock.mockReset();
});

describe("POST /api/video/render", () => {
  it("scene_word 合法请求返回 200 与视频元数据", async () => {
    renderVideoMock.mockResolvedValue({
      url: "/files/video/v1.mp4",
      duration: 12,
      resolution: "1080x1920",
      format: "mp4",
      size: 1024,
    });
    const res = await postRender({ ...BASE_DTO, content: CONTENT.scene_word });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.video.url).toBe("/files/video/v1.mp4");
    expect(body.video.resolution).toBe("1080x1920");
    expect(renderVideoMock).toHaveBeenCalledTimes(1);
  });

  it("word_card 合法请求返回 200", async () => {
    renderVideoMock.mockResolvedValue({
      url: "/files/video/v2.mp4",
      duration: 12,
      resolution: "1080x1920",
      format: "mp4",
      size: 2048,
    });
    const res = await postRender({
      ...BASE_DTO,
      template: "word_card",
      content: CONTENT.word_card,
    });
    expect(res.status).toBe(200);
  });

  it("quiz 合法请求返回 200", async () => {
    renderVideoMock.mockResolvedValue({
      url: "/files/video/v3.mp4",
      duration: 12,
      resolution: "1080x1920",
      format: "mp4",
      size: 4096,
    });
    const res = await postRender({ ...BASE_DTO, template: "quiz", content: CONTENT.quiz });
    expect(res.status).toBe(200);
  });

  it("缺少 audio 返回 400", async () => {
    const { audio: _audio, ...withoutAudio } = BASE_DTO;
    const res = await postRender({ ...withoutAudio, content: CONTENT.scene_word });
    expect(res.status).toBe(400);
    expect(renderVideoMock).not.toHaveBeenCalled();
  });

  it("非法 template 返回 400", async () => {
    const res = await postRender({
      ...BASE_DTO,
      template: "flash_card",
      content: CONTENT.scene_word,
    });
    expect(res.status).toBe(400);
  });

  it("content 与 template 不匹配（scene_word 收到 quiz 结构）返回 400", async () => {
    const res = await postRender({ ...BASE_DTO, content: CONTENT.quiz });
    expect(res.status).toBe(400);
  });

  it("content 为空数组返回 400", async () => {
    const res = await postRender({ ...BASE_DTO, content: [] });
    expect(res.status).toBe(400);
  });

  it("非 JSON 请求体返回 400", async () => {
    const res = await video.request("/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  it("渲染失败返回 500", async () => {
    renderVideoMock.mockRejectedValue(new Error("ffmpeg failed"));
    const res = await postRender({ ...BASE_DTO, content: CONTENT.scene_word });
    expect(res.status).toBe(500);
  });
});
