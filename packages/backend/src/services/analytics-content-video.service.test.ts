/**
 * 统一内容主视图纯函数用例（docs/22 §3 不变量 / §5.1）
 *
 * 钉住四件真会出错的事：
 * 1. 有成片但无发布记录 → 一行 platforms=[]，状态 unpublished（不造 local 伪平台记录）
 * 2. 一内容多平台 → 只组装成一行，指标留在各平台明细里
 * 3. 主行不出现任何跨平台合计字段
 * 4. 缺指标 = 键不存在，不是 value 0
 */
import { describe, expect, it, vi } from "vitest";
import {
  type ContentVideoInput,
  buildContentVideoItem,
  contentStatusesOf,
} from "./analytics-content-video.service";

// 纯函数用例不连库；服务模块导入时的池初始化按现有惯例 mock
vi.mock("../db", () => ({ db: {} }));

const generatedAt = new Date("2026-09-20T10:00:00.000Z");

function platform(overrides: Record<string, unknown> = {}) {
  return {
    recordId: "pub_1",
    platform: "抖音",
    platformVideoId: "7432123456789",
    publishStatus: "published" as const,
    publishTime: generatedAt,
    publishTimeSource: "LOCAL_GENERATED" as const,
    metrics: {},
    hasImportConflict: false,
    ...overrides,
  };
}

function content(overrides: Partial<ContentVideoInput> = {}): ContentVideoInput {
  return {
    contentId: "cnt_1",
    title: "咖啡店英语",
    template: "scene_word",
    level: "CET4",
    localStatus: "completed",
    createdAt: generatedAt,
    videoAssetId: "video-1.mp4",
    durationSec: 33.5,
    platforms: [],
    ...overrides,
  };
}

describe("contentStatusesOf", () => {
  it("没有任何平台记录 → unpublished（本地成片仍进列表）", () => {
    expect(
      contentStatusesOf({ localStatus: "completed", hasVideoArtifact: true, platforms: [] }),
    ).toEqual(["unpublished"]);
  });

  it("有发布记录但一条指标都没有 → published_unimported", () => {
    expect(
      contentStatusesOf({
        localStatus: "completed",
        hasVideoArtifact: true,
        platforms: [{ publishStatus: "published", metricCount: 0, hasImportConflict: false }],
      }),
    ).toEqual(["published_unimported"]);
  });

  it("任一平台有指标 → imported（另一个平台还没导入也照样是 imported）", () => {
    expect(
      contentStatusesOf({
        localStatus: "completed",
        hasVideoArtifact: true,
        platforms: [
          { publishStatus: "published", metricCount: 6, hasImportConflict: false },
          { publishStatus: "published", metricCount: 0, hasImportConflict: false },
        ],
      }),
    ).toEqual(["imported"]);
  });

  it("导入冲突优先于 imported（有待裁决归属时不能只报「已有指标」）", () => {
    expect(
      contentStatusesOf({
        localStatus: "completed",
        hasVideoArtifact: true,
        platforms: [
          { publishStatus: "published", metricCount: 6, hasImportConflict: true },
          { publishStatus: "published", metricCount: 0, hasImportConflict: false },
        ],
      }),
    ).toEqual(["import_conflict", "imported"]);
  });

  it("全部平台记录都是 deleted → deleted（部分删除不算删除）", () => {
    expect(
      contentStatusesOf({
        localStatus: "completed",
        hasVideoArtifact: true,
        platforms: [{ publishStatus: "deleted", metricCount: 0, hasImportConflict: false }],
      }),
    ).toEqual(["deleted", "published_unimported"]);
    expect(
      contentStatusesOf({
        localStatus: "completed",
        hasVideoArtifact: true,
        platforms: [
          { publishStatus: "deleted", metricCount: 0, hasImportConflict: false },
          { publishStatus: "published", metricCount: 3, hasImportConflict: false },
        ],
      }),
    ).toEqual(["imported"]);
  });

  it("生成失败优先于一切，且没出片的行不顶着「未发布」标签", () => {
    expect(
      contentStatusesOf({ localStatus: "failed", hasVideoArtifact: false, platforms: [] }),
    ).toEqual(["failed"]);
  });
});

describe("buildContentVideoItem", () => {
  it("未发布内容：一行、platforms=[]、覆盖摘要全 0，不补 local 伪平台", () => {
    const item = buildContentVideoItem(content());
    expect(item.platforms).toEqual([]);
    expect(item.status).toBe("unpublished");
    expect(item.platformCount).toBe(0);
    expect(item.metricCoverage).toEqual({ platforms: 0, records: 0, recordsWithMetrics: 0 });
    expect(item.generatedAt).toBe(generatedAt.toISOString());
  });

  it("一内容两平台：仍是一行，两个平台在明细里各自带自己的指标", () => {
    const item = buildContentVideoItem(
      content({
        platforms: [
          platform({
            metrics: {
              play_count: {
                value: 1200,
                sourceType: "CREATOR_IMPORT",
                isEstimated: false,
                dataDate: "2026-09-21",
              },
            },
          }),
          platform({
            recordId: "pub_2",
            platform: "快手",
            platformVideoId: "ks-1",
            metrics: {
              play_count: {
                value: 80,
                sourceType: "USER_INPUT",
                isEstimated: false,
                dataDate: "2026-09-22",
              },
            },
          }),
        ],
      }),
    );
    expect(item.platforms).toHaveLength(2);
    expect(item.platformCount).toBe(2);
    expect(item.metricCoverage).toEqual({ platforms: 2, records: 2, recordsWithMetrics: 2 });
    expect(item.platforms.map((p) => p.platform)).toEqual(["抖音", "快手"]);
    expect(item.platforms[0]?.metrics.play_count?.value).toBe(1200);
    expect(item.platforms[1]?.metrics.play_count?.value).toBe(80);
  });

  it("主行不携带任何合计指标字段（跨平台相加是错的口径）", () => {
    const item = buildContentVideoItem(content({ platforms: [platform()] }));
    const keys = Object.keys(item);
    for (const forbidden of [
      "playCount",
      "totalPlays",
      "sumMetrics",
      "metrics",
      "likes",
      "plays",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("缺失指标不补 0：没有的键就是不存在，metricCount 如实为 0", () => {
    const item = buildContentVideoItem(content({ platforms: [platform({ metrics: {} })] }));
    expect(item.platforms[0]?.metrics).toEqual({});
    expect(item.platforms[0]?.metricCount).toBe(0);
    expect(item.status).toBe("published_unimported");
  });

  it("发布时间缺失回 null（不 fallback 成生成时间，两者语义不同）", () => {
    const item = buildContentVideoItem(
      content({ platforms: [platform({ publishTime: null, publishTimeSource: null })] }),
    );
    expect(item.platforms[0]?.publishTime).toBeNull();
    expect(item.platforms[0]?.publishTimeSource).toBeNull();
    expect(item.generatedAt).toBe(generatedAt.toISOString());
  });

  it("同平台两条重复登记：platformCount 去重为 1，records 如实为 2", () => {
    const item = buildContentVideoItem(
      content({
        platforms: [platform({ recordId: "pub_a" }), platform({ recordId: "pub_b" })],
      }),
    );
    expect(item.platformCount).toBe(1);
    expect(item.metricCoverage.records).toBe(2);
    expect(item.platforms).toHaveLength(2);
  });
});
