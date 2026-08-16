import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { TemplateType } from "@ai-english/shared";
import WebSocket from "ws";
import { logger } from "../lib/logger";

// Edge TTS — 微软公开的浏览器朗读接口
// 来源: https://github.com/rany2/edge-tts

const EDGE_TTS_URL =
  "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4";

// 中文女声 — 微软最高质量中文神经语音
const DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural";

/**
 * 通过 WebSocket 连接 Edge TTS 服务，将中文文本合成 MP3
 * 返回音频 Buffer，可直接写入文件或返回前端
 */
export async function synthesizeSpeech(text: string, voice = DEFAULT_VOICE): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(EDGE_TTS_URL, {
      headers: {
        Origin: "https://www.bing.com",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
      },
    });

    const audioChunks: Buffer[] = [];
    let ssmlSent = false;

    ws.on("open", () => {
      // Step 1 — 发送合成配置
      const timestamp = Date.now().toString();
      const configMessage = `X-Timestamp:${timestamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${JSON.stringify(
        {
          context: {
            synthesis: {
              audio: {
                metadataoptions: {
                  sentenceBoundaryEnabled: false,
                  wordBoundaryEnabled: false,
                },
                outputFormat: "audio-24khz-48kbitrate-mono-mp3",
              },
            },
          },
        },
      )}`;

      ws.send(configMessage);
    });

    ws.on("message", (data: Buffer) => {
      const message = data.toString();

      // Edge TTS 返回的每条消息以 Path: 开头，后面是二进制数据
      if (message.includes("Path:turn.start")) {
        // TTS 开始，发送 SSML
        const requestId = randomUUID();
        const ssml = `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="zh-CN"><voice name="${voice}">${escapeXml(text)}</voice></speak>`;

        ws.send(ssml);
        ssmlSent = true;
      } else if (message.includes("Path:audio")) {
        // 音频数据 — 二进制部分在 header 后面
        const headerEnd = data.indexOf(Buffer.from("\r\n\r\n")) + 4;
        if (headerEnd > 3) {
          audioChunks.push(data.subarray(headerEnd));
        }
      } else if (message.includes("Path:turn.end")) {
        // TTS 结束，正常关闭
        ws.close();
      }
    });

    ws.on("close", () => {
      if (audioChunks.length === 0) {
        reject(new Error("No audio data received from Edge TTS"));
      } else {
        const audio = Buffer.concat(audioChunks);
        logger.info({ textLength: text.length, audioSize: audio.length }, "tts synthesized");
        resolve(audio);
      }
    });

    ws.on("error", (err) => {
      logger.error({ err }, "Edge TTS WebSocket error");
      reject(err);
    });

    // 超时保护：30 秒
    setTimeout(() => {
      if (!ssmlSent || audioChunks.length === 0) {
        ws.close();
        reject(new Error("Edge TTS timed out"));
      }
    }, 30_000);
  });
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ── 文本拼接（docs/03 模块 4 / SPEC §5.2 规则） ──
// content 元素来自 Dify 传入的动态 JSON，用 Record<string, unknown> 防御性读取
// （AGENTS.md §3.1：Dify 输入参数 Record<string, unknown> 例外）

type JsonRecord = Record<string, unknown>;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 去除文本尾部标点（用于 word_card/quiz 的 ". " 连接） */
function stripTrailingPunct(text: string): string {
  return text.trim().replace(/[。.！？!?，,]+$/, "");
}

/** 保证文本以指定标点结尾（避免 join 时出现重复标点；逗号视为已结尾） */
function ensureEndPunct(text: string, punct = "。"): string {
  const t = text.trim();
  if (!t) return "";
  return /[。.！？!?，,]$/.test(t) ? t : `${t}${punct}`;
}

/**
 * 按模板将 ContentArray 拼为朗读文本（规则见 SPEC §5.2 拼接规则表）
 * 空 segment/空字段自动跳过（对应"空 segment 丢弃"约定，SPEC §6.2.6）
 */
export function buildTtsText(content: JsonRecord[], template: TemplateType): string {
  switch (template) {
    case "scene_word":
      return content
        .map((s) => {
          const words = Array.isArray(s.words) ? (s.words as JsonRecord[]) : [];
          const wordText = words
            .map((w) => [str(w.word), str(w.meaning)].filter(Boolean).join("，"))
            .map((t) => ensureEndPunct(t))
            .join("");
          return [ensureEndPunct(str(s.text)), wordText].join("");
        })
        .join("");
    case "word_card":
      return content
        .map((card) => {
          const parts = [str(card.word), str(card.pos), str(card.example)]
            .map(stripTrailingPunct)
            .filter(Boolean)
            .join(". ");
          return parts ? `${parts}.` : "";
        })
        .filter(Boolean)
        .join(" ");
    case "quiz":
      return content
        .map((q) => {
          const options = Array.isArray(q.options) ? (q.options as unknown[]) : [];
          // 选项上限 4 个（QuizItem 契约），超出截断避免字母越界（A-D）
          const optionText = options
            .slice(0, 4)
            .map((opt, i) => `${String.fromCharCode(65 + i)}. ${stripTrailingPunct(str(opt))}`)
            .join(". ");
          if (!optionText) return "";
          const stem = ensureEndPunct(str(q.stem));
          return stem ? `${stem} ${optionText}.` : `${optionText}.`;
        })
        .filter(Boolean)
        .join(" ");
  }
}

const execFileAsync = promisify(execFile);

/**
 * 用 ffprobe 探测音频时长（秒，浮点）
 * ffprobe 不可用、输出无法解析或文件损坏时抛错 → 上层返回 500
 */
export async function getAudioDuration(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ],
    { timeout: 10_000 },
  );
  const duration = Number.parseFloat(stdout.trim());
  if (Number.isNaN(duration)) {
    throw new Error(`无法解析 ffprobe 输出的时长: "${stdout.trim()}"`);
  }
  return duration;
}
