/**
 * 发布数据一致性修复脚本（docs/18 §四.2 / docs/19 M5）
 *
 * 三段幂等修复：清测试夹具 → 按上传标记回填发布记录 → 恢复 09-24/09-25 两集。
 * 默认 dry-run，`--apply` 才写库；目标是生产库时由 requireSafeWriteTarget 拦截，
 * 必须显式 DB_ALLOW_PROD=1（本次交付不代跑生产）。
 *
 * 用法（开发/测试库 :3307）：
 *   pnpm --filter @ai-english/backend exec tsx scripts/recover-publish-data.ts
 *   pnpm --filter @ai-english/backend exec tsx scripts/recover-publish-data.ts --apply
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { type SQL, asc, count, countDistinct, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { MySqlTable } from "drizzle-orm/mysql-core";
import { db, requireSafeWriteTarget } from "../src/db/index";
import { cetWords, contents, publishRecords, uploadMarks } from "../src/db/schema";
import { derivePublishIntent } from "../src/lib/publish-derivation";
import { UPLOADS_DIR } from "../src/lib/uploads-path";
import { upsertPublishRecordFromMark } from "../src/services/analytics-metrics.service";

type Level = "CET4" | "CET6";
type WordInfo = { word: string; meaning: string; level: Level };
type Segment = { text: string; words: string[] };

/** 一条待恢复的集：文案与词表取自成片截帧，时长/尺寸取自 ffprobe，时间取自配音文件 mtime */
type RecoveredEpisode = {
  id: string;
  title: string;
  createdAt: Date;
  targetDuration: number;
  segments: Segment[];
  /** 画面「本期词汇」原样转录（含当时真正渲染出的义项） */
  words: { word: string; meaning: string }[];
  audio: { url: string; duration: number; format: string; file: string };
  video: { url: string; duration: number; file: string };
};

/**
 * 第 39/40 集：09-28「测试库灌回生产库」时被 09-23 时代快照覆盖掉的两集。
 * 标题/正文/词表来自成片画面（scene_word 渲染器一次性画出全部段落，首尾帧一致已核对）；
 * 音、视文件仍在 uploads 目录，配音视频时长差 ≈1s 即片头，配对关系成立。
 */
