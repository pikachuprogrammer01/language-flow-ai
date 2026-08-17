import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { TemplateType } from "@ai-english/shared";
import WebSocket, { type RawData } from "ws";
import { logger } from "../lib/logger";

// Edge TTS — 微软公开的浏览器朗读接口
// 来源: https://github.com/rany2/edge-tts（2026-08 master）
// 服务端要求：Sec-MS-GEC 时间戳签名（hex 大写、向下取整到 5 分钟）+ Cookie muid，
// 缺失或算法不符返回 403

const EDGE_TTS_BASE_URL =
  "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const EDGE_TTS_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
// 与 edge-tts master 对齐：Chromium 143
const SEC_MS_GEC_VERSION = "1-143.0.3650.75";

/** 生成带 Sec-MS-GEC 签名的 WebSocket 连接 URL（每次请求新建） */
function buildEdgeTtsUrl(): string {
  // 1. unix 秒 + 1601 纪元偏移 → 向下取整到 5 分钟 → ×10^7 转 100ns 间隔
  //    （取整后值恰为 32 的倍数，float 可精确表示，BigInt 计算结果与 edge-tts 一致）
  const ticksFloat = Math.floor(Date.now() / 1000) + 11644473600;
  const ticks = BigInt(ticksFloat - (ticksFloat % 300)) * 10000000n;
  // 2. sha256(`${ticks}${token}`) 的 hex 大写
  const secMsGec = createHash("sha256")
    .update(`${ticks}${EDGE_TTS_TOKEN}`)
    .digest("hex")
    .toUpperCase();
  return (
    `${EDGE_TTS_BASE_URL}?TrustedClientToken=${EDGE_TTS_TOKEN}` +
    `&ConnectionId=${randomUUID()}` +
    `&Sec-MS-GEC=${secMsGec}` +
    `&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`
  );
}

// 中文女声 — 微软最高质量中文神经语音
const DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural";

/**
 * 通过 WebSocket 连接 Edge TTS 服务，将中文文本合成 MP3
 * 返回音频 Buffer，可直接写入文件或返回前端
 */
/** 单次合成（含一次自动重试：Edge TTS 偶发断开/无数据，2026-08-18 用户反馈 500 后无法继续） */
export async function synthesizeSpeech(text: string, voice = DEFAULT_VOICE): Promise<Buffer> {
  try {
    return await synthesizeOnce(text, voice);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "tts 首次合成失败，重试一次",
    );
    await new Promise((r) => setTimeout(r, 500));
    return synthesizeOnce(text, voice);
  }
}

