import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db";
import { contents } from "../db/schema";
import { videoAnalyticsRoute } from "./video-analytics";

vi.mock("../db", () => ({ db: {} }));

type ContentRow = {
  id: string;
  template: "scene_word" | "word_card" | "quiz";
  title: string;
  targetDuration: number;
  style: Record<string, unknown>;
  voice: Record<string, unknown>;
  video: Record<string, unknown> | null;
  audio: Record<string, unknown> | null;
  audit: Record<string, unknown> | null;
};

type AnalyticsRow = {
  contentId: string;
  storyTopic: string | null;
  publishAt: Date | null;
  coverUrl: string | null;
  allowSave: number;
  customParams: unknown;
  createdAt: Date;
  updatedAt: Date;
};

const state: { contents: ContentRow[]; analytics: AnalyticsRow[] } = {
  contents: [],
  analytics: [],
};
let failAnalyticsUpsert = false;

function installFakeDb(): void {
  const insert = () => ({
    values: (value: AnalyticsRow) => ({
      onDuplicateKeyUpdate: async ({ set }: { set: Partial<AnalyticsRow> }) => {
        if (failAnalyticsUpsert) throw new Error("analytics write failed");
        const existing = state.analytics.find((row) => row.contentId === value.contentId);
        if (existing) Object.assign(existing, set);
        else state.analytics.push(value);
      },
    }),
  });
  const update = (table: unknown) => ({
    set: (patch: Partial<ContentRow> & Partial<AnalyticsRow>) => ({
      where: async () => {
        const target = table === contents ? state.contents[0] : state.analytics[0];
        if (target) Object.assign(target, patch);
      },
    }),
  });
  Object.assign(db, {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const rows = () => (table === contents ? state.contents : state.analytics);
          // 链式 no-op：真实 Drizzle 的 .limit()/.for('update') 均返回可 await 的同一 builder
          const builder: Record<string, unknown> = {
            limit: () => builder,
            for: () => builder,
            // biome-ignore lint/suspicious/noThenProperty: 模拟 thenable builder
            then: (resolve: (value: unknown[]) => void, reject: (reason?: unknown) => void) =>
              Promise.resolve(rows()).then(resolve, reject),
          };
          return builder;
        },
      }),
    }),
    insert,
    update: (table: unknown) => update(table),
  });
  Object.assign(db, {
    transaction: async (callback: (tx: typeof db) => unknown) => {
      const contentsSnapshot = structuredClone(state.contents);
      const analyticsSnapshot = structuredClone(state.analytics);
      try {
        return await callback(db);
      } catch (error) {
        state.contents = contentsSnapshot;
        state.analytics = analyticsSnapshot;
        throw error;
      }
    },
  });
}

beforeEach(() => {
  state.contents = [
    {
      id: "cnt_analytics_001",
      template: "scene_word",
      title: "森林探险",
      targetDuration: 60,
      style: { background: "white", bgm: "/files/bgm/old.mp3" },
      voice: { id: "voice-old", speed: 1 },
      video: { duration: 12.5 },
      audio: null,
      audit: { input: { topic: "原始主题" } },
    },
  ];
  state.analytics = [];
  failAnalyticsUpsert = false;
  installFakeDb();
});

describe("video analytics routes", () => {
  it("returns canonical task metadata and topic fallback", async () => {
    const response = await videoAnalyticsRoute.request("/cnt_analytics_001");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      storyTopic: "原始主题",
      voice: "voice-old",
      bgm: "/files/bgm/old.mp3",
      duration: 12.5,
      allowSave: true,
    });
  });

  it("returns batch metadata in requested order and skips missing content", async () => {
    state.contents.push({ ...state.contents[0], id: "cnt_analytics_002", title: "第二条" });
    const response = await videoAnalyticsRoute.request(
      "/?ids=cnt_analytics_002,cnt_missing,cnt_analytics_001",
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      expect.objectContaining({ contentId: "cnt_analytics_002", storyTopic: "原始主题" }),
      expect.objectContaining({ contentId: "cnt_analytics_001", storyTopic: "原始主题" }),
    ]);
  });

  it("rejects more than 100 batch IDs", async () => {
    const ids = Array.from({ length: 101 }, (_, index) => `cnt_${index}`);
    const response = await videoAnalyticsRoute.request(`/?ids=${ids.join(",")}`);
    expect(response.status).toBe(400);
  });

  it("creates and updates analytics while syncing voice/style", async () => {
    const body = {
      storyTopic: "新主题",
      voice: "zh-CN-XiaoyiNeural",
      bgm: null,
      allowSave: false,
      coverUrl: "https://example.com/cover.png",
      customParams: [{ key: "caption", label: "发布文案", type: "text", value: "hello" }],
    };
    const first = await videoAnalyticsRoute.request("/cnt_analytics_001", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      storyTopic: "新主题",
      voice: "zh-CN-XiaoyiNeural",
      bgm: null,
      allowSave: false,
    });
    expect(state.contents[0].voice.id).toBe("zh-CN-XiaoyiNeural");
    expect(state.contents[0].style.bgm).toBeUndefined();
    expect(state.analytics).toHaveLength(1);

    const second = await videoAnalyticsRoute.request("/cnt_analytics_001", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publishAt: null, customParams: null }),
    });
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      publishAt: null,
      customParams: [],
      allowSave: false,
    });
  });

  it("does not leave canonical settings changed when analytics write fails", async () => {
    failAnalyticsUpsert = true;
    const response = await videoAnalyticsRoute.request("/cnt_analytics_001", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ voice: "zh-CN-YunxiNeural" }),
    });
    expect(response.status).toBe(500);
    expect(state.contents[0].voice.id).toBe("voice-old");
    expect(state.analytics).toHaveLength(0);
  });

  it("handles concurrent first writes as one analytics record", async () => {
    const responses = await Promise.all(
      ["zh-CN-XiaoxiaoNeural", "zh-CN-YunxiNeural"].map((voice) =>
        videoAnalyticsRoute.request("/cnt_analytics_001", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ voice }),
        }),
      ),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(state.analytics).toHaveLength(1);
  });

  it("rejects invalid dates and missing content", async () => {
    const invalid = await videoAnalyticsRoute.request("/cnt_analytics_001", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publishAt: "not-a-date" }),
    });
    expect(invalid.status).toBe(400);

    const invalidParam = await videoAnalyticsRoute.request("/cnt_analytics_001", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customParams: [{ key: "x", label: "x", type: "video", value: "x" }] }),
    });
    expect(invalidParam.status).toBe(400);

    const oversizedParam = await videoAnalyticsRoute.request("/cnt_analytics_001", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customParams: [{ key: "x", label: "x", type: "text", value: "x".repeat(2001) }],
      }),
    });
    expect(oversizedParam.status).toBe(400);

    state.contents = [];
    const missing = await videoAnalyticsRoute.request("/cnt_missing");
    expect(missing.status).toBe(404);
  });

  it("rejects unknown voice with structured error and no canonical write", async () => {
    const response = await videoAnalyticsRoute.request("/cnt_analytics_001", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ voice: "not-a-real-voice" }),
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as {
      error: { code: string; field?: string; hint?: string };
    };
    expect(payload.error.code).toBe("VOICE_NOT_ALLOWED");
    expect(payload.error.field).toBe("voice");
    expect(payload.error.hint).toContain("/api/tts/voices");
    expect(state.contents[0].voice.id).toBe("voice-old");
  });
});