const RECOVERED: RecoveredEpisode[] = [
  {
    id: "cnt_20260924_rec039",
    title: "家庭聚餐欢乐夜",
    createdAt: new Date("2026-09-24T11:10:00Z"),
    targetDuration: 30,
    segments: [
      {
        text: "李家的family聚餐在周末举行，invite了relative和friend。table铺好后，摆满了各式meal。孩子们兴奋地围着桌子，期待着丰盛的dinner。",
        words: ["family", "invite", "relative", "friend", "table", "meal", "dinner"],
      },
      {
        text: "table上，dessert和果汁让人enjoy不已。李妈妈用spoon给孩子们分蛋糕，fork则用来吃toast。整个family边吃边聊，笑声不断，分享着彼此的故事。",
        words: ["table", "dessert", "enjoy", "spoon", "fork", "toast", "family"],
      },
    ],
    words: [
      { word: "invite", meaning: "邀请" },
      { word: "friend", meaning: "朋友" },
      { word: "relative", meaning: "亲戚" },
      { word: "table", meaning: "餐桌" },
      { word: "meal", meaning: "膳食" },
      { word: "dinner", meaning: "正餐" },
      { word: "family", meaning: "家庭" },
      { word: "toast", meaning: "烤面包" },
      { word: "enjoy", meaning: "享受" },
      { word: "spoon", meaning: "调羹" },
      { word: "fork", meaning: "餐叉" },
      { word: "dessert", meaning: "甜食" },
    ],
    audio: {
      url: "/files/audio/cbfe843e-8bc4-45e6-916a-bde6317281c7.mp3",
      file: "audio/cbfe843e-8bc4-45e6-916a-bde6317281c7.mp3",
      duration: 28.896,
      format: "mp3",
    },
    video: {
      url: "/files/video/93c90a30-7d53-4b10-8930-a8b5699b04b2.mp4",
      file: "video/93c90a30-7d53-4b10-8930-a8b5699b04b2.mp4",
      duration: 29.909,
    },
  },
  {
    id: "cnt_20260925_rec040",
    title: "通勤中的地铁之旅",
    createdAt: new Date("2026-09-25T11:31:00Z"),
    targetDuration: 36,
    segments: [
      {
        text: "morning，小李拿着subway map和timetable，急急忙忙地赶往地铁站。他need在高峰时段赶到公司，以免迟到。地铁站的platform人声鼎沸，crowd着许多早起的通勤者。",
        words: ["morning", "subway", "map", "timetable", "need", "platform", "crowd"],
      },
      {
        text: "小李找到了通往他工作地点的line，但发现need在某个站点换乘。他快速刷了card，随着人群涌向下一班train。evening时分，subway站又迎来了下班的高峰，traffic拥堵得几乎让人喘不过气。",
        words: ["line", "need", "card", "train", "evening", "subway", "traffic"],
      },
    ],
    words: [
      { word: "timetable", meaning: "时刻表" },
      { word: "need", meaning: "需要" },
      { word: "crowd", meaning: "聚集" },
      { word: "morning", meaning: "早晨" },
      { word: "map", meaning: "地图" },
      { word: "platform", meaning: "平台" },
      { word: "subway", meaning: "地铁" },
      { word: "train", meaning: "列车" },
      { word: "traffic", meaning: "交通" },
      { word: "evening", meaning: "傍晚" },
      { word: "line", meaning: "路线" },
      { word: "card", meaning: "卡片" },
    ],
    audio: {
      url: "/files/audio/6eeb2009-da6d-4082-ba16-911dff8de489.mp3",
      file: "audio/6eeb2009-da6d-4082-ba16-911dff8de489.mp3",
      duration: 34.608,
      format: "mp3",
    },
    video: {
      url: "/files/video/ab682d56-2164-4872-9937-eab274ff5500.mp4",
      file: "video/ab682d56-2164-4872-9937-eab274ff5500.mp4",
      duration: 35.627,
    },
  },
];

/** 词表：释义取自成片「本期词汇」画面（这就是当时真正渲染出去的词义），
 * 等级取自 cet_words（画面上没有等级）。词库首义项与画面义项可能差一个义项，
 * 故不拿 splitMeanings()[0] 覆盖画面值——恢复要贴证据，不贴"系统会怎么生成"。
 */
async function attachLevels(
  words: { word: string; meaning: string }[],
): Promise<{ resolved: WordInfo[]; notInDict: string[] }> {
  const rows = await db
    .select({ word: cetWords.word, level: cetWords.level })
    .from(cetWords)
    .where(
      inArray(
        sql`lower(${cetWords.word})`,
        words.map((w) => w.word.toLowerCase()),
      ),
    );
  const levelByWord = new Map(rows.map((r) => [r.word.toLowerCase(), r.level]));
  const notInDict = words.map((w) => w.word).filter((w) => !levelByWord.has(w.toLowerCase()));
  return {
    resolved: words.map((w) => ({
      ...w,
      level: levelByWord.get(w.word.toLowerCase()) ?? "CET4",
    })),
    notInDict,
  };
}

/** 内容等级取词表多数派（原记录未留痕，不猜具体值，按词库等级投票） */
function majorityLevel(words: WordInfo[]): Level {
  const cet6 = words.filter((w) => w.level === "CET6").length;
  return cet6 * 2 > words.length ? "CET6" : "CET4";
}

async function missingMedia(ep: RecoveredEpisode): Promise<string[]> {
  const out: string[] = [];
  for (const file of [ep.audio.file, ep.video.file]) {
    try {
      await stat(join(UPLOADS_DIR, file));
    } catch {
      out.push(file);
    }
  }
  return out;
}

