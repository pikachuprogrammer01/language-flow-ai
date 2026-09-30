/**
 * import-granularity 测试 — 字段角色识别 + 数据粒度三态判定（STEP 1，纯函数）
 * 纪律：账号日汇总必须被判定为 account_day_level，禁止推测升级为作品级
 */
import { describe, expect, it } from "vitest";
import {
  STRONG_ID_RATIO_THRESHOLD,
  detectFieldRoles,
  determineGranularity,
} from "./import-granularity";

describe("detectFieldRoles", () => {
  it("抖音作品级导出典型表头全量识别", () => {
    const headers = [
      "作品ID",
      "发布时间",
      "作品标题",
      "账号",
      "播放量",
      "点赞量",
      "评论量",
      "分享量",
      "完播率",
    ];
    const detection = detectFieldRoles(headers, []);
    expect(detection.map((d) => d.role)).toEqual([
      "platform_work_id",
      "publish_time",
      "title",
      "account",
      "views",
      "likes",
      "comments",
      "shares",
      "completion_rate",
    ]);
  });

  it("英文列名与链接列识别；无法识别的列 role=null", () => {
    const detection = detectFieldRoles(["item_id", "video_share_url", "备注", "时长"], []);
    expect(detection[0]?.role).toBe("platform_work_id");
    expect(detection[1]?.role).toBe("work_url");
    expect(detection[2]?.role).toBeNull();
    expect(detection[3]?.role).toBe("duration");
  });

  it("同一角色多列命中时后续列置 null（不重复分配，交给人工）", () => {
    const detection = detectFieldRoles(["发布时间", "发布日期", "标题"], []);
    expect(detection[0]?.role).toBe("publish_time");
    expect(detection[1]?.role).toBe("date");
    expect(detection[2]?.role).toBe("title");
  });

  it("携带示例行时 sample 取首行对应列", () => {
    const detection = detectFieldRoles(["作品ID", "播放量"], ["7412345678901234567", "1,283"]);
    expect(detection[0]?.sample).toBe("7412345678901234567");
    expect(detection[1]?.sample).toBe("1,283");
  });

  it("抖音合集导出全列名识别（2026-09-28 用户提供的真实表头）", () => {
    const headers = [
      "作品名称",
      "发布时间",
      "体裁",
      "审核状态",
      "播放量",
      "完播率",
      "5s完播率",
      "封面点击率",
      "2s跳出率",
      "平均播放时长",
      "点赞量",
      "分享量",
      "评论量",
      "收藏量",
      "主页访问量",
      "粉丝增量",
    ];
    const roles = detectFieldRoles(headers, []).map((d) => d.role);
    expect(roles).toEqual([
      "title",
      "publish_time",
      "genre",
      "review_status",
      "views",
      "completion_rate",
      "watch_rate_5s",
      "cover_click_rate",
      "bounce_rate_2s",
      "avg_watch_time",
      "likes",
      "shares",
      "comments",
      "collect_count",
      "profile_visit_count",
      "fans_increment",
    ]);
  });

  it("合集导出（无作品 ID 有标题+时间）判定为 work_level_weak，不谎称可精准匹配", () => {
    const rows = [["社团招新会", "2026-09-20 18:00:00", "1200"]];
    const r = determineGranularity(
      detectFieldRoles(["作品名称", "发布时间", "播放量"], rows[0] ?? []),
      rows,
    );
    expect(r.granularity).toBe("work_level_weak");
  });
});

describe("determineGranularity", () => {
  const workHeaders = ["作品ID", "标题", "播放量"];

  it("作品 ID 非空占比 ≥ 90% → work_level_strong，依据可解释", () => {
    const rows = Array.from({ length: 10 }, (_, i) => [i < 9 ? `id${i}` : "", `t${i}`, "100"]);
    const r = determineGranularity(detectFieldRoles(workHeaders, rows[0] ?? []), rows);
    expect(r.granularity).toBe("work_level_strong");
    expect(r.evidence.idNonEmptyRatio).toBe(0.9);
    expect(r.evidence.note).toContain("强唯一标识");
    expect(r.evidence.threshold).toBe(STRONG_ID_RATIO_THRESHOLD);
  });

  it("ID 列存在但非空占比 < 90% → work_level_weak（结果全部需人工确认）", () => {
    const rows = Array.from({ length: 10 }, (_, i) => [i < 5 ? `id${i}` : "", `t${i}`, "100"]);
    const r = determineGranularity(detectFieldRoles(workHeaders, rows[0] ?? []), rows);
    expect(r.granularity).toBe("work_level_weak");
    expect(r.evidence.note).toContain("缺少强唯一标识");
  });

  it("只有标题/发布时间无 ID → work_level_weak", () => {
    const rows = [
      ["2026-08-27 10:00:00", "英语每日一词 abandon", "500"],
      ["2026-08-26 09:30:00", "情景背词 travel", "300"],
    ];
    const r = determineGranularity(
      detectFieldRoles(["发布时间", "标题", "播放量"], rows[0] ?? []),
      rows,
    );
    expect(r.granularity).toBe("work_level_weak");
    expect(r.evidence.hasPublishTime).toBe(true);
    expect(r.evidence.hasTitle).toBe(true);
  });

  it("只有 date+account+指标、无任何作品维度 → account_day_level（禁止宣称可精准匹配作品）", () => {
    const rows = [
      ["2026-08-27", "抖音账号A", "12000", "300", "20", "15"],
      ["2026-08-26", "抖音账号A", "9800", "250", "18", "10"],
    ];
    const r = determineGranularity(
      detectFieldRoles(["日期", "账号", "播放量", "点赞量", "评论量", "分享量"], rows[0] ?? []),
      rows,
    );
    expect(r.granularity).toBe("account_day_level");
    expect(r.evidence.hasWorkDimension).toBe(false);
    expect(r.evidence.note).toContain("无法精确归属到单条作品");
  });

  it("work_url 非空占比达标也可判 strong（URL 解析 ID 属强证据）", () => {
    const rows = Array.from({ length: 10 }, (_, i) => [
      i < 10 ? `https://www.douyin.com/video/74123456789${i}` : "",
      "t",
      "1",
    ]);
    const r = determineGranularity(
      detectFieldRoles(["作品链接", "标题", "播放量"], rows[0] ?? []),
      rows,
    );
    expect(r.granularity).toBe("work_level_strong");
    expect(r.evidence.urlNonEmptyRatio).toBe(1);
  });

  it("空行集合不崩：无维度按 account_day_level 处理（保守，不猜作品级）", () => {
    const r = determineGranularity(detectFieldRoles(["日期", "播放量"], []), []);
    expect(r.granularity).toBe("account_day_level");
  });
});