function synthesizeOnce(text: string, voice = DEFAULT_VOICE): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(buildEdgeTtsUrl(), {
      // 禁用 permessage-deflate：服务端对压缩消息分片发送，ws 库不重组（分片数组导致提取失败）
      perMessageDeflate: false,
      headers: {
        // Origin 与 muid Cookie 必须与 edge-tts 一致（DRM 反滥用），否则服务端 403
        Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        Cookie: `muid=${randomBytes(16).toString("hex").toUpperCase()};`,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
        Pragma: "no-cache",
        "Cache-Control": "no-cache",
      },
    });

    const audioChunks: Buffer[] = [];
    let audioReceived = false;

    ws.on("open", () => {
      // edge-tts 新版协议：open 后立即连发 speech.config + SSML（不等 turn.start）
      const configMessage = `X-Timestamp:${dateToString()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${JSON.stringify(
        {
          context: {
            synthesis: {
              audio: {
                metadataoptions: {
                  sentenceBoundaryEnabled: "false",
                  wordBoundaryEnabled: "false",
                },
                outputFormat: "audio-24khz-48kbitrate-mono-mp3",
              },
            },
          },
        },
      )}\r\n`;
      ws.send(configMessage);

      const requestId = randomUUID();
      // SSML 必须含 <prosody>（服务端缺省拒绝）；X-Timestamp 尾随 Z 是微软端已知怪癖（edge-tts 注释）
      const ssml = `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${dateToString()}Z\r\nPath:ssml\r\n\r\n<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="zh-CN"><voice name="${voice}"><prosody pitch="+0Hz" rate="+0%" volume="+0%">${escapeXml(text)}</prosody></voice></speak>`;
      ws.send(ssml);
    });

    ws.on("message", (data: RawData) => {
      // 兼容分片：ws 对压缩消息可能回调 Buffer[]（各分片），先合并
      const buf = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data);
      const message = buf.toString();

      // Edge TTS 返回的每条消息以 Path: 开头，后面是二进制数据
      if (message.includes("Path:turn.start") || message.includes("Path:response")) {
        // 标记会话已开始（无业务处理，SSML 已在 open 时发送）
      } else if (message.includes("Path:audio")) {
        // 音频数据在 "Path:audio\r\n" 之后（新版协议 header 以单个 \r\n 结尾，不再有 \r\n\r\n 空行）
        const marker = Buffer.from("Path:audio\r\n");
        const markerIdx = buf.indexOf(marker);
        if (markerIdx > -1) {
          audioChunks.push(buf.subarray(markerIdx + marker.length));
          audioReceived = true;
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
      if (!audioReceived) {
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

/** edge-tts 的 X-Timestamp 格式（JS 风格）："Sun Nov 06 1994 08:49:37 GMT+0000 (Coordinated Universal Time)" */
function dateToString(): string {
  const d = new Date();
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${pad(d.getUTCDate())} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}

// ── 文本拼接（docs/03 模块 4 / SPEC §5.2 规则） ──
// content 元素来自 Dify 传入的动态 JSON，用 Record<string, unknown> 防御性读取
// （AGENTS.md §3.1：Dify 输入参数 Record<string, unknown> 例外）

type JsonRecord = Record<string, unknown>;

/** 剥离释义开头的词性前缀（如 "n.天花板" → "天花板"）：朗读时词性不读出 */
function stripPosPrefix(text: string): string {
  return text.replace(
    /^(?:n|vt|vi|v|adj|a|adv|ad|prep|conj|pron|aux|num|art|int|interj|abbr)\.\s*/,
    "",
  );
}

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

/** 正则特殊字符转义（用于 text 中定位英文词） */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 按模板将 ContentArray 拼为朗读文本（规则见 SPEC §5.2 拼接规则表）
 * 空 segment/空字段自动跳过（对应"空 segment 丢弃"约定，SPEC §6.2.6）
 * @param title 可选：scene_word 模板先朗读标题（英文词同样逆替换为中文）
 */
export function buildTtsText(
  content: JsonRecord[],
  template: TemplateType,
  title?: string,
): string {
  switch (template) {
    case "scene_word": {
      // 全中文朗读（用户确认 2026-08-17）：text 中英文词原位替换为中文释义，不再追加词条
      const wordMap = new Map(
        content.flatMap((s) => {
          const words = Array.isArray(s.words) ? (s.words as JsonRecord[]) : [];
          return words
            .map((w): [string, string] => [str(w.word).toLowerCase(), str(w.meaning)])
            .filter(([, meaning]) => meaning);
        }),
      );
      const toChinese = (text: string): string => {
        let t = text;
        for (const [word, meaning] of wordMap) {
          if (word) {
            t = t.replace(new RegExp(`\\b${escapeRegExp(word)}\\b`, "gi"), meaning);
          }
        }
        return t;
      };
      const titlePart = title ? ensureEndPunct(toChinese(title)) : "";
      const body = content.map((s) => ensureEndPunct(toChinese(str(s.text)))).join("");
      return `${titlePart}${body}`;
    }
    case "word_card":
      return content
        .map((card) => {
          // 全中文朗读（用户确认 2026-08-18）：词性不朗读，读 释义 + 例句 + 例句翻译
          const word = str(card.word);
          const meaning = stripPosPrefix(str(card.meaning));
          const example = str(card.example);
          const exampleMeaning = str(card.exampleMeaning);
          const head = [word, meaning].map(stripTrailingPunct).filter(Boolean).join("，");
          const parts = [head, example, exampleMeaning]
            .map(stripTrailingPunct)
            .filter(Boolean)
            .join("。");
          return parts ? `${parts}。` : "";
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
            .map(
              (opt, i) =>
                `${String.fromCharCode(65 + i)}. ${stripTrailingPunct(stripPosPrefix(str(opt)))}`,
            )
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