async function report(label: string): Promise<void> {
  const [
    contentsRows,
    fixtureRows,
    withVideo,
    publishRows,
    fixturePublishRows,
    publishedContents,
    markRows,
    orphanMarks,
    unregistered,
    sharedVideo,
  ] = await Promise.all([
    countRows(contents),
    countRows(contents, sql`${contents.id} like 'test%'`),
    countRows(contents, isNotNull(contents.video)),
    countRows(publishRecords),
    countRows(publishRecords, sql`${publishRecords.id} like 'test%'`),
    countDistinctPublishedContents(),
    countRows(uploadMarks),
    countRows(
      uploadMarks,
      sql`task_id is not null and not exists (
      select 1 from contents c where c.id = upload_marks.task_id)`,
    ),
    countRows(
      contents,
      sql`video is not null and not exists (
      select 1 from publish_records p where p.content_id = contents.id)`,
    ),
    countSharedVideoContents(),
  ]);
  const lines: [string, number][] = [
    ["contents_rows", contentsRows],
    ["fixture_rows", fixtureRows],
    ["with_video", withVideo],
    ["publish_rows", publishRows],
    ["fixture_publish_rows", fixturePublishRows],
    ["published_contents", publishedContents],
    ["mark_rows", markRows],
    ["orphan_mark_rows", orphanMarks],
    ["unregistered_episodes", unregistered],
    ["shared_video_conflicts", sharedVideo],
  ];
  console.log(`\n── ${label}对账 ──`);
  for (const [k, v] of lines) console.log(`  ${k.padEnd(24)} ${v}`);
}

async function countRows(table: MySqlTable, where?: SQL): Promise<number> {
  const rows = await db.select({ n: count() }).from(table).where(where);
  return Number(rows[0]?.n ?? 0);
}

async function countDistinctPublishedContents(): Promise<number> {
  const rows = await db.select({ n: countDistinct(publishRecords.contentId) }).from(publishRecords);
  return Number(rows[0]?.n ?? 0);
}

/** 同一成片文件被多条记录引用（夹具复用真实集成片留下的冲突）；按 url 归组，JSON 列不可分组 */
async function countSharedVideoContents(): Promise<number> {
  const rows = await db
    .select({ c: sql<number>`count(*)` })
    .from(contents)
    .where(isNotNull(contents.video))
    .groupBy(sql`json_unquote(json_extract(video, '$.url'))`)
    .having(sql`count(*) > 1`);
  return rows.length;
}

async function purgeFixtures(apply: boolean): Promise<void> {
  const ids = (
    await db.select({ id: contents.id }).from(contents).where(sql`${contents.id} like 'test%'`)
  ).map((r) => r.id);
  if (ids.length === 0) {
    console.log("[A] 无测试夹具，跳过");
    return;
  }
  const markRows = await db
    .select({ id: uploadMarks.id })
    .from(uploadMarks)
    .where(inArray(uploadMarks.taskId, ids));
  const pubRows = await db
    .select({ id: publishRecords.id })
    .from(publishRecords)
    .where(inArray(publishRecords.contentId, ids));
  console.log(
    `[A] 清测试夹具 ${ids.length} 条 contents（级联带走 ${pubRows.length} 条发布记录与分析快照）` +
      ` + 显式清 ${markRows.length} 条无外键约束的标记`,
  );
  console.log(`    夹具 id: ${ids.join(", ")}`);
  if (!apply) return;
  await db.transaction(async (tx) => {
    await tx.delete(uploadMarks).where(inArray(uploadMarks.taskId, ids));
    await tx.delete(contents).where(inArray(contents.id, ids));
  });
}

async function backfillPublishRecords(apply: boolean): Promise<void> {
  const marks = await db
    .select()
    .from(uploadMarks)
    .where(sql`${uploadMarks.taskId} is not null`)
    .orderBy(asc(uploadMarks.createdAt));
  const titleById = new Map(
    (await db.select({ id: contents.id, title: contents.title }).from(contents)).map((c) => [
      c.id,
      c.title,
    ]),
  );
  const tally: Record<string, number> = {};
  for (const mark of marks) {
    const intent = derivePublishIntent({
      contentId: mark.taskId,
      platform: mark.platform,
      url: mark.url,
      videoFilename: mark.videoFilename,
      markedAt: mark.createdAt,
      contentTitle: mark.taskId ? (titleById.get(mark.taskId) ?? null) : null,
    });
    const outcome = apply
      ? await upsertPublishRecordFromMark(db, intent)
      : await previewOutcome(intent?.contentId ?? null, intent?.platform ?? null);
    tally[outcome] = (tally[outcome] ?? 0) + 1;
  }
  console.log(`[B] 标记⇒发布记录回填 ${marks.length} 条：${JSON.stringify(tally)}`);
}

