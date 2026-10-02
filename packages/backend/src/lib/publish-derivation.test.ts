/**
 * 上传标记 ⇒ 发布记录派生规则（纯函数）
 * 覆盖：作品 ID 解析口径 / 不猜 ID / 未绑定内容不派生 / 只补空位不覆盖真实值 / 幂等重放
 */
import { describe, expect, it } from "vitest";
import {
  type MarkSnapshot,
  derivePublishIntent,
  publishRecordFillPatch,
} from "./publish-derivation";

const markedAt = new Date("2026-10-02T03:20:00.000Z");

function mark(overrides: Partial<MarkSnapshot> = {}): MarkSnapshot {
  return {
    contentId: "cnt_20261002_469bc3",
    platform: "抖音",
    url: "https://www.douyin.com/video/7412345678901234567",
    videoFilename: "c29565d8-dbe5-4be2-b937-be1c826bf42d.mp4",
    markedAt,
    contentTitle: "线上学习的新支持",
    ...overrides,
  };
}

describe("derivePublishIntent", () => {
  it("标记即发布：带链接的标记派生出可被导入匹配的作品 ID", () => {
    expect(derivePublishIntent(mark())).toEqual({
      contentId: "cnt_20261002_469bc3",
      platform: "抖音",
      platformVideoId: "7412345678901234567",
      videoAssetId: "c29565d8-dbe5-4be2-b937-be1c826bf42d.mp4",
      publishTitle: "线上学习的新支持",
      publishTime: markedAt,
      publishStatus: "published",
    });
  });

  it("解析不出作品 ID 时保持 null，不猜、不造占位值", () => {
    const intent = derivePublishIntent(mark({ url: "https://v.douyin.com/iAbCdEf/" }));
    expect(intent?.platformVideoId).toBeNull();
  });

  it("无链接的标记同样派生（发布事实成立，只是暂时无作品 ID）", () => {
    const intent = derivePublishIntent(mark({ url: null }));
    expect(intent?.platformVideoId).toBeNull();
    expect(intent?.publishTime).toBe(markedAt);
  });

  it("未绑定生成记录的标记不派生（发布记录 contentId NOT NULL）", () => {
    expect(derivePublishIntent(mark({ contentId: null }))).toBeNull();
  });
});

describe("publishRecordFillPatch", () => {
  const intent = derivePublishIntent(mark()) as NonNullable<ReturnType<typeof derivePublishIntent>>;

  it("只补空位：人工登记过的作品 ID 与发布时间一律保留", () => {
    const patch = publishRecordFillPatch(
      {
        platformVideoId: "7300000000000000000",
        videoAssetId: null,
        publishTitle: "人工写的发布标题",
        publishTime: new Date("2026-09-30T02:00:00.000Z"),
      },
      intent,
    );
    expect(patch).toEqual({ videoAssetId: intent.videoAssetId });
  });

  it("不把已有非空值改回 null（派生值为空时无动作）", () => {
    const patch = publishRecordFillPatch(
      {
        platformVideoId: "7412345678901234567",
        videoAssetId: "old.mp4",
        publishTitle: "标题",
        publishTime: null,
      },
      derivePublishIntent(mark({ url: null })) as NonNullable<
        ReturnType<typeof derivePublishIntent>
      >,
    );
    expect(patch).toEqual({ publishTime: markedAt });
  });

  it("字段齐备时返回 null：幂等重放不产生多余 UPDATE", () => {
    const patch = publishRecordFillPatch(
      {
        platformVideoId: "7412345678901234567",
        videoAssetId: "c29565d8-dbe5-4be2-b937-be1c826bf42d.mp4",
        publishTitle: "线上学习的新支持",
        publishTime: markedAt,
      },
      intent,
    );
    expect(patch).toBeNull();
  });
});
