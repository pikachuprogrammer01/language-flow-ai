/**
 * 模板渲染器单测 — scene_word（片头三态/高亮注入）与 word_card（逐卡帧/精确时长与回退）
 * mock 边界：playwright 截图（返回虚拟路径）、three-intro 截帧（成功/null/空数组三态）
 */
import type { ContentDTO } from "@ai-english/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { screenshotMock, captureIntroMock } = vi.hoisted(() => ({
  screenshotMock: vi.fn(),
  captureIntroMock: vi.fn(),
}));

vi.mock("./playwright", () => ({ screenshotHtmls: screenshotMock }));
vi.mock("./three-intro.capture", () => ({
  INTRO_DURATION_SEC: 1,
  captureThreeIntro: captureIntroMock,
}));

const { SceneWordRenderer, highlightWords } = await import("./scene-word.renderer");
const { WordCardRenderer } = await import("./word-card.renderer");

function dto(over: Partial<ContentDTO>): ContentDTO {
  return {
    id: "cnt_x",
    title: "t",
    level: "CET4",
    targetDuration: 60,
    words: [],
    style: { background: "white" },
    voice: { id: "female_01" },
    status: "audio_ready",
    audio: { url: "/files/audio/a.mp3", duration: 10, format: "mp3" },
    createdAt: "",
    updatedAt: "",
    ...over,
  } as unknown as ContentDTO;
}

beforeEach(() => {
  screenshotMock.mockReset();
  captureIntroMock.mockReset();
  screenshotMock.mockImplementation(async (list: string[]) =>
    list.map((_, i) => `frame-${String(i)}.png`),
  );
  captureIntroMock.mockResolvedValue([{ filePath: "intro-1.png", duration: 1 }]);
});

describe("highlightWords（注入安全核心）", () => {
  it("HTML 先转义再按词边界包 <mark>，大小写不敏感、正则元字符安全", () => {
    const html = highlightWords("A & B resolve the a+b, Resolve again", [
      { word: "resolve", meaning: "解决", level: "CET4" },
      { word: "a+b", meaning: "元字符", level: "CET4" },
    ]);
    expect(html).toContain("A &amp; B");
    expect(html).toContain("<mark>resolve</mark>");
    expect(html).toContain("<mark>Resolve</mark>"); // 大小写不敏感全替换
  });
});

describe("SceneWordRenderer", () => {
  const sceneDto = dto({
    template: "scene_word",
    content: [
      {
        text: "he resolve it",
        words: [{ word: "resolve", meaning: "解决", level: "CET4" }],
      },
      { text: "", words: [] },
    ],
  });

  it("默认开片头：片头帧前置 + introStatus=rendered + 总时长含 1s 垫", async () => {
    const result = await new SceneWordRenderer().render(sceneDto, "/tmp/wd");
    expect(result.introStatus).toBe("rendered");
    expect(result.frames[0]?.filePath).toBe("intro-1.png");
    expect(result.totalDuration).toBe(11);
    expect(result.introPadSec).toBe(1);
  });

  it("introEffect=false：不截片头，introStatus=disabled", async () => {
    const result = await new SceneWordRenderer().render(
      { ...sceneDto, style: { background: "white", introEffect: false } } as ContentDTO,
      "/tmp/wd",
    );
    expect(captureIntroMock).not.toHaveBeenCalled();
    expect(result.introStatus).toBe("disabled");
    expect(result.frames).toHaveLength(1);
  });

  it("片头截帧返回 null：如实标 failed（不静默降级）", async () => {
    captureIntroMock.mockResolvedValue(null);
    const result = await new SceneWordRenderer().render(sceneDto, "/tmp/wd");
    expect(result.introStatus).toBe("failed");
  });

  it("非 scene_word 模板 / 缺 audio：抛错拒渲", async () => {
    await expect(
      new SceneWordRenderer().render(dto({ template: "quiz", content: [] }), "/tmp"),
    ).rejects.toThrow("非 scene_word");
    await expect(
      new SceneWordRenderer().render(dto({ template: "scene_word", audio: undefined }), "/tmp"),
    ).rejects.toThrow("audio");
  });
});

describe("WordCardRenderer", () => {
  const cards = [
    {
      word: "resolve",
      pos: "v.",
      meaning: "解决",
      example: "He resolved it.",
      exampleMeaning: "他解决了",
    },
    { word: "centre", pos: "n.", meaning: "中心", example: "", exampleMeaning: "" },
  ];
  const cardDto = dto({ template: "word_card", content: cards });

  it("逐卡一帧；extra.itemDurations 精确对齐（+0.8s 卡间缓冲）", async () => {
    const result = await new WordCardRenderer().render(cardDto, "/tmp/wd", {
      itemDurations: [1, 2],
    });
    expect(result.frames).toEqual([
      { filePath: "frame-0.png", duration: 1.8 },
      { filePath: "frame-1.png", duration: 2.8 },
    ]);
  });

  it("回退链路：无 itemDurations 按朗读估算分配，总和=音频时长", async () => {
    const result = await new WordCardRenderer().render(cardDto, "/tmp/wd");
    const sum = (result.frames ?? []).reduce((n, f) => n + f.duration, 0);
    expect(sum).toBeCloseTo(10, 1);
  });

  it("无例句卡不输出 example 块（模板占位被清空替换）", async () => {
    await new WordCardRenderer().render(cardDto, "/tmp/wd");
    const htmlList = screenshotMock.mock.calls[0]?.[0] as string[];
    expect(htmlList[1]).not.toContain('example-meaning">');
    expect(htmlList[0]).toContain("He resolved it.");
  });

  it("非 word_card / 缺 audio 抛错", async () => {
    await expect(
      new WordCardRenderer().render(dto({ template: "scene_word", content: [] }), "/tmp"),
    ).rejects.toThrow("非 word_card");
  });
});
