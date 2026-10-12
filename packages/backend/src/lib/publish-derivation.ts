import type { PublishTimeSource } from "./analytics-taxonomy";
/**
 * 上传标记 ⇒ 发布记录的派生规则（纯函数，不触库）。
 *
 * 语义：用户标记「这一集已上传到某平台」本身就是它已发布的证据，不需要他事后再去
 * 数据接入手工登记一次。缺了这一步，未登记的集会从数据分析里静默消失（行集以
 * publish_records 为锚点），用户只能靠数数发现丢数据。
 */
import { extractWorkIdFromUrl } from "./import-matcher";

export type MarkSnapshot = {
  /** 标记绑定的内容 id；未绑定（外部文件）时无法派生 */
  contentId: string | null;
  platform: string;
  url: string | null;
  videoFilename: string;
  /** 标记动作时间 = 「已发布」的时间证据；不猜测平台侧真实发布时间 */
  markedAt: Date;
  /** 派生时的生成标题（调用方从 contents 读到什么就传什么） */
  contentTitle: string | null;
};

export type PublishRecordIntent = {
  contentId: string;
  platform: string;
  platformVideoId: string | null;
  videoAssetId: string;
  publishTitle: string | null;
  publishTime: Date;
  /** 标记动作时间由用户断言，不是本地生成兜底，也不是平台导入 */
  publishTimeSource: PublishTimeSource;
  publishStatus: "published";
};

/** 未绑定任务的标记返回 null：发布记录 contentId NOT NULL，不造孤儿记录 */
export function derivePublishIntent(mark: MarkSnapshot): PublishRecordIntent | null {
  if (!mark.contentId) return null;
  return {
    contentId: mark.contentId,
    platform: mark.platform,
    // 解析不出就是 null——绝不猜作品 ID（与匹配引擎 extractWorkIdFromUrl 同一口径、同一纪律）
    platformVideoId: mark.url ? extractWorkIdFromUrl(mark.url, mark.platform) : null,
    videoAssetId: mark.videoFilename,
    publishTitle: mark.contentTitle,
    publishTime: mark.markedAt,
    publishTimeSource: "USER_EDITED",
    publishStatus: "published",
  };
}

export type ExistingPublishRecord = {
  platformVideoId: string | null;
  videoAssetId: string | null;
  publishTitle: string | null;
  publishTime: Date | null;
  publishTimeSource: PublishTimeSource | null;
};

/**
 * 同 (contentId, platform) 已有记录时只补空位：
 * 人工登记过的作品 ID / 发布时间 / 发布标题一律保留，派生值不覆盖真实值，
 * 也不把已有非空值改回 null。返回 null 表示无需写入（幂等重放不产生 UPDATE）。
 */
export function publishRecordFillPatch(
  existing: ExistingPublishRecord,
  intent: PublishRecordIntent,
): Partial<PublishRecordIntent> | null {
  const patch: Partial<PublishRecordIntent> = {};
  if (!existing.platformVideoId && intent.platformVideoId) {
    patch.platformVideoId = intent.platformVideoId;
  }
  if (!existing.videoAssetId) patch.videoAssetId = intent.videoAssetId;
  if (!existing.publishTitle && intent.publishTitle) {
    patch.publishTitle = intent.publishTitle;
  }
  if (!existing.publishTime) {
    patch.publishTime = intent.publishTime;
    patch.publishTimeSource = intent.publishTimeSource;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * 导入行携带平台真实发布时间时是否应写回发布记录（纯函数，提交链路唯一判据）。
 *
 * 纪律：
 * - 导入行没有时间 → 返回 null，绝不把已有时间清空（无数据 ≠ 已知为 null）。
 * - 来源为 USER_EDITED → 不覆盖用户手工断言的时间。
 * - 来源为 LOCAL_GENERATED / PLATFORM_IMPORTED / 未知（旧记录 NULL）→ 用平台真实时间，
 *   它比本地生成兜底更接近事实，也让人工核对看得见出处。
 */
export function importedPublishTimePatch(
  existing: Pick<ExistingPublishRecord, "publishTime" | "publishTimeSource">,
  importedAt: Date | null,
): { publishTime: Date; publishTimeSource: PublishTimeSource } | null {
  if (!importedAt) return null;
  if (existing.publishTimeSource === "USER_EDITED") return null;
  if (existing.publishTime && existing.publishTime.getTime() === importedAt.getTime()) return null;
  return { publishTime: importedAt, publishTimeSource: "PLATFORM_IMPORTED" };
}
