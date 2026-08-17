/**
 * 视频渲染服务（docs/10 §二/§六/§七）
 * 编排：选 Renderer → 帧渲染 → FFmpeg 合成（帧序列 + TTS 音频 → MP4）
 * 失败路径：FFmpeg 失败删除半成品 MP4；临时目录 finally 清理，不保留半成品
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ContentDTO, TemplateType } from "@ai-english/shared";
import { logger } from "../lib/logger";
import { QuizRenderer } from "../renderer/quiz.renderer";
import type { RenderFrame, TemplateRenderer } from "../renderer/renderer.interface";
import { SceneWordRenderer } from "../renderer/scene-word.renderer";
import { WordCardRenderer } from "../renderer/word-card.renderer";
import { buildQuizItemText, getAudioDuration, synthesizeSpeech } from "./tts.service";

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
  bgmPath?: string,
  beepTimes?: number[],
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
  // BGM 混音（可选）：循环背景音乐、降音量后与配音混合（配音为主，BGM 垫底）
  const bgmArgs = bgmPath ? ["-stream_loop", "-1", "-i", bgmPath] : [];
  // 提示音（可选，quiz 答案帧起点）：880Hz 0.25s 短音，按 beepTimes 延时至对应时刻后混入
  const beepArgs =
    beepTimes && beepTimes.length > 0
      ? ["-f", "lavfi", "-t", "0.25", "-i", "sine=frequency=880:sample_rate=44100"]
      : [];
  const beepIdx = frames.length + 1 + (bgmPath ? 1 : 0);
  const beepFilters =
    beepTimes && beepTimes.length > 0
      ? (() => {
          const split = `[${beepIdx}:a]asplit=${beepTimes.length}${beepTimes
            .map((_, i) => `[beep${i}]`)
            .join("")}`;
          const delays = beepTimes
            .map(
              (t, i) => `[beep${i}]adelay=${Math.round(t * 1000)}|${Math.round(t * 1000)}[b${i}]`,
            )
            .join(";");
          return `${split};${delays}`;
        })()
      : "";
  const baseAudio = bgmPath
    ? `[0:a]volume=1.0[a0];[${frames.length + 1}:a]volume=0.12,afade=t=out:st=${frames.reduce((n, f) => n + f.duration, 0) - 2}:d=2[a1];[a0][a1]amix=inputs=2:duration=first:dropout_transition=2[base]`
    : "[0:a]volume=1.0[base]";
  const beepMix =
    beepTimes && beepTimes.length > 0
      ? `[base]${beepTimes.map((_, i) => `[b${i}]`).join("")}amix=inputs=${beepTimes.length + 1}:duration=first:dropout_transition=0.5[aout]`
      : "[base]anull[aout]";
  const audioFilters = [beepFilters, baseAudio, beepMix].filter(Boolean).join(";");
  const args = [
    "-y",
    "-i",
    audioPath,
    ...inputs,
    ...bgmArgs,
    ...beepArgs,
    "-filter_complex",
    `${scaleFilters.join(";")};${concatFilter};${audioFilters}`,
    "-map",
    "[vout]",
    "-map",
    "[aout]",
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

/** /files/audio|bgm/xxx.mp3 → uploads 对应目录的本地路径（只取 basename + 白名单目录，防路径穿越） */
function localFilePathFromUrl(url: string, kind: "audio" | "bgm" = "audio"): string {
  const filename = basename(new URL(url, "http://local").pathname);
  if (!filename || filename.includes("..")) {
    throw new Error(`非法的媒体 URL: ${url}`);
  }
  return join(UPLOADS_DIR, kind, filename);
}

/**
 * 逐项合成音画对齐（quiz 逐题 / word_card 逐卡，用户确认 2026-08-18）：
 * 每项音频 + 静音间隔拼接为对齐音频——画面帧时长 = 该项实际朗读时长 + 间隔（不估算，读完即切）
 * quiz：间隔 4.3s（1s 缓冲 + 2.5s 答案 + 0.8s 题间）；word_card：间隔 1.2s（卡间缓冲）
 */
