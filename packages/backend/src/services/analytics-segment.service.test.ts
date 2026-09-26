/**
 * analytics-segment.service 纯函数测试 — 段落时间轴派生（生产口径）
 * 纪律：无产物时长不派生（不猜）；片头事实 + 字符权重分配；总长守恒
 */
import { describe, expect, it, vi } from "vitest";
import { deriveSegments } from "./analytics-segment.service";

vi.mock("../db", () => ({ db: {} }));

type ContentRow = Parameters<typeof deriveSegments>[0];

function row(over: Partial<ContentRow>): ContentRow {
  return {
    id: "cnt_seg_test",
    template: "scene_word",
    title: "t",
    level: "CET4",
    targetDuration: 60,
    content: [
      { text: "a".repeat(60), words: [{ word: "alpha" }] },
      { text: "b".repeat(20), words: [{ word: "beta" }] },
    ],
    words: [],
    style: {},
    voice: {},
    audio: { url: "/files/audio/a.mp3", duration: 48, format: "mp3" },
    video: { url: "/files/video/v.mp4", duration: 48, format: "mp4", introStatus: "rendered" },
    status: "completed",
    createdAt: new Date(),
    updatedAt: new Date(),
    audit: null,
    ...over,
  } as unknown as ContentRow;
}

describe("deriveSegments", () => {
  it("scene_word 片头已渲染：intro 0~1s，正文从 1s 起按字符权重分配，总长守恒", () => {
    const segs = deriveSegments(row({}));
    expect(segs[0]).toMatchObject({ idx: 0, segmentType: "intro", startTime: 0, endTime: 1 });
    const body = segs.slice(1);
    expect(body[0]?.startTime).toBe(1);
    expect(body[0]?.segmentType).toBe("story_segment");
    expect(body[0]?.knowledgePoint).toBe("alpha");
    // 60:20 权重 → 第一段显著更长
    const d0 = (body[0]?.endTime ?? 0) - (body[0]?.startTime ?? 0);
    const d1 = (body[1]?.endTime ?? 0) - (body[1]?.startTime ?? 0);
    expect(d0).toBeGreaterThan(d1 * 2);
    // 末段终点 = 总时长（舍入到 0.1s）
    expect(body[body.length - 1]?.endTime).toBeCloseTo(48, 1);
  });

  it("片头未启用：无 intro 段，正文从 0s 起", () => {
    const segs = deriveSegments(
      row({ video: { url: "/files/video/v.mp4", duration: 48, format: "mp4" } as never }),
    );
    expect(segs[0]?.segmentType).toBe("story_segment");
    expect(segs[0]?.startTime).toBe(0);
    expect(segs).toHaveLength(2);
  });

  it("word_card / quiz 使用各自段类型；无成片时回退配音时长", () => {
    const cards = deriveSegments(
      row({
        template: "word_card",
        content: [{ word: "deadline", meaning: "n.截止", example: "The deadline." }],
      }),
    );
    expect(cards[0]?.segmentType).toBe("word_card");
    expect(cards[0]?.knowledgePoint).toBe("deadline");
    const quiz = deriveSegments(
      row({
        template: "quiz",
        video: null,
        content: [{ stem: "选择正确项", options: ["a", "b"], word: { word: "abandon" } }],
      }),
    );
    expect(quiz[0]?.segmentType).toBe("quiz_question");
    expect(quiz[0]?.knowledgePoint).toBe("abandon");
    expect(quiz[0]?.endTime).toBeCloseTo(48, 1); // 回退 audio.duration
  });

  it("无产物时长或无内容 → 不派生（空数组，绝不猜测）", () => {
    expect(deriveSegments(row({ video: null, audio: null }))).toEqual([]);
    expect(deriveSegments(row({ content: [] }))).toEqual([]);
  });
});
