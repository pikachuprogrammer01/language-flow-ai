/**
 * TTS 服务测试
 * 覆盖：buildTtsText 三模板拼接规则 / from-content 200/400/500 / generate 400
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTtsText } from "../services/tts.service";
import * as ttsService from "../services/tts.service";
import { tts } from "./tts";

// mock：不依赖真实网络 / ffprobe / 文件写入
vi.mock("node:fs/promises", () => ({ mkdir: vi.fn(), writeFile: vi.fn() }));
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
});