async function preparePerItemAudio(
  dto: ContentDTO,
  workDir: string,
): Promise<{ audioPath: string; itemDurations: number[] } | null> {
  if (dto.template !== "quiz" && dto.template !== "word_card") return null;
  const items = dto.content as unknown as Record<string, unknown>[];
  const voice = (dto.voice as { id?: string } | undefined)?.id;
  const itemToText =
    dto.template === "quiz"
      ? (item: Record<string, unknown>) => buildQuizItemText(item)
      : (item: Record<string, unknown>) =>
          `${item.word ?? ""} ${item.meaning ?? ""} ${item.example ?? ""} ${item.exampleMeaning ?? ""}`;
  const GAP = dto.template === "quiz" ? 4.3 : 0.8;
  const prefix = dto.template === "quiz" ? "quiz" : "card";
  const inputs: string[] = [];
  const itemDurations: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const text = itemToText(items[i]);
    if (!text) continue;
    try {
      const buf = await synthesizeSpeech(text, voice);
      const filePath = join(workDir, `${prefix}-${i}.aiff`);
      await writeFile(filePath, buf);
      itemDurations.push(await getAudioDuration(filePath));
      inputs.push(filePath);
    } catch (err) {
      // 单项合成失败（Edge 波动）：整体回退旧链路（整段音频 + 估算帧时长），不阻塞渲染
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), i, template: dto.template },
        "逐项合成失败，回退整段音频",
      );
      return null;
    }
  }
  if (inputs.length === 0) return null;
  const silencePath = join(workDir, `${prefix}-silence.aiff`);
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=22050:cl=mono",
      "-t",
      String(GAP),
      "-f",
      "aiff",
      silencePath,
    ],
    { timeout: 30_000 },
  );
  const concatInputs = inputs.flatMap((f) => ["-i", f, "-i", silencePath]);
  const concatFilter = `[${Array.from({ length: inputs.length * 2 }, (_, i) => `${i}:a`).join("][")}]concat=n=${inputs.length * 2}:v=0:a=1[aout]`;
  const alignedPath = join(workDir, `${prefix}-aligned.aiff`);
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      ...concatInputs,
      "-filter_complex",
      concatFilter,
      "-map",
      "[aout]",
      "-f",
      "aiff",
      alignedPath,
    ],
    { timeout: 60_000 },
  );
  return { audioPath: alignedPath, itemDurations };
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
    // 音画对齐：quiz 逐题 / word_card 逐卡合成（帧时长 = 实际朗读时长 + 间隔，不估算）
    let audioPath = localFilePathFromUrl(audio.url);
    let renderExtra: { itemDurations?: number[] } | undefined;
    const prepared = await preparePerItemAudio(dto, workDir);
    if (prepared) {
      audioPath = prepared.audioPath;
      renderExtra = { itemDurations: prepared.itemDurations };
    }
    const result = await renderer.render(dto, workDir, renderExtra);

    await mkdir(dirname(outputPath), { recursive: true });
    try {
      // style.bgm（可选）：组装时选择背景音乐混音（docs/13 素材清单；BGM 音量 0.12 垫底）
      const bgm = dto.style?.bgm;
      await composeVideo(
        result.frames,
        audioPath,
        outputPath,
        bgm ? localFilePathFromUrl(bgm, "bgm") : undefined,
        result.beepTimes,
      );
    } catch (err) {
      // FFmpeg 失败：删除半成品 MP4，不保留（docs/10 §七）
      await rm(outputPath, { force: true }).catch(() => {});
      throw err;
    }

    const { size } = await stat(outputPath);
    // 实际时长以输出文件 ffprobe 为准（逐项合成后帧总和可能 ≠ 传入 audio.duration）
    const actualDuration = await getAudioDuration(outputPath);
    logger.info(
      { template: dto.template, frames: result.frames.length, duration: actualDuration },
      "video rendered",
    );
    return {
      url: `/files/video/${basename(outputPath)}`,
      duration: actualDuration,
      resolution: "1080x1920",
      format: "mp4",
      size,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
