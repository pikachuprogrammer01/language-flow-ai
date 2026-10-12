/**
 * TTS 路由
 * POST /api/tts/generate       — 底层：接收纯文本（已发布契约，保持兼容）
 * POST /api/tts/from-content   — 内容生成/前端使用：接收 ContentArray，后端拼接 + 合成 + 返回音频元数据
 * GET  /api/tts/voices         — 可选音色（含管理字段与全量目录，供音色管理页用）
 * PATCH /api/tts/voices/:id    — 上架 / 下架某个音色（docs/24：改数据即生效，不改代码）
 * POST /api/tts/voices/:id/probe — 「测一次」：实测该音色在当前端点能否出音频
 * 契约详见 SPEC.md §5.2（@hono/zod-openapi）
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { API_TAGS, apiErrorSchema } from "../lib/api-convention";
import { logger } from "../lib/logger";
import { UPLOADS_DIR } from "../lib/uploads-path";
import {
  type VoiceCheckStatus,
  isVoiceKnown,
  isVoiceSelectable,
  loadVoiceCatalog,
  recordVoiceProbe,
  setVoiceEnabled,
  voiceCatalogItems,
} from "../services/tts-voice.service";
import {
  TtsError,
  buildTtsText,
  getAudioDuration,
  synthesizeSpeech,
} from "../services/tts.service";

// ── Zod schema ──

const ttsSchema = z.object({
  rate: z.number().min(0.5).max(2).optional(),
  text: z.string().min(1).max(2000),
  voice: z.string().optional().default("zh-CN-XiaoxiaoNeural"),
});

/** 可用音色列表见 lib/tts-catalog（F6 单一来源，与 video-analytics 白名单校验共用） */

// content 为上游传入的动态 JSON（AGENTS.md §3.1：Record<string, unknown> 例外）
const fromContentSchema = z.object({
  content: z.array(z.record(z.string(), z.unknown())).min(1).max(100),
  template: z.enum(["scene_word", "word_card", "quiz"]),
  voice: z.string().optional().default("zh-CN-XiaoxiaoNeural"),
  /** 语速倍率（0.5-2，1 正常；MVP 需求 #5 语速调整） */
  rate: z.number().min(0.5).max(2).optional(),
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

/** 对外音色条目（既有结构，不新增必填字段） */
const voiceItemSchema = z.object({
  gender: z.string(),
  id: z.string(),
  name: z.string(),
});

/** 管理视图条目：上下架状态 + 最近一次实测结论 */
const managedVoiceSchema = voiceItemSchema.extend({
  checkDetail: z.string().nullable(),
  checkedAt: z.string().nullable(),
  enabled: z.boolean(),
  engine: z.enum(["edge", "local"]),
});

// ── 路由定义 ──

const generateRoute = createRoute({
  method: "post",
  path: "/generate",
  tags: [API_TAGS.tts],
  operationId: "generateTts",
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
    500: {
      description: "TTS 引擎错误（error 携真实原因）",
      content: { "application/json": { schema: apiErrorSchema } },
    },
  },
});

const fromContentRoute = createRoute({
  method: "post",
  path: "/from-content",
  tags: [API_TAGS.tts],
  operationId: "ttsFromContent",
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
    500: {
      description: "TTS 引擎错误（error 携真实原因）",
      content: { "application/json": { schema: apiErrorSchema } },
    },
  },
});

// ── 内部工具 ──

/** 写 MP3 文件并用 ffprobe 探测时长，返回文件信息 */
async function saveAudio(
  buffer: Buffer,
): Promise<{ filename: string; url: string; duration: number; format: string }> {
  const filename = `${randomUUID()}.mp3`;
  const dir = join(UPLOADS_DIR, "audio");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, filename);
  await writeFile(filePath, buffer);
  const duration = await getAudioDuration(filePath);
  return { filename, url: `/files/audio/${filename}`, duration, format: "mp3" };
}

