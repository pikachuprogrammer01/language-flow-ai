/**
 * TTS 服务测试
 * 覆盖：buildTtsText 三模板拼接规则 / from-content 200/400/500 / generate 400
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTtsText } from "../services/tts.service";
import * as ttsService from "../services/tts.service";
import { tts } from "./tts";

// mock：不依赖真实网络 / ffprobe / 文件写入 / 数据库
const voiceState = vi.hoisted(() => ({
  selectable: ["zh-CN-XiaoxiaoNeural", "zh-CN-YunxiNeural"],
  known: ["zh-CN-XiaoxiaoNeural", "zh-CN-YunxiNeural", "zh-CN-XiaohanNeural"],
  enabledWrites: [] as { id: string; enabled: boolean }[],
  probeWrites: [] as { id: string; status: string; detail: string }[],
}));
vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(),
  mkdtemp: vi.fn(async () => "/tmp/lf-tts-probe-test"),
  rm: vi.fn(async () => {}),
  writeFile: vi.fn(),
}));
vi.mock("../services/tts-voice.service", () => ({
  isVoiceSelectable: async (id: string) => voiceState.selectable.includes(id),
  isVoiceKnown: async (id: string) => voiceState.known.includes(id),
  voiceCatalogItems: async () =>
    voiceState.selectable.map((id) => ({ id, name: id, gender: "女" })),
  loadVoiceCatalog: async () => [
    {
      id: "zh-CN-XiaoxiaoNeural",
      label: "晓晓（女·温暖）",
      gender: "女",
      engine: "edge",
      enabled: true,
      lastCheckAt: null,
      lastCheckStatus: null,
      lastCheckDetail: null,
    },
    {
      id: "zh-CN-XiaohanNeural",
      label: "晓涵（女·知性）",
      gender: "女",
      engine: "edge",
      enabled: false,
      lastCheckAt: new Date("2026-10-12T12:00:00.000Z"),
      lastCheckStatus: "no_audio",
      lastCheckDetail: "实测零音频帧",
    },
  ],
  setVoiceEnabled: async (id: string, enabled: boolean) => {
    if (!voiceState.known.includes(id)) return { kind: "not-found" as const };
    voiceState.enabledWrites.push({ id, enabled });
    return {
      kind: "updated" as const,
      voice: {
        id,
        label: id,
        gender: "女",
        engine: "edge" as const,
        enabled,
        lastCheckAt: null,
        lastCheckStatus: null,
        lastCheckDetail: null,
      },
    };
  },
  recordVoiceProbe: async (id: string, status: string, detail: string) => {
    voiceState.probeWrites.push({ id, status, detail });
  },
}));
vi.mock("../services/tts.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/tts.service")>();
  return {
    ...actual,
    synthesizeSpeech: vi.fn(),
    getAudioDuration: vi.fn(),
  };
});

// ── 拼接纯函数 ──

describe("buildTtsText", () => {
  it("scene_word：text 中英文词原位替换为中文释义（全中文朗读）", () => {
    const text = buildTtsText(
      [
        {
          text: "Leo接到一份contract。",
          words: [{ word: "contract", meaning: "合同" }],
        },
        {
          text: "他穿越dense丛林。",
          words: [{ word: "dense", meaning: "茂密的" }],
        },
      ],
      "scene_word",
    );

    expect(text).toBe("Leo接到一份合同。他穿越茂密的丛林。");
  });

  it("scene_word：words 为空的 segment 只拼 text；空 text 段跳过", () => {
    const text = buildTtsText(
      [
        { text: "纯文本段。", words: [] },
        { text: "", words: [{ word: "contract", meaning: "合同" }] },
        {},
      ],
      "scene_word",
    );

    expect(text).toBe("纯文本段。");
  });

  it("word_card：全中文朗读（词性不朗读，读释义 + 例句 + 例句翻译）", () => {
    const text = buildTtsText(
      [
        {
          word: "elaborate",
          pos: "adj.",
          meaning: "精心制作的",
          example: "She made elaborate preparations.",
          exampleMeaning: "她做了精心的准备。",
        },
        {
          word: "contract",
          pos: "n.",
          meaning: "合同",
          example: "He signed a contract.",
          exampleMeaning: "他签了一份合同。",
        },
      ],
      "word_card",
    );

    expect(text).toBe(
      "elaborate，精心制作的。She made elaborate preparations。她做了精心的准备。 contract，合同。He signed a contract。他签了一份合同。",
    );
  });

  it("word_card：释义带词性前缀时剥离（n.合同 → 合同）", () => {
    const text = buildTtsText(
      [
        {
          word: "contract",
          pos: "n.",
          meaning: "n.合同",
          example: "He signed a contract.",
          exampleMeaning: "他签了一份合同。",
        },
      ],
      "word_card",
    );

    expect(text).toBe("contract，合同。He signed a contract。他签了一份合同。");
  });

  it("quiz：选项剥离词性前缀（n.天花板 → 天花板）", () => {
    const text = buildTtsText(
      [
        {
          stem: "ceiling 的意思是？",
          options: ["n.天花板，顶蓬", "n.合同", "v.建立", "adj.巨大的"],
          correctIndex: 0,
          explanation: "解析",
          word: { word: "ceiling", meaning: "n.天花板", level: "CET4" },
        },
      ],
      "quiz",
    );

    expect(text).toBe("ceiling 的意思是？ A. 天花板，顶蓬. B. 合同. C. 建立. D. 巨大的.");
  });

  it("quiz：逐题拼接 stem. A. opt0. B. opt1. C. opt2. D. opt3.", () => {
    const text = buildTtsText(
      [
        {
          stem: "contract 的意思是？",
          options: ["合同", "联系", "对比", "建造"],
        },
      ],
      "quiz",
    );

    expect(text).toBe("contract 的意思是？ A. 合同. B. 联系. C. 对比. D. 建造.");
  });

  it("全部为空时返回空字符串", () => {
    const text = buildTtsText([{}, { text: "" }], "scene_word");

    expect(text).toBe("");
  });
});

// ── 路由层 ──

describe("POST /api/tts", () => {
  beforeEach(() => {
    // 本文件所有 mock 均为 vi.fn()（无 spyOn），无需 restoreAllMocks；但要清调用记录
    vi.mocked(ttsService.synthesizeSpeech).mockReset();
    vi.mocked(ttsService.getAudioDuration).mockReset();
    vi.mocked(ttsService.synthesizeSpeech).mockResolvedValue(Buffer.from("fake-mp3"));
    vi.mocked(ttsService.getAudioDuration).mockResolvedValue(3.2);
  });

  const postJson = (path: string, body: unknown) =>
    tts.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("from-content 200：返回 audio 元数据（url/duration/format）", async () => {
    const res = await postJson("/from-content", {
      content: [{ text: "你好。", words: [{ word: "hi", meaning: "嗨" }] }],
      template: "scene_word",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { audio: { url: string; duration: number; format: string } };
    expect(body.audio.url).toMatch(/^\/files\/audio\/.+\.mp3$/);
    expect(body.audio.duration).toBe(3.2);
    expect(body.audio.format).toBe("mp3");
  });

  it("from-content 200：voice 不传用默认音色", async () => {
    await postJson("/from-content", {
      content: [
        { word: "hi", pos: "int.", meaning: "嗨", example: "Hi there.", exampleMeaning: "你好。" },
      ],
      template: "word_card",
    });

    expect(ttsService.synthesizeSpeech).toHaveBeenCalledWith(
      "hi，嗨。Hi there。你好。",
      "zh-CN-XiaoxiaoNeural",
      1,
    );
  });

  it("from-content 200：rate 语速参数透传", async () => {
    vi.mocked(ttsService.synthesizeSpeech).mockResolvedValue(Buffer.from([1]));
    vi.mocked(ttsService.getAudioDuration).mockResolvedValue(3.2);
    const res = await postJson("/from-content", {
      content: [{ text: "你好。", words: [] }],
      template: "scene_word",
      rate: 1.2,
    });

    expect(res.status).toBe(200);
    expect(ttsService.synthesizeSpeech).toHaveBeenCalledWith(
      expect.stringContaining("你好"),
      "zh-CN-XiaoxiaoNeural",
      1.2,
    );
  });

  it("from-content 400：content 为空数组", async () => {
    const res = await postJson("/from-content", {
      content: [],
      template: "scene_word",
    });

    expect(res.status).toBe(400);
  });

  it("from-content 400：template 非法", async () => {
    const res = await postJson("/from-content", {
      content: [{ text: "你好。" }],
      template: "dictation",
    });

    expect(res.status).toBe(400);
  });

  it("from-content 400：content 拼不出朗读文本", async () => {
    const res = await postJson("/from-content", {
      content: [{}, {}],
      template: "scene_word",
    });

    expect(res.status).toBe(400);
  });

  it("from-content 400：拼接文本超过 2000 字符上限", async () => {
    const res = await postJson("/from-content", {
      content: Array.from({ length: 11 }, () => ({ text: "长".repeat(190) })),
      template: "scene_word",
    });

    expect(res.status).toBe(400);
    expect(ttsService.synthesizeSpeech).not.toHaveBeenCalled();
  });

  it("from-content 200：拼接文本在 2000 字符内正常合成", async () => {
    vi.mocked(ttsService.synthesizeSpeech).mockResolvedValue(Buffer.from([1]));
    const res = await postJson("/from-content", {
      content: Array.from({ length: 8 }, () => ({ text: "长".repeat(100) })),
      template: "scene_word",
    });

    expect(res.status).toBe(200);
  });

  it("from-content 500：合成失败返回错误", async () => {
    vi.mocked(ttsService.synthesizeSpeech).mockRejectedValue(new Error("edge down"));

    const res = await postJson("/from-content", {
      content: [{ text: "你好。" }],
      template: "scene_word",
    });

    expect(res.status).toBe(500);
  });

  it("generate 400：text 超 2000 字符", async () => {
    const res = await postJson("/generate", {
      text: "a".repeat(2001),
    });

    expect(res.status).toBe(400);
  });

  it("generate 200：合成成功回 filename/url", async () => {
    vi.mocked(ttsService.synthesizeSpeech).mockResolvedValue(Buffer.from("mp3"));
    const res = await postJson("/generate", { text: "你好" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; url: string };
    expect(body.success).toBe(true);
    expect(body.url).toMatch(/^\/files\/audio\/.+\.mp3$/);
  });

  it("generate 500：合成失败透真实原因（不再笼统文案）", async () => {
    vi.mocked(ttsService.synthesizeSpeech).mockRejectedValue(new Error("edge down"));
    const res = await postJson("/generate", { text: "你好" });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("edge down");
  });

  it("voices 200：回音色列表与默认值", async () => {
    const res = await tts.request("/voices");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { voices: unknown[]; default: string };
    expect(body.voices.length).toBeGreaterThan(0);
    expect(body.default).toBe("zh-CN-XiaoxiaoNeural");
  });
});

// ── 音色上下架与合成前置校验（docs/24）──

describe("音色目录管理", () => {
  const jsonReq = (path: string, method: string, body?: unknown) =>
    tts.request(path, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeEach(() => {
    vi.mocked(ttsService.synthesizeSpeech).mockReset();
    vi.mocked(ttsService.getAudioDuration).mockReset();
    vi.mocked(ttsService.synthesizeSpeech).mockResolvedValue(Buffer.from("fake-mp3"));
    vi.mocked(ttsService.getAudioDuration).mockResolvedValue(3.2);
    voiceState.enabledWrites.length = 0;
    voiceState.probeWrites.length = 0;
  });

  it("generate 用已下架音色：400 且根本不打远端（这类失败不是服务坏了）", async () => {
    const res = await jsonReq("/generate", "POST", {
      text: "你好",
      voice: "zh-CN-XiaohanNeural",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("VOICE_UNAVAILABLE");
    expect(body.error).toContain("配音音色");
    expect(ttsService.synthesizeSpeech).not.toHaveBeenCalled();
  });

  it("from-content 用已下架音色：同样 400 前置拒掉", async () => {
    const res = await jsonReq("/from-content", "POST", {
      template: "word_card",
      content: [{ word: "forest", meaning: "森林" }],
      voice: "zh-CN-XiaohanNeural",
    });
    expect(res.status).toBe(400);
    expect(ttsService.synthesizeSpeech).not.toHaveBeenCalled();
  });

  it("voices 的 all 带上下架状态与实测结论，voices 只含可选项", async () => {
    const res = await jsonReq("/voices", "GET");
    const body = (await res.json()) as {
      voices: { id: string }[];
      all: { enabled: boolean; id: string; checkStatus: string | null }[];
    };
    expect(body.voices.map((v) => v.id)).not.toContain("zh-CN-XiaohanNeural");
    const disabled = body.all.find((v) => v.id === "zh-CN-XiaohanNeural");
    expect(disabled?.enabled).toBe(false);
    expect(disabled?.checkStatus).toBe("no_audio");
  });

  it("PATCH 下架已上架音色：写库并回新状态", async () => {
    const res = await jsonReq("/voices/zh-CN-XiaoxiaoNeural", "PATCH", { enabled: false });
    expect(res.status).toBe(200);
    expect(voiceState.enabledWrites).toEqual([{ id: "zh-CN-XiaoxiaoNeural", enabled: false }]);
    const body = (await res.json()) as { voice: { enabled: boolean } };
    expect(body.voice.enabled).toBe(false);
  });

  it("PATCH 目录里没有的音色：404，不发写", async () => {
    const res = await jsonReq("/voices/zh-CN-NoSuchNeural", "PATCH", { enabled: true });
    expect(res.status).toBe(404);
    expect(voiceState.enabledWrites).toHaveLength(0);
  });

  it("probe 成功：200 出音频时长并写回 ok", async () => {
    const res = await jsonReq("/voices/zh-CN-XiaohanNeural/probe", "POST");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { detail: string; status: string };
    expect(body.status).toBe("ok");
    expect(body.detail).toContain("3.2 秒");
    expect(voiceState.probeWrites[0]?.status).toBe("ok");
  });

  it("probe 音色不可用：仍返回 200（测不出来就是结果），状态记 no_audio", async () => {
    vi.mocked(ttsService.synthesizeSpeech).mockRejectedValue(
      new ttsService.TtsError("voice_unavailable", "该音色在当前配音端点不可用"),
    );
    const res = await jsonReq("/voices/zh-CN-XiaohanNeural/probe", "POST");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("no_audio");
    expect(voiceState.probeWrites[0]?.status).toBe("no_audio");
  });

  it("probe 未知音色：404 且不动远端", async () => {
    const res = await jsonReq("/voices/zh-CN-NoSuchNeural/probe", "POST");
    expect(res.status).toBe(404);
    expect(ttsService.synthesizeSpeech).not.toHaveBeenCalled();
  });
});
