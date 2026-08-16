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
  it("scene_word：各 segment 句号连接，每段后追加 words 的「词，释义」", () => {
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

    expect(text).toBe("Leo接到一份contract。contract，合同。他穿越dense丛林。dense，茂密的。");
  });

  it("scene_word：words 为空的 segment 只拼 text；空字段跳过", () => {
    const text = buildTtsText(
      [
        { text: "纯文本段。", words: [] },
        { text: "", words: [{ word: "contract", meaning: "合同" }] },
        {},
      ],
      "scene_word",
    );

    expect(text).toBe("纯文本段。contract，合同。");
  });

  it("word_card：逐卡拼接 word. pos. example.", () => {
    const text = buildTtsText(
      [
        { word: "elaborate", pos: "adj.", example: "She made elaborate preparations." },
        { word: "contract", pos: "n.", example: "He signed a contract." },
      ],
      "word_card",
    );

    expect(text).toBe(
      "elaborate. adj. She made elaborate preparations. contract. n. He signed a contract.",
    );
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
    // 本文件所有 mock 均为 vi.fn()（无 spyOn），无需 restoreAllMocks
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
      content: [{ word: "hi", pos: "int.", example: "Hi there." }],
      template: "word_card",
    });

    expect(ttsService.synthesizeSpeech).toHaveBeenCalledWith(
      "hi. int. Hi there.",
      "zh-CN-XiaoxiaoNeural",
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

  it("from-content 500：合成失败返回错误", async () => {
    vi.mocked(ttsService.synthesizeSpeech).mockRejectedValue(new Error("edge down"));

    const res = await postJson("/from-content", {
      content: [{ text: "你好。" }],
      template: "scene_word",
    });

    expect(res.status).toBe(500);
  });

  it("generate 400：text 超 500 字符", async () => {
    const res = await postJson("/generate", {
      text: "a".repeat(501),
    });

    expect(res.status).toBe(400);
  });
});
