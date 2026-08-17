/**
 * TTS 路由
 * POST /api/tts/generate       — 底层：接收纯文本（已发布契约，保持兼容）
 * POST /api/tts/from-content   — 内容生成/前端使用：接收 ContentArray，后端拼接 + 合成 + 返回音频元数据
 * 契约详见 SPEC.md §5.2（@hono/zod-openapi）
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { logger } from "../lib/logger";
import { buildTtsText, getAudioDuration, synthesizeSpeech } from "../services/tts.service";

// ── Zod schema ──

const ttsSchema = z.object({
  text: z.string().min(1).max(2000),
  voice: z.string().optional().default("zh-CN-XiaoxiaoNeural"),
});

/** 常用中文配音（edge-tts 支持，2026-08-17 整理；PRD §10.1.1 配音可选） */
/** Mac 本地音色（say 可用中文音色：Tingting 普通话；Sinji/Meijia 粤语；Eddy 等需下载暂不可用） */
export const MAC_VOICES = [
  { id: "Tingting", name: "婷婷（普通话·本地）", gender: "女" },
  { id: "Sinji", name: "阿欣（粤语·本地）", gender: "女" },
  { id: "Meijia", name: "美佳（粤语·本地）", gender: "女" },
];

/** TTS 引擎（与 tts.service 对齐：mac 默认 / edge 可选） */
const TTS_ENGINE = process.env.TTS_ENGINE ?? "edge"; // edge 默认（音色多）；mac 可经 env 切换（本地稳定）

export const TTS_VOICES = [
  { id: "zh-CN-XiaoxiaoNeural", name: "晓晓（女·温暖）", gender: "女" },
  { id: "zh-CN-XiaoyiNeural", name: "晓伊（女·活泼）", gender: "女" },
  { id: "zh-CN-YunxiNeural", name: "云希（男·阳光）", gender: "男" },
  { id: "zh-CN-YunjianNeural", name: "云健（男·浑厚）", gender: "男" },
  { id: "zh-CN-YunyangNeural", name: "云扬（男·新闻）", gender: "男" },
  { id: "zh-CN-XiaochenNeural", name: "晓辰（女·温柔）", gender: "女" },
  { id: "zh-CN-XiaohanNeural", name: "晓涵（女·知性）", gender: "女" },
  { id: "zh-CN-XiaomengNeural", name: "晓梦（女·少年感）", gender: "女" },
];

// content 为上游传入的动态 JSON（AGENTS.md §3.1：Record<string, unknown> 例外）
const fromContentSchema = z.object({
  content: z.array(z.record(z.string(), z.unknown())).min(1).max(100),
  template: z.enum(["scene_word", "word_card", "quiz"]),
  voice: z.string().optional().default("zh-CN-XiaoxiaoNeural"),
  title: z.string().max(100).optional(), // scene_word 标题朗读（可选，向后兼容）
});

const ttsResponseSchema = z.object({
  success: z.boolean(),
  filename: z.string(),
  url: z.string(),
});

const audioSchema = z.object({
  url: z.string(),
  duration: z.number(),
  format: z.string(),
});

const audioResponseSchema = z.object({ audio: audioSchema });

// ── 路由定义 ──

const generateRoute = createRoute({
  method: "post",
  path: "/generate",
  summary: "TTS 底层接口（纯文本合成，已发布契约）",
  request: {
    body: { content: { "application/json": { schema: ttsSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: ttsResponseSchema } },
      description: "合成成功，返回音频文件信息",
    },
    400: { description: "参数不合法" },
    500: { description: "TTS 引擎错误" },
  },
});

const fromContentRoute = createRoute({
  method: "post",
  path: "/from-content",
  summary: "按模板拼接朗读文本并合成（返回音频元数据）",
  request: {
    body: { content: { "application/json": { schema: fromContentSchema } } },
  },
  responses: {
    200: {
      content: { "application/json": { schema: audioResponseSchema } },
      description: "合成成功（url/duration/format）",
    },
    400: { description: "content 无法拼出文本 / 超 2000 字符" },
    500: { description: "TTS 引擎错误" },
  },
});

// ── 内部工具 ──

/** 写 MP3 文件并用 ffprobe 探测时长，返回文件信息 */
async function saveAudio(
  buffer: Buffer,
): Promise<{ filename: string; url: string; duration: number; format: string }> {
  const filename = `${randomUUID()}.mp3`;
  const dir = join(import.meta.dirname, "../../uploads/audio");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, filename);
  await writeFile(filePath, buffer);
  const duration = await getAudioDuration(filePath);
  return { filename, url: `/files/audio/${filename}`, duration, format: "mp3" };
}

// ── 路由注册 ──

export const tts = new OpenAPIHono({
  // 校验失败打日志（定位前端 400 根因）
  defaultHook: (result, c) => {
    if (!result.success) {
      logger.warn({ issues: result.error.issues, path: c.req.path }, "tts 请求校验失败");
    }
  },
})
  .openapi(generateRoute, async (c): Promise<Response> => {
    const { text, voice } = c.req.valid("json");
    try {
      const audio = await synthesizeSpeech(text, voice);
      const { filename, url } = await saveAudio(audio);
      logger.info({ filename, textLength: text.length }, "tts file saved");
      return c.json({ success: true, filename, url });
    } catch (err) {
      logger.error({ err }, "tts generate failed");
      return c.json({ error: "TTS synthesis failed" }, 500);
    }
  })
  .openapi(fromContentRoute, async (c): Promise<Response> => {
    const { content, template, voice, title } = c.req.valid("json");
    try {
      const text = buildTtsText(content, template, title);
      if (text.length === 0) {
        return c.json({ error: "content 无法拼出朗读文本" }, 400);
      }
      // 与 generate 契约对齐：单次合成文本上限 2000 字符（中文朗读后 word_card/quiz 拼接可达 800-1000 字）
      if (text.length > 2000) {
        return c.json({ error: "拼接文本超过 2000 字符上限" }, 400);
      }
      const audio = await synthesizeSpeech(text, voice);
      const { url, duration, format } = await saveAudio(audio);
      logger.info({ template, duration, textLength: text.length }, "tts from-content saved");
      return c.json({ audio: { url, duration, format } });
    } catch (err) {
      logger.error({ err }, "tts from-content failed");
      return c.json({ error: "TTS synthesis failed" }, 500);
    }
  })
  .openapi(
    createRoute({
      method: "get",
      path: "/voices",
      summary: "可用配音列表（音色/性别）",
      responses: {
        200: {
          description: "配音列表",
          content: {
            "application/json": {
              schema: z.object({
                voices: z.array(z.object({ id: z.string(), name: z.string(), gender: z.string() })),
                default: z.string(),
              }),
            },
          },
        },
      },
      tags: ["tts"],
    }),
    async (c) =>
      c.json({
        voices: TTS_ENGINE === "mac" ? MAC_VOICES : TTS_VOICES,
        default: TTS_ENGINE === "mac" ? "Tingting" : "zh-CN-XiaoxiaoNeural",
      }),
  );
