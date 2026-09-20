/**
 * 配音音色 / BGM 素材权威目录（F6 单一校验来源）
 * 音色枚举从 routes/tts.ts 迁入此处，tts 路由与 video-analytics 校验共用同一份；
 * BGM 允许集 = uploads/bgm 目录实际文件（与 /api/files?type=bgm、前端 BGM 选择同源）。
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

export interface VoiceCatalogItem {
  id: string;
  name: string;
  gender: string;
}

/** Mac 本地音色（say 可用中文音色：Tingting 普通话；Sinji/Meijia 粤语） */
export const MAC_VOICES: VoiceCatalogItem[] = [
  { id: "Tingting", name: "婷婷（普通话·本地）", gender: "女" },
  { id: "Sinji", name: "阿欣（粤语·本地）", gender: "女" },
  { id: "Meijia", name: "美佳（粤语·本地）", gender: "女" },
];

/** 常用中文配音（edge-tts 支持；PRD §10.1.1 配音可选，2026-08-17 整理） */
export const TTS_VOICES: VoiceCatalogItem[] = [
  { id: "zh-CN-XiaoxiaoNeural", name: "晓晓（女·温暖）", gender: "女" },
  { id: "zh-CN-XiaoyiNeural", name: "晓伊（女·活泼）", gender: "女" },
  { id: "zh-CN-YunxiNeural", name: "云希（男·阳光）", gender: "男" },
  { id: "zh-CN-YunjianNeural", name: "云健（男·浑厚）", gender: "男" },
  { id: "zh-CN-YunyangNeural", name: "云扬（男·新闻）", gender: "男" },
  { id: "zh-CN-XiaochenNeural", name: "晓辰（女·温柔）", gender: "女" },
  { id: "zh-CN-XiaohanNeural", name: "晓涵（女·知性）", gender: "女" },
  { id: "zh-CN-XiaomengNeural", name: "晓梦（女·少年感）", gender: "女" },
];

const UPLOADS_DIR = join(import.meta.dirname, "../../uploads");

/** 全部合法音色 id（edge-tts + Mac 本地），供 select 列表与后端白名单校验共用 */
export function allVoiceIds(): string[] {
  return [...TTS_VOICES, ...MAC_VOICES].map((v) => v.id);
}

export function isVoiceAllowed(voiceId: string): boolean {
  return allVoiceIds().includes(voiceId);
}

/** uploads/bgm 下现有素材文件名（目录不存在时返回空，不抛） */
export function listBgmFiles(): string[] {
  try {
    return readdirSync(join(UPLOADS_DIR, "bgm"));
  } catch {
    return [];
  }
}

/**
 * BGM 引用值形如 "/files/bgm/<filename>"，校验其文件名存在于素材目录。
 * null / 空串表示"无 BGM"（允许）。防路径穿越：仅取 basename 再比对目录清单。
 */
export function isBgmAllowed(bgmRef: string | null | undefined): boolean {
  if (bgmRef === null || bgmRef === undefined || bgmRef === "") return true;
  const filename = bgmRef.split("/").pop();
  if (!filename || filename !== bgmRef.replace(/^\/files\/bgm\//, "")) return false;
  return listBgmFiles().includes(filename);
}