/** 实测音频写临时目录、探完时长即删：音色探测不该在 uploads 里留孤儿文件 */
async function measureTempMp3(audio: Buffer): Promise<number> {
  const dir = await mkdtemp(join(tmpdir(), "lf-tts-probe-"));
  try {
    const file = join(dir, "probe.mp3");
    await writeFile(file, audio);
    return await getAudioDuration(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 合成失败类别 → 实测状态（界面按这个决定能不能上线） */
function probeStatusOf(err: unknown): VoiceCheckStatus {
  if (!(err instanceof TtsError)) return "error";
  switch (err.cls) {
    case "voice_unavailable":
      return "no_audio";
    case "rate_limited":
      return "rate_limited";
    case "handshake_failed":
      return "handshake_failed";
    default:
      return "error";
  }
}

/** 用固定短句实测一个音色（故意绕过上下架：下架音色也要能重新验活） */
async function probeVoiceAudio(
  voice: string,
): Promise<{ status: VoiceCheckStatus; detail: string }> {
  const text = "这是一次配音音色连通性实测。";
  try {
    const audio = await synthesizeSpeech(text, voice, 1);
    const duration = await measureTempMp3(audio);
    return { status: "ok", detail: `出音频 ${duration.toFixed(1)} 秒 / ${audio.length} 字节` };
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return { status: probeStatusOf(err), detail: raw.slice(0, 200) };
  }
}

/**
 * 合成前置校验：下架或本环境用不了的音色在打远端之前拒掉。
 * 这类失败是「参数不合法」不是「服务坏了」——返回 400 才不会让重试和告警都指错方向。
 */
async function voiceRejection(voice: string): Promise<string | null> {
  if (await isVoiceSelectable(voice)) return null;
  if (!(await isVoiceKnown(voice))) return `音色 ${voice} 不在配音目录中`;
  return `音色 ${voice} 当前不可用（已下架，或本运行环境不支持本地音色）；可在「配音音色」页测一次后上架，或改用列表中的音色`;
}

/** 失败响应：TtsError 自带面向用户的文案，不再套一层「TTS 合成失败」 */
function ttsFailureBody(err: unknown): { error: string } {
  if (err instanceof TtsError) return { error: err.message };
  return { error: `TTS 合成失败：${err instanceof Error ? err.message : String(err)}` };
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
    const { text, voice, rate } = c.req.valid("json");
    const why = await voiceRejection(voice);
    if (why) return c.json({ error: why, code: "VOICE_UNAVAILABLE" }, 400);
    try {
      const audio = await synthesizeSpeech(text, voice, rate ?? 1);
      const { filename, url } = await saveAudio(audio);
      logger.info({ filename, textLength: text.length }, "tts file saved");
      return c.json({ success: true, filename, url });
    } catch (err) {
      logger.error(
        { err, ttsErrorClass: err instanceof TtsError ? err.cls : "unknown" },
        "tts generate failed",
      );
      return c.json(ttsFailureBody(err), 500);
    }
  })
  .openapi(fromContentRoute, async (c): Promise<Response> => {
    const { content, template, voice, rate, title } = c.req.valid("json");
    const why = await voiceRejection(voice);
    if (why) return c.json({ error: why, code: "VOICE_UNAVAILABLE" }, 400);
    try {
      const text = buildTtsText(content, template, title);
      if (text.length === 0) {
        return c.json({ error: "content 无法拼出朗读文本" }, 400);
      }
      // 与 generate 契约对齐：单次合成文本上限 2000 字符（中文朗读后 word_card/quiz 拼接可达 800-1000 字）
      if (text.length > 2000) {
        return c.json({ error: "拼接文本超过 2000 字符上限" }, 400);
      }
      const audio = await synthesizeSpeech(text, voice, rate ?? 1);
      const { url, duration, format } = await saveAudio(audio);
      logger.info({ template, duration, textLength: text.length }, "tts from-content saved");
      return c.json({ audio: { url, duration, format } });
    } catch (err) {
      logger.error(
        { err, ttsErrorClass: err instanceof TtsError ? err.cls : "unknown" },
        "tts from-content failed",
      );
      return c.json(ttsFailureBody(err), 500);
    }
  })
  .openapi(
    createRoute({
      method: "get",
      path: "/voices",
      tags: [API_TAGS.tts],
      operationId: "listVoices",
      summary: "可用配音列表（音色/性别；附管理页所需的全量目录与实测状态）",
      responses: {
        200: {
          description: "配音列表",
          content: {
            "application/json": {
              schema: z.object({
                voices: z.array(voiceItemSchema),
                default: z.string(),
                all: z.array(managedVoiceSchema).optional(),
              }),
            },
          },
        },
      },
    }),
    async (c) => {
      const [items, rows] = await Promise.all([voiceCatalogItems(), loadVoiceCatalog()]);
      return c.json({
        // 可选列表 = 上架 + 本运行环境真能用（容器无 say 时本地音色不出现在这里）
        voices: items,
        all: rows.map((v) => ({
          id: v.id,
          name: v.label,
          gender: v.gender,
          engine: v.engine,
          enabled: v.enabled,
          checkedAt: v.lastCheckAt ? v.lastCheckAt.toISOString() : null,
          checkStatus: v.lastCheckStatus,
          checkDetail: v.lastCheckDetail,
        })),
        default: "zh-CN-XiaoxiaoNeural",
      });
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/voices/{id}",
      tags: [API_TAGS.tts],
      operationId: "setVoiceEnabled",
      summary: "上架 / 下架配音音色（下架只影响新合成，存量内容不受影响）",
      request: {
        params: z.object({ id: z.string().min(1).max(64) }),
        body: { content: { "application/json": { schema: z.object({ enabled: z.boolean() }) } } },
      },
      responses: {
        200: {
          description: "已更新",
          content: { "application/json": { schema: z.object({ voice: managedVoiceSchema }) } },
        },
        404: {
          description: "音色不在目录中",
          content: { "application/json": { schema: apiErrorSchema } },
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { enabled } = c.req.valid("json");
      const r = await setVoiceEnabled(id, enabled);
      if (r.kind === "not-found") {
        return c.json({ error: `音色 ${id} 不在配音目录中`, code: "VOICE_NOT_FOUND" }, 404);
      }
      logger.info({ voiceId: id, enabled }, "tts 音色上下架");
      const v = r.voice;
      return c.json(
        {
          voice: {
            id: v.id,
            name: v.label,
            gender: v.gender,
            engine: v.engine,
            enabled: v.enabled,
            checkedAt: v.lastCheckAt ? v.lastCheckAt.toISOString() : null,
            checkStatus: v.lastCheckStatus,
            checkDetail: v.lastCheckDetail,
          },
        },
        200,
      );
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/voices/{id}/probe",
      tags: [API_TAGS.tts],
      operationId: "probeVoice",
      summary: "实测某个音色能否出音频（含已下架音色），结果写回目录供判断上下架",
      request: { params: z.object({ id: z.string().min(1).max(64) }) },
      responses: {
        200: {
          description: "实测结论（status 非 ok 时同样返回 200：测不出来就是结果）",
          content: {
            "application/json": {
              schema: z.object({
                status: z.enum(["ok", "no_audio", "rate_limited", "handshake_failed", "error"]),
                detail: z.string(),
              }),
            },
          },
        },
        404: {
          description: "音色不在目录中",
          content: { "application/json": { schema: apiErrorSchema } },
        },
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      if (!(await isVoiceKnown(id))) {
        return c.json({ error: `音色 ${id} 不在配音目录中`, code: "VOICE_NOT_FOUND" }, 404);
      }
      const result = await probeVoiceAudio(id);
      await recordVoiceProbe(id, result.status, result.detail);
      logger.info({ voiceId: id, ...result }, "tts 音色实测");
      return c.json(result, 200);
    },
  );
