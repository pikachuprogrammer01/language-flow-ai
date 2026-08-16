/**
 * 视频渲染服务（docs/10 §二/§六/§七）
 * 编排：选 Renderer → 帧渲染 → FFmpeg 合成（帧序列 + TTS 音频 → MP4）
 * 失败路径：FFmpeg 失败删除半成品 MP4；临时目录 finally 清理，不保留半成品
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ContentDTO, TemplateType } from "@ai-english/shared";
import { logger } from "../lib/logger";
import { QuizRenderer } from "../renderer/quiz.renderer";
import type { RenderFrame, TemplateRenderer } from "../renderer/renderer.interface";
import { SceneWordRenderer } from "../renderer/scene-word.renderer";
import { WordCardRenderer } from "../renderer/word-card.renderer";

const execFileAsync = promisify(execFile);

const RENDER_TEMP_DIR = process.env.RENDER_TEMP_DIR ?? "/tmp/language-flow-render";
const UPLOADS_DIR = join(import.meta.dirname, "../../uploads");

export interface RenderVideoResult {
  url: string;
  duration: number;
  resolution: string;
  format: string;
  size: number;
}

const renderers: Record<TemplateType, TemplateRenderer> = {
  scene_word: new SceneWordRenderer(),
  word_card: new WordCardRenderer(),
  quiz: new QuizRenderer(),
};

/**
 * FFmpeg 合成（docs/10 §六）：
 * 每帧以指定时长循环为视频输入，filter_complex 逐帧 scale + concat，叠加 TTS 音频
 */
export async function composeVideo(
  frames: RenderFrame[],
  audioPath: string,
  outputPath: string,
): Promise<void> {
  const inputs = frames.flatMap((f) => [
    "-loop",
    "1",
    "-t",
    f.duration.toFixed(2),
    "-i",
    f.filePath,
  ]);
  const scaleFilters = frames.map((_, i) => `[${i + 1}:v]scale=1080:1920,setsar=1[v${i}]`);
  const concatFilter = `${frames.map((_, i) => `[v${i}]`).join("")}concat=n=${frames.length}:v=1:a=0[vout]`;
  const args = [
    "-y",
    "-i",
    audioPath,
    ...inputs,
    "-filter_complex",
    `${scaleFilters.join(";")};${concatFilter}`,
    "-map",
    "[vout]",
    "-map",
    "0:a",
    "-r",
    "25",
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-shortest",
    "-movflags",
    "+faststart",
    outputPath,
  ];
  await execFileAsync("ffmpeg", args, { timeout: 120_000 });
}

/** /files/audio/xxx.mp3 → uploads/audio/xxx.mp3（只取 basename，防路径穿越） */
function localFilePathFromUrl(url: string): string {
  const filename = basename(new URL(url, "http://local").pathname);
  if (!filename || filename.includes("..")) {
    throw new Error(`非法的媒体 URL: ${url}`);
  }
  return join(UPLOADS_DIR, "audio", filename);
}

/** 渲染 ContentDTO 为 MP4 视频，返回产物元数据 */
export async function renderVideo(dto: ContentDTO): Promise<RenderVideoResult> {
  const { audio } = dto;
  if (!audio) {
    throw new Error("ContentDTO 缺少 audio 字段");
  }

  const workDir = join(RENDER_TEMP_DIR, dto.id);
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  const outputPath = join(UPLOADS_DIR, "video", `${randomUUID()}.mp4`);
  try {
    const renderer = renderers[dto.template];
    const result = await renderer.render(dto, workDir);

    await mkdir(dirname(outputPath), { recursive: true });
    try {
      await composeVideo(result.frames, localFilePathFromUrl(audio.url), outputPath);
    } catch (err) {
      // FFmpeg 失败：删除半成品 MP4，不保留（docs/10 §七）
      await rm(outputPath, { force: true }).catch(() => {});
      throw err;
    }

    const { size } = await stat(outputPath);
    logger.info(
      { template: dto.template, frames: result.frames.length, duration: result.totalDuration },
      "video rendered",
    );
    return {
      url: `/files/video/${basename(outputPath)}`,
      duration: result.totalDuration,
      resolution: "1080x1920",
      format: "mp4",
      size,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
