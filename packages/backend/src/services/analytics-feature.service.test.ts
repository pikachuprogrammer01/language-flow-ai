/**
 * analytics-feature.service 纯函数测试 — 生产特征提取 / 人工标签合并 / taxonomy 校验
 * 覆盖需求 §五A：生产数据直取不靠 AI 猜测；人工字段重算不丢失；未留痕字段保持 null
 */
import { describe, expect, it, vi } from "vitest";
import {
  extractProductionFeature,
  mergeFeatureRow,
  validateManualPatch,
} from "./analytics-feature.service";

// 纯函数用例不连库；服务模块导入时的池初始化按现有惯例 mock
vi.mock("../db", () => ({ db: {} }));

type ContentRow = Parameters<typeof extractProductionFeature>[0];

function contentRow(over: Partial<ContentRow> = {}): ContentRow {
  return {
    id: "cnt_20260920_abc123",
    template: "scene_word",
    title: "咖啡店英语",
    level: "CET4",
    targetDuration: 60,
    content: [
      { text: "a", words: [] },
      { text: "b", words: [] },
      { text: "c", words: [] },
    ],
    words: [{ word: "Latte" }, { word: "latte" }, { word: "mocha" }],
    style: { background: "white", bgm: "/files/bgm/a.mp3", introTopic: "旅行" },
    voice: { id: "female_01" },
    audio: null,
    video: { url: "/files/video/x.mp4", duration: 33.5, introStatus: "rendered" },
    status: "completed",
    createdAt: new Date(),
    updatedAt: new Date(),
    audit: null,
    ...over,
  } as ContentRow;
}

describe("extractProductionFeature", () => {
  it("scene_word：段数/去重词数/镜头数（含片头）/时长与语速默认", () => {
    const f = extractProductionFeature(contentRow());
    expect(f.template).toBe("scene_word");
    expect(f.duration).toBe(33.5);
    expect(f.knowledgePointCount).toBe(2); // Latte/latte 去重
    expect(f.segmentCount).toBe(3);
    expect(f.dialogueCount).toBe(3);
    expect(f.shotCount).toBe(4); // 片头 rendered + 3 段
    expect(f.speechRate).toBe(1); // VoiceConfig.speed 契约默认
    expect(f.voiceId).toBe("female_01");
    expect(f.bgm).toBe("/files/bgm/a.mp3");
    expect(f.introEffect).toBe(1);
    expect(f.introTopic).toBe("旅行");
    expect(f.subtitleType).toBe("burned_in");
  });

  it("未留痕字段保持 null，不做猜测（prompt/renderer 版本、人物数不在提取内）", () => {
    const f = extractProductionFeature(contentRow());
    expect(f.promptVersion).toBeNull();
    expect(f.rendererVersion).toBeNull();
  });

  it("片头关闭：introStatus=disabled → introEffect=0，镜头数不含片头", () => {
    const f = extractProductionFeature(
      contentRow({ video: { duration: 30, introStatus: "disabled" } as never }),
    );
    expect(f.introEffect).toBe(0);
    expect(f.shotCount).toBe(3);
  });

  it("无成片时回退配音时长；word_card 不具备台词语义 → dialogueCount null", () => {
    const f = extractProductionFeature(
      contentRow({
        template: "word_card",
        video: null,
        audio: { url: "/files/audio/a.mp3", duration: 20, format: "mp3" } as never,
        content: [{ word: "a" }, { word: "b" }],
        words: [],
      }),
    );
    expect(f.duration).toBe(20);
    expect(f.dialogueCount).toBeNull();
    expect(f.segmentCount).toBe(2);
    expect(f.shotCount).toBe(2);
    expect(f.introEffect).toBeNull();
    expect(f.knowledgePointCount).toBe(0);
  });
});

type FeatureRow = Parameters<typeof mergeFeatureRow>[0];

function existingRow(over: Partial<FeatureRow> = {}): FeatureRow {
  return {
    contentId: "cnt_20260920_abc123",
    template: "scene_word",
    level: "CET4",
    duration: 1,
    knowledgePointCount: 1,
    characterCount: 2,
    dialogueCount: 1,
    segmentCount: 1,
    speechRate: 1,
    voiceId: "old",
    bgm: null,
    subtitleType: null,
    shotCount: 1,
    introEffect: null,
    introTopic: null,
    promptVersion: null,
    rendererVersion: null,
    scene: "hotel",
    hook: "mistake",
    contentFormat: null,
    emotion: null,
    ctaType: null,
    ctaStartTime: null,
    fieldSources: { scene: "USER_INPUT", hook: "AI_EXTRACTED" },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as FeatureRow;
}

describe("mergeFeatureRow", () => {
  it("人工/已提取标签保留，生产字段一律重算覆盖", () => {
    const merged = mergeFeatureRow(existingRow(), "cnt_20260920_abc123", {
      template: "scene_word",
      level: "CET4",
      duration: 42,
      voiceId: "new",
    } as never);
    expect(merged.duration).toBe(42);
    expect(merged.voiceId).toBe("new");
    expect(merged.scene).toBe("hotel");
    expect(merged.hook).toBe("mistake");
    const sources = merged.fieldSources as Record<string, string>;
    expect(sources.scene).toBe("USER_INPUT");
    expect(sources.hook).toBe("AI_EXTRACTED");
    expect(sources.duration).toBe("PLATFORM_PRODUCTION");
  });

  it("首次落库无既有行：全部字段标记 PLATFORM_PRODUCTION，人工字段保持 null", () => {
    const merged = mergeFeatureRow(undefined, "cnt_x", {
      template: "quiz",
      level: "CET6",
      duration: null,
    } as never);
    expect(merged.scene ?? null).toBeNull();
    const sources = merged.fieldSources as Record<string, string>;
    expect(sources.template).toBe("PLATFORM_PRODUCTION");
  });
});

describe("validateManualPatch", () => {
  it("taxonomy 白名单校验（不锁死可扩展，但拒绝脏值）", () => {
    expect(validateManualPatch({ scene: "restaurant", hook: "mistake" })).toEqual([]);
    const errors = validateManualPatch({ scene: "深空科幻" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("不在标签体系内");
  });

  it("null 表示清空不校验；ctaStartTime 拒绝负值", () => {
    expect(validateManualPatch({ hook: null, emotion: null })).toEqual([]);
    expect(validateManualPatch({ ctaStartTime: -1 })).toHaveLength(1);
  });
});
