import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "../db";
import { contents } from "../db/schema";
import { videoAnalyticsRoute } from "./video-analytics";

vi.mock("../db", () => ({ db: {} }));

// 音色/BGM 目录模块：白名单取真实语义（不含 legacy）；BGM 目录文件不存在（fs 语义）——
// “未变更遗留值放行”的判定在 handler 内完成，与 fs 无关。
const { VALID_VOICES } = vi.hoisted(() => ({
  VALID_VOICES: new Set(["zh-CN-XiaoxiaoNeural", "zh-CN-XiaoyiNeural", "zh-CN-YunxiNeural"]),
}));
vi.mock("../lib/tts-catalog", () => ({
  allVoiceIds: () => [...VALID_VOICES],
  isVoiceAllowed: (voice: string) => VALID_VOICES.has(voice),
  // 真实语义：null/空串 = 无 BGM 允许；非空在测试环境无对应素材文件 → 拒绝
  isBgmAllowed: (ref: string | null | undefined) => ref === null || ref === undefined || ref === "",
  listBgmFiles: () => [],
}));

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
  it("returns canonical task metadata with no topic override (display follows contents.title)", async () => {
    const response = await videoAnalyticsRoute.request("/cnt_analytics_001");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      // 无 video_analytics 行 → 覆盖值为 null；生成入参主题「原始主题」不得冒充标题
      storyTopic: null,
      voice: "voice-old",
      bgm: "/files/bgm/old.mp3",
      duration: 12.5,
      allowSave: true,
    });
  });

  it("does not echo the generated title as an override (would freeze it on next save)", async () => {
    state.analytics = [
      {
        contentId: "cnt_analytics_001",
        storyTopic: null,
        publishAt: null,
        coverUrl: null,
        allowSave: 0,
        customParams: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const single = await videoAnalyticsRoute.request("/cnt_analytics_001");
    await expect(single.json()).resolves.toMatchObject({ storyTopic: null });

    const batch = await videoAnalyticsRoute.request("/?ids=cnt_analytics_001");
    await expect(batch.json()).resolves.toEqual([expect.objectContaining({ storyTopic: null })]);
  });

  it("treats an empty-string snapshot as no override", async () => {
    state.analytics = [
      {
        contentId: "cnt_analytics_001",
        storyTopic: "",
        publishAt: null,
        coverUrl: null,
        allowSave: 0,
        customParams: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const response = await videoAnalyticsRoute.request("/cnt_analytics_001");
    await expect(response.json()).resolves.toMatchObject({ storyTopic: null });
  });

  it("returns batch metadata in requested order and skips missing content", async () => {
    state.contents.push({ ...state.contents[0], id: "cnt_analytics_002", title: "第二条" });
    const response = await videoAnalyticsRoute.request(
      "/?ids=cnt_analytics_002,cnt_missing,cnt_analytics_001",
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      expect.objectContaining({ contentId: "cnt_analytics_002", storyTopic: null }),
      expect.objectContaining({ contentId: "cnt_analytics_001", storyTopic: null }),
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

  it("lets a legacy voice pass through unchanged so other fields remain editable (smoke-test regression)", async () => {
    const response = await videoAnalyticsRoute.request("/cnt_analytics_001", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        storyTopic: "只改主题",
        voice: "voice-old",
        bgm: "/files/bgm/old.mp3",
      }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ storyTopic: "只改主题" });
    expect(state.analytics).toHaveLength(1);
    expect(state.contents[0].voice.id).toBe("voice-old");
  });

  it("rejects a NEW voice outside the catalog even when legacy value exists", async () => {
    const response = await videoAnalyticsRoute.request("/cnt_analytics_001", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ voice: "brand-new-voice" }),
    });
    expect(response.status).toBe(400);
  });

  it("rejects changed bgm that is not an existing material file", async () => {
    const response = await videoAnalyticsRoute.request("/cnt_analytics_001", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bgm: "/files/bgm/does-not-exist.mp3" }),
    });
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("BGM_NOT_ALLOWED");
  });
});
