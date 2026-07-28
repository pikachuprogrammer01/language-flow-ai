import { randomUUID } from "node:crypto";
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
