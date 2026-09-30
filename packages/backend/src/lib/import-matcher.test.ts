/**
 * import-matcher 测试 — 确定性匹配引擎（优先级/强弱证据/状态判定/证据结构/URL 解析/相似度）
 * 核心纪律断言：
 *   · 只有强证据单候选 → unique_match；弱证据即使单候选也 conflict（已确认设计）
 *   · 每个候选必携结构化 evidence，禁止裸分数
 *   · account_day_level 批次绝不进入作品级匹配
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MATCH_RULES,
  type EngineImportRow,
  type EngineVideo,
  type ImportMatchRules,
  epochToDateKey,
  extractWorkIdFromUrl,
  matchImportRows,
  matchSingleRow,
  normalizeTitle,
  parseTimeToEpoch,
  summarizeEstimate,
  titleSimilarity,
} from "./import-matcher";

function video(over: Partial<EngineVideo> & { videoId: string }): EngineVideo {
  return {
    platform: "抖音",
    platformVideoId: null,
    publishTime: null,
    title: null,
    durationSec: null,
    ...over,
  };
}

function row(over: Partial<EngineImportRow> & { rowNumber: number }): EngineImportRow {
  return {
    platformWorkId: null,
    workUrl: null,
    account: null,
    publishTime: null,
    date: null,
    title: null,
    durationSec: null,
    platform: "抖音",
    ...over,
  };
}

const rules: ImportMatchRules = DEFAULT_MATCH_RULES;

describe("normalizeTitle / titleSimilarity", () => {
  it("标准化：全角转半角、去话题标签、标点归一、空白折叠、小写（括号内容保留只去括号）", () => {
    const n = normalizeTitle("英语每日一词： #hot# Abandon（必考）", rules.titleNormalization);
    expect(n).toBe("英语每日一词 abandon 必考");
  });

  it("相似度确定性公式 1-编辑距离/maxLen：完全同文=1，轻微差异≥0.9", () => {
    expect(
      titleSimilarity("英语每日一词 abandon", "英语每日一词：abandon", rules.titleNormalization),
    ).toBe(1);
    const sim = titleSimilarity("情景背词旅行场景", "情景背词：旅行场景", rules.titleNormalization);
    expect(sim).toBe(1);
    const near = titleSimilarity("abandon 放弃", "abandon 丢弃", rules.titleNormalization);
    expect(near).toBeGreaterThan(0.7);
    expect(near).toBeLessThan(0.9);
  });

  it("任一侧标准化后为空 → 0（不猜）", () => {
    expect(titleSimilarity("###", "abc", rules.titleNormalization)).toBe(0);
  });
});

describe("extractWorkIdFromUrl", () => {
  it("抖音长链/分享链解析数字 ID", () => {
    expect(extractWorkIdFromUrl("https://www.douyin.com/video/7412345678901234567", "抖音")).toBe(
      "7412345678901234567",
    );
    expect(
      extractWorkIdFromUrl("https://www.iesdouyin.com/share/video/7412345678901234567/?r", "抖音"),
    ).toBe("7412345678901234567");
  });

  it("快手 short-video/photo 解析", () => {
    expect(
      extractWorkIdFromUrl("https://www.kuaishou.com/short-video/3x2abc4def5ghij", "快手"),
    ).toBe("3x2abc4def5ghij");
  });

  it("视频号 url= 参数与 /sph/ 短链解析", () => {
    expect(extractWorkIdFromUrl("https://weixin.qq.com/sph/A1b2C3d4E5", "视频号")).toBe(
      "A1b2C3d4E5",
    );
    expect(
      extractWorkIdFromUrl("https://channels.weixin.qq.com/feed?url=export%2Fv2_06", "视频号"),
    ).toBe("export%2Fv2_06");
  });

  it("解析不出返回 null（不猜）", () => {
    expect(extractWorkIdFromUrl("https://v.douyin.com/iAbCdEf/", "抖音")).toBe(null);
  });
});

describe("parseTimeToEpoch / 时区", () => {
  it("无时区字符串按 rules.timezoneOffsetMinutes 解析为绝对时间", () => {
    const a = parseTimeToEpoch("2026-08-27 10:00:00", 480);
    const b = parseTimeToEpoch("2026-08-27T10:00:00+08:00", 0);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it("epoch → 日期键按同一时区口径", () => {
    const epoch = parseTimeToEpoch("2026-08-27 00:30:00", 480);
    expect(epochToDateKey(epoch ?? 0, 480)).toBe("2026-08-27");
  });
});

describe("matchSingleRow — 状态判定纪律", () => {
  it("方法1：作品 ID 完全一致（同平台）→ unique_match，证据含 platformWorkIdExact", () => {
    const videos = [video({ videoId: "v1", platformVideoId: "7412345678901234567" })];
    const r = matchSingleRow(
      row({ rowNumber: 1, platformWorkId: "7412345678901234567" }),
      videos,
      rules,
    );
    expect(r.status).toBe("unique_match");
    expect(r.candidates[0]?.matchMethod).toBe("platform_work_id_exact");
    expect(r.candidates[0]?.matchScore).toBe(1);
    expect(r.candidates[0]?.evidence.platformWorkIdExact).toBe(true);
    expect(r.candidates[0]?.rank).toBe(1);
  });

  it("方法2：URL 解析 ID 一致 → unique_match（强证据）", () => {
    const videos = [video({ videoId: "v1", platformVideoId: "7412345678901234567" })];
    const r = matchSingleRow(
      row({ rowNumber: 1, workUrl: "https://www.douyin.com/video/7412345678901234567" }),
      videos,
      rules,
    );
    expect(r.status).toBe("unique_match");
    expect(r.candidates[0]?.matchMethod).toBe("work_url_id");
  });

  it("跨平台 ID 相同不算匹配（平台经映射后仍须一致）", () => {
    const videos = [video({ videoId: "v1", platform: "快手", platformVideoId: "741" })];
    const r = matchSingleRow(
      row({ rowNumber: 1, platformWorkId: "741", platform: "抖音" }),
      videos,
      rules,
    );
    expect(r.status).toBe("unmatched");
  });

  it("platformMapping 生效：导出「douyin」映射到系统「抖音」后可强匹配", () => {
    const mapped: ImportMatchRules = { ...rules, platformMapping: { douyin: "抖音" } };
    const videos = [video({ videoId: "v1", platformVideoId: "741" })];
    const r = matchSingleRow(
      row({ rowNumber: 1, platformWorkId: "741", platform: "douyin" }),
      videos,
      mapped,
    );
    expect(r.status).toBe("unique_match");
  });

  it("未绑定作品 ID 的系统记录不参与自动匹配（防污染，仅人工绑定）", () => {
    const videos = [video({ videoId: "v1", platformVideoId: null, title: "任意" })];
    const r = matchSingleRow(
      row({ rowNumber: 1, title: "任意", date: "2026-08-27", publishTime: null }),
      videos,
      rules,
    );
    expect(r.candidates.every((c) => c.videoId !== "v1")).toBe(true);
  });

  it("方法3 弱证据单候选 → conflict（已确认设计：纯时间命中不得 unique_match）", () => {
    const videos = [video({ videoId: "v1", publishTime: new Date("2026-08-27T10:00:32+08:00") })];
    const r = matchSingleRow(
      row({ rowNumber: 1, publishTime: "2026-08-27 10:00:00" }),
      videos,
      rules,
    );
    expect(r.status).toBe("conflict");
    expect(r.candidates[0]?.matchMethod).toBe("account_publish_time");
    expect(r.candidates[0]?.evidence.publishTimeDiffSeconds).toBe(32);
  });

  it("双证据（用户裁决 2026-09-28）：标题完全一致 + 时间容差内吻合 + 唯一 → title_exact_plus_time → unique_match", () => {
    const videos = [
      video({
        videoId: "v1",
        publishTime: new Date("2026-08-27T10:00:21+08:00"),
        title: "英语每日一词：abandon",
      }),
    ];
    const r = matchSingleRow(
      row({ rowNumber: 1, publishTime: "2026-08-27 10:00:00", title: "英语每日一词 abandon" }),
      videos,
      rules,
    );
    expect(r.status).toBe("unique_match");
    expect(r.candidates[0]?.matchMethod).toBe("title_exact_plus_time");
    expect(r.candidates[0]?.matchScore).toBe(0.9);
    expect(r.candidates[0]?.evidence.titleExact).toBe(true);
    expect(r.candidates[0]?.evidence.publishTimeDiffSeconds).toBe(21);
  });

  it("双证据不成立：标题仅相似非完全一致 + 时间吻合 → 仍 account_publish_time conflict", () => {
    const videos = [
      video({
        videoId: "v1",
        publishTime: new Date("2026-08-27T10:00:21+08:00"),
        title: "英语每日一词：abandon 必考",
      }),
    ];
    const r = matchSingleRow(
      row({ rowNumber: 1, publishTime: "2026-08-27 10:00:00", title: "英语每日一词 abandon" }),
      videos,
      rules,
    );
    expect(r.candidates[0]?.matchMethod).toBe("account_publish_time");
    expect(r.status).toBe("conflict");
  });

  it("双证据但多候选（两视频都时间吻合且标题一致）→ conflict，绝不自动选", () => {
    const videos = [
      video({ videoId: "v1", publishTime: new Date("2026-08-27T10:00:21+08:00"), title: "同标题" }),
      video({ videoId: "v2", publishTime: new Date("2026-08-27T10:01:00+08:00"), title: "同标题" }),
    ];
    const r = matchSingleRow(
      row({ rowNumber: 1, publishTime: "2026-08-27 10:00:00", title: "同标题" }),
      videos,
      rules,
    );
    expect(r.status).toBe("conflict");
    expect(r.candidates).toHaveLength(2);
  });

  it("合集导出典型行：无作品 ID 仅标题+时间，双证据命中即可 unique（一键导入前提）", () => {
    const videos = [
      video({
        videoId: "v1",
        platformVideoId: null,
        publishTime: new Date("2026-09-20T18:00:12+08:00"),
        title: "社团招新会",
      }),
    ];
    const r = matchSingleRow(
      row({
        rowNumber: 1,
        platformWorkId: null,
        publishTime: "2026-09-20 18:00:00",
        title: "社团招新会",
      }),
      videos,
      rules,
    );
    expect(r.status).toBe("unique_match");
    expect(r.candidates[0]?.matchMethod).toBe("title_exact_plus_time");
  });

  it("发布时间差超容差（默认 ±5 分钟）→ 不产候选", () => {
    const videos = [video({ videoId: "v1", publishTime: new Date("2026-08-27T10:06:00+08:00") })];
    const r = matchSingleRow(
      row({ rowNumber: 1, publishTime: "2026-08-27 10:00:00" }),
      videos,
      rules,
    );
    expect(r.status).toBe("unmatched");
  });

  it("方法4：同日 + 标题相似度 ≥ 阈值 → conflict 候选带相似度与标准化双标题（无发布时间列时走日期+标题）", () => {
    const videos = [
      video({
        videoId: "v1",
        title: "英语每日一词：abandon",
        publishTime: new Date("2026-08-27T09:00:00Z"),
      }),
    ];
    const r = matchSingleRow(
      row({ rowNumber: 1, title: "英语每日一词 abandon", date: "2026-08-27" }),
      videos,
      rules,
    );
    expect(r.status).toBe("conflict");
    const c = r.candidates[0];
    expect(c?.matchMethod).toBe("account_date_title");
    expect(c?.evidence.titleSimilarity).toBe(1);
    expect(c?.evidence.dateMatched).toBe(true);
    expect(c?.evidence.workIdMissing).toBe(true);
  });

  it("方法5：标题相似且时长差 ≤5s → 升级为 account_date_title_duration", () => {
    const videos = [
      video({
        videoId: "v1",
        title: "情景背词旅行场景",
        durationSec: 58,
        publishTime: new Date("2026-08-27T10:00:00+08:00"),
      }),
    ];
    const r = matchSingleRow(
      row({ rowNumber: 1, title: "情景背词：旅行场景", date: "2026-08-27", durationSec: 60 }),
      videos,
      rules,
    );
    expect(r.candidates[0]?.matchMethod).toBe("account_date_title_duration");
    expect(r.candidates[0]?.evidence.durationDiffSeconds).toBe(2);
  });

  it("多候选全部并列（系统绝不自动选最高分），rank 按优先级排序", () => {
    const videos = [
      video({ videoId: "v1", publishTime: new Date("2026-08-27T10:00:21+08:00"), title: "甲标题" }),
      video({
        videoId: "v2",
        publishTime: new Date("2026-08-27T10:02:00+08:00"),
        title: "乙标题完全不同",
      }),
    ];
    const r = matchSingleRow(
      row({ rowNumber: 1, publishTime: "2026-08-27 10:00:00" }),
      videos,
      rules,
    );
    expect(r.status).toBe("conflict");
    // v2 差 120s 仍在 ±5 分钟容差内 → 两候选并列，绝不替用户选择
    expect(r.candidates.map((c) => c.videoId)).toEqual(["v1", "v2"]);
    expect(r.candidates.map((c) => c.rank)).toEqual([1, 2]);
  });

  it("强证据与弱证据指向不同视频 → 并列展示矛盾，状态 conflict", () => {
    const videos = [
      video({ videoId: "strong", platformVideoId: "741" }),
      video({ videoId: "weak", publishTime: new Date("2026-08-27T10:00:10+08:00") }),
    ];
    const r = matchSingleRow(
      row({ rowNumber: 1, platformWorkId: "741", publishTime: "2026-08-27 10:00:00" }),
      videos,
      rules,
    );
    expect(r.status).toBe("conflict");
    expect(r.candidates.map((c) => c.videoId)).toEqual(["strong", "weak"]);
    expect(r.candidates[0]?.rank).toBe(1);
    expect(r.candidates[1]?.rank).toBe(2);
  });

  it("同一视频多方法命中只保留最强方法（强压制弱）", () => {
    const videos = [
      video({
        videoId: "v1",
        platformVideoId: "741",
        publishTime: new Date("2026-08-27T10:00:05+08:00"),
      }),
    ];
    const r = matchSingleRow(
      row({ rowNumber: 1, platformWorkId: "741", publishTime: "2026-08-27 10:00:00" }),
      videos,
      rules,
    );
    expect(r.candidates.length).toBe(1);
    expect(r.candidates[0]?.matchMethod).toBe("platform_work_id_exact");
    expect(r.status).toBe("unique_match");
  });

  it("账号映射命中记入证据 accountMapped（系统侧无账号字段的既定口径）", () => {
    const withAccount: ImportMatchRules = { ...rules, accountMapping: { "抖音-主号": "主账号" } };
    const videos = [video({ videoId: "v1", platformVideoId: "741" })];
    const r = matchSingleRow(
      row({ rowNumber: 1, platformWorkId: "741", account: "抖音-主号" }),
      videos,
      withAccount,
    );
    expect(r.candidates[0]?.evidence.accountMapped).toBe(true);
    expect(r.candidates[0]?.evidence.mappedAccount).toBe("主账号");
  });

  it("无账号列行 accountMapped=null（不适用，展示层不得误标 ✗）；有账号未登记才 false", () => {
    const videos = [video({ videoId: "v1", platformVideoId: "741" })];
    const noAccount = matchSingleRow(row({ rowNumber: 1, platformWorkId: "741" }), videos, rules);
    expect(noAccount.candidates[0]?.evidence.accountMapped).toBeNull();
    const unmapped = matchSingleRow(
      row({ rowNumber: 1, platformWorkId: "741", account: "未登记账号" }),
      videos,
      rules,
    );
    expect(unmapped.candidates[0]?.evidence.accountMapped).toBe(false);
  });
});

describe("matchImportRows — 批次入口纪律", () => {
  it("account_day_level 批次不进作品级匹配：results 为空，由 service 直接落账号日终态", () => {
    const out = matchImportRows(
      [row({ rowNumber: 1, platformWorkId: "741" })],
      [video({ videoId: "v1", platformVideoId: "741" })],
      rules,
      "account_day_level",
    );
    expect(out.results).toEqual([]);
    expect(out.granularity).toBe("account_day_level");
  });

  it("预估统计四类计数正确", () => {
    const videos = [video({ videoId: "v1", platformVideoId: "741" })];
    const out = matchImportRows(
      [
        row({ rowNumber: 1, platformWorkId: "741" }), // unique
        row({ rowNumber: 2, publishTime: "2026-01-01 00:00:00" }), // unmatched
      ],
      videos,
      rules,
      "work_level_strong",
    );
    expect(summarizeEstimate(out)).toEqual({
      total: 2,
      expectStrongMatch: 1,
      expectManualConfirm: 0,
      expectUnmatched: 1,
    });
  });
});