/** dry-run：只判断会不会新建，不写 */
async function previewOutcome(
  contentId: string | null,
  platform: string | null,
): Promise<"created" | "unchanged" | "skipped-no-content"> {
  if (!contentId || !platform) return "skipped-no-content";
  const existing = await db
    .select({ id: publishRecords.id })
    .from(publishRecords)
    .where(
      sql`${publishRecords.contentId} = ${contentId} and ${publishRecords.platform} = ${platform}`,
    )
    .limit(1);
  return existing.length > 0 ? "unchanged" : "created";
}

async function recoverEpisodes(apply: boolean): Promise<void> {
  for (const ep of RECOVERED) {
    const existing = await db
      .select({ id: contents.id })
      .from(contents)
      .where(eq(contents.id, ep.id));
    if (existing.length > 0) {
      console.log(`[C] ${ep.id} 已存在，跳过`);
      continue;
    }
    const missing = await missingMedia(ep);
    if (missing.length > 0) {
      console.log(`[C] ${ep.id} 媒体文件缺失，拒绝插入：${missing.join(", ")}`);
      continue;
    }
    const { resolved, notInDict } = await attachLevels(ep.words);
    const dictNote = notInDict.length ? ` / 词库未收录(等级按 CET4): ${notInDict.join(",")}` : "";
    console.log(
      `[C] 恢复 ${ep.id}《${ep.title}》：${ep.segments.length} 段 / ${resolved.length} 词 / level=${majorityLevel(resolved)}${dictNote}`,
    );
    if (!apply) continue;
    await db.insert(contents).values({
      id: ep.id,
      template: "scene_word",
      title: ep.title,
      level: majorityLevel(resolved),
      targetDuration: ep.targetDuration,
      content: ep.segments.map((s) => ({
        text: s.text,
        words: resolved.filter((w) => s.words.includes(w.word)),
      })),
      words: resolved,
      style: { background: "white" },
      voice: { id: "female_01" },
      audio: { url: ep.audio.url, duration: ep.audio.duration, format: ep.audio.format },
      video: {
        url: ep.video.url,
        duration: ep.video.duration,
        resolution: "1080x1920",
        format: "mp4",
        introStatus: "rendered",
      },
      status: "completed",
      createdAt: ep.createdAt,
      updatedAt: ep.createdAt,
      // 恢复痕迹明示：不是 LLM 原始生成档案，候选词/重试历史不存在
      audit: {
        recovered: {
          by: "recover-publish-data",
          at: new Date().toISOString(),
          evidence: "orphan-render-frame + ffprobe + uploads mtime",
          inferredFields: ["voice", "targetDuration"],
          meaningSource: "释义取自成片「本期词汇」画面；level 取自 cet_words",
          note: "原行随 2026-09-28 测试库快照灌回生产被覆盖；正文与词表取自成片画面（首尾帧一致）",
        },
      },
    });
  }
}

export async function main(apply: boolean): Promise<void> {
  console.log(apply ? "== APPLY 模式 ==" : "== DRY-RUN（加 --apply 才写库）==");
  if (apply) requireSafeWriteTarget("recover-publish-data");
  console.log(`UPLOADS_DIR=${UPLOADS_DIR}`);
  await report("修复前");
  await purgeFixtures(apply);
  await backfillPublishRecords(apply);
  await recoverEpisodes(apply);
  if (apply) await report("修复后");
}

if (process.argv[1]?.includes("recover-publish-data")) {
  main(process.argv.includes("--apply"))
    .then(() => process.exit(0))
    .catch((e: unknown) => {
      console.error(e);
      process.exit(1);
    });
}
