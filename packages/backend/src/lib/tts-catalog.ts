/**
 * BGM 素材目录校验（F6 单一来源）
 * BGM 允许集 = uploads/bgm 目录实际文件（与 /api/files?type=bgm、前端 BGM 选择同源）。
 *
 * 音色目录已搬家到数据库表 tts_voices + services/tts-voice.service（docs/24）：
 * 上下架要能在界面完成，不能每改一次音色就走一次生产发布。
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { UPLOADS_DIR } from "./uploads-path";

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
