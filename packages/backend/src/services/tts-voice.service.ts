/**
 * 配音音色目录服务（docs/24）
 *
 * 目录从硬编码搬进数据库只有一个理由：上下架必须能在界面完成。留在代码里意味着
 * 每下架一个音色都要走一次生产发布，而音色可用性是外部端点决定的、会变的事实。
 *
 * 两条不变量（沿用 lib/tts-catalog 既有口径，不因搬家而改变）：
 * 1. 下架只影响「新合成」——已下架音色仍在 knownVoiceIds 里，存量内容引用的音色
 *    可以回显和重配发布配置，不会因为运营下架动作把历史数据变成非法值；
 * 2. engine='local' 依赖宿主机 say，非 darwin 环境不出下拉——否则用户必然选到一个
 *    注定失败的音色（生产是 Linux 容器，这条一直在挡这个坑）。
 */
import { eq } from "drizzle-orm";
import { db } from "../db";
import { ttsVoices } from "../db/schema";

export type VoiceEngine = "edge" | "local";
export type VoiceCheckStatus = "ok" | "no_audio" | "rate_limited" | "handshake_failed" | "error";

export interface TtsVoiceRow {
  id: string;
  label: string;
  gender: string;
  engine: VoiceEngine;
  enabled: boolean;
  lastCheckAt: Date | null;
  lastCheckStatus: VoiceCheckStatus | null;
  lastCheckDetail: string | null;
}

/** 对外契约里的音色条目（GET /api/tts/voices 既有结构，不新增必填字段） */
export interface VoiceCatalogItem {
  id: string;
  name: string;
  gender: string;
}

/** 目录读多写极少，30 秒缓存让每次合成不必打库；写操作主动失效 */
const CACHE_TTL_MS = 30_000;
let cache: { at: number; rows: TtsVoiceRow[] } | null = null;

export function invalidateVoiceCatalogCache(): void {
  cache = null;
}

function toRow(r: typeof ttsVoices.$inferSelect): TtsVoiceRow {
  return {
    id: r.id,
    label: r.label,
    gender: r.gender,
    engine: r.engine,
    enabled: r.enabled === 1,
    lastCheckAt: r.lastCheckAt,
    lastCheckStatus: r.lastCheckStatus,
    lastCheckDetail: r.lastCheckDetail,
  };
}

/** 全量目录（含已下架）：能用的排前面，其次上架的，Edge 在本地音色之前，最后按 id */
export async function loadVoiceCatalog(
  platform: NodeJS.Platform = process.platform,
): Promise<TtsVoiceRow[]> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.rows;
  const rows = await db.select().from(ttsVoices);
  const local = isLocalEngineUsable(platform);
  const rank = (v: TtsVoiceRow): number =>
    v.enabled && (v.engine === "edge" || local) ? 0 : v.enabled ? 1 : 2;
  cache = {
    at: now,
    rows: rows
      .map(toRow)
      .sort(
        (a, b) =>
          rank(a) - rank(b) ||
          (a.engine === b.engine ? 0 : a.engine === "edge" ? -1 : 1) ||
          a.id.localeCompare(b.id),
      ),
  };
  return cache.rows;
}

/** 本地引擎在当前运行环境是否可用（容器内 say 不存在） */
export function isLocalEngineUsable(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin";
}

/** 可选音色：上架 + 引擎在当前环境真的能用 */
export async function selectableVoices(
  platform: NodeJS.Platform = process.platform,
): Promise<TtsVoiceRow[]> {
  const local = isLocalEngineUsable(platform);
  const rows = await loadVoiceCatalog();
  return rows.filter((v) => v.enabled && (v.engine === "edge" || local));
}

/** 对外音色列表（保持既有 {id,name,gender} 结构） */
export async function voiceCatalogItems(
  platform: NodeJS.Platform = process.platform,
): Promise<VoiceCatalogItem[]> {
  const rows = await selectableVoices(platform);
  return rows.map((v) => ({ id: v.id, name: v.label, gender: v.gender }));
}

/** 白名单口径：目录里存在即可（含已下架），与「能不能选」解耦 */
export async function knownVoiceIds(): Promise<string[]> {
  return (await loadVoiceCatalog()).map((v) => v.id);
}

export async function isVoiceKnown(voiceId: string): Promise<boolean> {
  return (await knownVoiceIds()).includes(voiceId);
}

/** 合成前置校验：下架或本环境用不了的音色直接拒，不打到远端换回一个难懂的 500 */
export async function isVoiceSelectable(
  voiceId: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  return (await selectableVoices(platform)).some((v) => v.id === voiceId);
}

export type SetEnabledResult = { kind: "updated"; voice: TtsVoiceRow } | { kind: "not-found" };

export async function setVoiceEnabled(
  voiceId: string,
  enabled: boolean,
): Promise<SetEnabledResult> {
  const [row] = await db.select().from(ttsVoices).where(eq(ttsVoices.id, voiceId));
  if (!row) return { kind: "not-found" };
  await db
    .update(ttsVoices)
    .set({ enabled: enabled ? 1 : 0 })
    .where(eq(ttsVoices.id, voiceId));
  invalidateVoiceCatalogCache();
  return { kind: "updated", voice: toRow({ ...row, enabled: enabled ? 1 : 0 }) };
}

/** 「测一次」结果落库：状态与细节都记，界面据此决定能不能上线 */
export async function recordVoiceProbe(
  voiceId: string,
  status: VoiceCheckStatus,
  detail: string,
): Promise<void> {
  await db
    .update(ttsVoices)
    .set({
      lastCheckAt: new Date(),
      lastCheckStatus: status,
      lastCheckDetail: detail.slice(0, 200),
    })
    .where(eq(ttsVoices.id, voiceId));
  invalidateVoiceCatalogCache();
}
