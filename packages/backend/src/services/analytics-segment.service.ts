/**
 * 内容时间轴服务 — video_segment 派生与装载（Phase 3，需求 §八.6）
 *
 * 派生口径（诚实声明）：
 * - 总时长 = 成片 video.duration（回退配音 audio.duration）；无产物时长 → 不派生（不猜）
 * - scene_word 片头已渲染时占 0~INTRO_DURATION_SEC（渲染器事实）；正文各段按字符数权重
 *   用渲染链路同一 allocateDurations 分配 —— TTS 按段拼接，字符权重即生产口径估算，
 *   行级 source_type=PLATFORM_CALCULATED，不伪装逐帧实测切换点
 * - word_card/quiz 同理按条目字符权重分配（逐项合成对齐的精确时长未落库，Phase 5 埋点后升级）
 */
import { asc, eq } from "drizzle-orm";
import { db } from "../db";
import { contents, videoSegments } from "../db/schema";
import { allocateDurations } from "../renderer/allocate-durations";
import { INTRO_DURATION_SEC } from "../renderer/three-intro.capture";

type Db = typeof db;
type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];
type ContentRow = typeof contents.$inferSelect;
type SegmentRow = typeof videoSegments.$inferSelect;

export interface DerivedSegment {
  idx: number;
  startTime: number;
  endTime: number;
  segmentType: "intro" | "story_segment" | "word_card" | "quiz_question";
  dialogue: string | null;
  knowledgePoint: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function durationOf(video: unknown, audio: unknown): number | null {
  for (const meta of [video, audio]) {
    if (meta && typeof meta === "object" && "duration" in meta) {
      const d = Number((meta as { duration?: unknown }).duration);
      if (Number.isFinite(d) && d > 0) return d;
    }
  }
  return null;
}

/** 各模板的条目 → { 权重文本, 台词文本, 知识点 } */
function itemTexts(row: ContentRow): { dialogue: string; knowledge: string }[] {
  const items = Array.isArray(row.content) ? row.content : [];
  if (row.template === "scene_word") {
    return items.map((raw) => {
      const item = asRecord(raw);
      const words = Array.isArray(item.words) ? item.words.map((w) => asRecord(w).word) : [];
      return {
        dialogue: String(item.text ?? "").slice(0, 2000),
        knowledge: words.filter(Boolean).join(",").slice(0, 500),
      };
    });
  }
  if (row.template === "word_card") {
    return items.map((raw) => {
      const item = asRecord(raw);
      return {
        dialogue: `${item.word ?? ""} ${item.meaning ?? ""} ${item.example ?? ""}`.slice(0, 2000),
        knowledge: String(item.word ?? "").slice(0, 500),
      };
    });
  }
  return items.map((raw) => {
    const item = asRecord(raw);
    return {
      dialogue: String(item.stem ?? "").slice(0, 2000),
      knowledge: String(asRecord(item.word).word ?? item.stem ?? "").slice(0, 500),
    };
  });
}

/** 纯函数：从 contents 行派生段落时间轴（不产物时长则返回空数组） */
export function deriveSegments(row: ContentRow): DerivedSegment[] {
  const total = durationOf(row.video, row.audio);
  const items = Array.isArray(row.content) ? row.content : [];
  if (total === null || items.length === 0) return [];
  const introRendered =
    row.template === "scene_word" && asRecord(row.video).introStatus === "rendered";
  const texts = itemTexts(row);
  const bodyTotal = Math.max(0, total - (introRendered ? INTRO_DURATION_SEC : 0));
  const weights = texts.map((t) => Math.max(t.dialogue.length, 1));
  const durations = bodyTotal > 0 ? allocateDurations(weights, bodyTotal) : texts.map(() => 0);
  const segmentType: DerivedSegment["segmentType"] =
    row.template === "scene_word"
      ? "story_segment"
      : row.template === "word_card"
        ? "word_card"
        : "quiz_question";
  const out: DerivedSegment[] = [];
  let cursor = 0;
  if (introRendered) {
    out.push({
      idx: 0,
      startTime: 0,
      endTime: INTRO_DURATION_SEC,
      segmentType: "intro",
      dialogue: "Three.js 主题片头",
      knowledgePoint: null,
    });
    cursor = INTRO_DURATION_SEC;
  }
  texts.forEach((t, i) => {
    const duration = durations[i] ?? 0;
    out.push({
      idx: out.length,
      startTime: Math.round(cursor * 10) / 10,
      endTime: Math.round((cursor + duration) * 10) / 10,
      segmentType,
      dialogue: t.dialogue,
      knowledgePoint: t.knowledge || null,
    });
    cursor += duration;
  });
  return out;
}

/** 重建段落时间轴（幂等全删全插；生产数据变更后随 features sync 一起刷新） */
export async function syncContentSegments(
  contentId: string,
  executor: Executor = db,
): Promise<SegmentRow[]> {
  const [content] = await executor
    .select()
    .from(contents)
    .where(eq(contents.id, contentId))
    .limit(1);
  if (!content) return [];
  const derived = deriveSegments(content);
  await executor.delete(videoSegments).where(eq(videoSegments.contentId, contentId));
  if (derived.length > 0) {
    await executor.insert(videoSegments).values(
      derived.map((d) => ({
        contentId,
        idx: d.idx,
        startTime: d.startTime,
        endTime: d.endTime,
        segmentType: d.segmentType,
        dialogue: d.dialogue,
        knowledgePoint: d.knowledgePoint,
        scene: null,
        emotion: null,
        shotType: null,
        sourceType: "PLATFORM_CALCULATED" as const,
      })),
    );
  }
  return loadContentSegments(contentId, executor);
}

/** 只读装载（GET timeline 用） */
export async function loadContentSegments(
  contentId: string,
  executor: Executor = db,
): Promise<SegmentRow[]> {
  return executor
    .select()
    .from(videoSegments)
    .where(eq(videoSegments.contentId, contentId))
    .orderBy(asc(videoSegments.idx));
}
