/**
 * video.service 单测 — 渲染编排：FFmpeg 参数构造 / 音画对齐 / 片头垫静音 / 失败半成品清理
 * mock 边界：node:child_process（ffmpeg/ffprobe 以"写出产物文件"模拟成功）、三渲染器、tts 合成与时长探测
 * 真实保留：fs 临时目录与产物落盘（清理断言才有意义）
 */
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContentDTO } from "@ai-english/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock, renderSpy, synthesizeMock, durationMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  renderSpy: vi.fn(),
  synthesizeMock: vi.fn(),
  durationMock: vi.fn(),
}));

vi.mock("node:child_process", () => {
  const custom = async (
    cmd: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> => {
    await execFileMock(cmd, args);
    return { stdout: "10.500000", stderr: "" };
  };
  const execFile = (): void => {};
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), { value: custom });
  return { execFile };
});
vi.mock("../renderer/scene-word.renderer", () => ({
  SceneWordRenderer: class {
    render = renderSpy;
  },
}));
vi.mock("../renderer/word-card.renderer", () => ({
  WordCardRenderer: class {
    render = renderSpy;
  },
}));
vi.mock("../renderer/quiz.renderer", () => ({
  QuizRenderer: class {
    render = renderSpy;
  },
}));
vi.mock("./tts.service", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  synthesizeSpeech: synthesizeMock,
  getAudioDuration: durationMock,
}));

process.env.UPLOADS_DIR = await mkdtemp(join(tmpdir(), "lf-video-test-"));

const { composeVideo, renderVideo } = await import("./video.service");

function baseDto(over: Partial<ContentDTO> = {}): ContentDTO {
  return {
    id: "cnt_test_video",
    template: "scene_word",
    title: "t",
    level: "CET4",
    targetDuration: 60,
    content: [],
    words: [],
    style: { background: "white" },
    voice: { id: "female_01" },
    status: "audio_ready",
    audio: { url: "/files/audio/a.mp3", duration: 10.5, format: "mp3" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  } as unknown as ContentDTO;
}

/** ffmpeg 调用中"输出路径"= 末位参数；mock 写出假产物让 stat 通过 */
function execWritesOutput() {
  execFileMock.mockImplementation(async (_cmd: string, args: string[]) => {
    const out = args[args.length - 1];
    if (typeof out === "string" && /\.(mp4|m4a|aiff)$/.test(out)) {
      await writeFile(out, Buffer.alloc(128, 1));
    }
  });
}

beforeEach(() => {
  execFileMock.mockReset();
  renderSpy.mockReset();
  synthesizeMock.mockReset();
  durationMock.mockReset();
  durationMock.mockResolvedValue(10.5);
  execWritesOutput();
});

afterEach(async () => {
  await rm(process.env.UPLOADS_DIR as string, { recursive: true, force: true });
  process.env.UPLOADS_DIR = await mkdtemp(join(tmpdir(), "lf-video-test-"));
});

describe("composeVideo 参数构造", () => {
  it("帧循环输入 + 逐帧 scale + concat；无 BGM/提示音时走 anull 直通", async () => {
    await composeVideo(
      [
        { filePath: "/tmp/f1.png", duration: 2 },
        { filePath: "/tmp/f2.png", duration: 3 },
      ],
      "/tmp/a.mp3",
      "/tmp/out.mp4",
    );
    const args = execFileMock.mock.calls[0]?.[1] as string[];
    if (!args) throw new Error("ffmpeg not invoked");
    expect(args).toContain("-filter_complex");
    expect(args.join(" ")).toContain("concat=n=2:v=1:a=0");
    expect(args.join(" ")).toContain("[base]anull[aout]");
    expect(args.join(" ")).not.toContain("-stream_loop");
  });

  it("BGM 循环混音 + 提示音 asplit/adelay 按时刻注入", async () => {
    await composeVideo(
      [{ filePath: "/tmp/f1.png", duration: 5 }],
      "/tmp/a.mp3",
      "/tmp/out.mp4",
      "/tmp/bgm.mp3",
      [2.5, 4],
    );
    const args = execFileMock.mock.calls[0]?.[1] as string[];
    const joined = args.join(" ");
    expect(joined).toContain("-stream_loop -1");
    expect(joined).toContain("asplit=2");
    expect(joined).toContain("adelay=2500|2500");
    expect(joined).toContain("adelay=4000|4000");
    expect(joined).toContain("amix=inputs=3");
  });
});

describe("renderVideo 编排", () => {
  it("正常路径：渲染 → 合成 → 返回产物元数据，临时目录清理", async () => {
    renderSpy.mockResolvedValue({
      frames: [{ filePath: "/tmp/f1.png", duration: 10 }],
      totalDuration: 10,
      introStatus: "rendered",
    });
    const result = await renderVideo(baseDto());
    expect(result.url).toMatch(/^\/files\/video\/[0-9a-f-]+\.mp4$/);
    expect(result.duration).toBe(10.5); // 以输出文件 ffprobe 为准
    expect(result.resolution).toBe("1080x1920");
    expect(result.introStatus).toBe("rendered");
    await expect(stat(join("/tmp/language-flow-render", "cnt_test_video"))).rejects.toThrow();
  });

  it("缺 audio 字段直接抛错，不启动渲染", async () => {
    await expect(renderVideo(baseDto({ audio: undefined }))).rejects.toThrow("audio");
    expect(renderSpy).not.toHaveBeenCalled();
  });

  it("片头垫静音：introPadSec 生效且提示音整体后移", async () => {
    renderSpy.mockResolvedValue({
      frames: [{ filePath: "/tmp/f1.png", duration: 10 }],
      totalDuration: 11,
      introPadSec: 1,
      beepTimes: [3],
    });
    await renderVideo(baseDto({ template: "quiz" }));
    const calls = execFileMock.mock.calls.map((c) => (c[1] as string[]).join(" "));
    expect(calls.some((c) => c.includes("adelay=1000|1000"))).toBe(true); // 垫静音
    expect(calls.some((c) => c.includes("adelay=4000|4000"))).toBe(true); // 提示音 3+1
  });

  it("FFmpeg 合成失败：半成品 MP4 被删除（不保留）", async () => {
    renderSpy.mockResolvedValue({
      frames: [{ filePath: "/tmp/f1.png", duration: 10 }],
      totalDuration: 10,
    });
    execFileMock.mockImplementation(async (_cmd: string, args: string[]) => {
      const out = args[args.length - 1];
      if (typeof out === "string" && out.endsWith(".mp4")) {
        await writeFile(out, "half-baked");
        throw new Error("ffmpeg exited 1");
      }
    });
    await expect(renderVideo(baseDto())).rejects.toThrow("ffmpeg exited 1");
    const videos = execFileMock.mock.calls
      .map((c) => (c[1] as string[]).at(-1) as string)
      .filter((p) => p.endsWith(".mp4"));
    const outPath = videos[0];
    if (!outPath) throw new Error("compose output missing");
    await expect(readFile(outPath)).rejects.toThrow();
  });

  it("quiz 逐项合成成功：帧时长取实际朗读时长（不估算）", async () => {
    synthesizeMock.mockResolvedValue(Buffer.from("aiff"));
    durationMock.mockResolvedValue(1.2);
    renderSpy.mockResolvedValue({ frames: [], totalDuration: 0 });
    const dto = baseDto({
      template: "quiz",
      content: [
        {
          stem: "w0 的意思是？",
          options: ["含义0", "含义1", "含义2", "含义3"],
          correctIndex: 0,
          explanation: "e",
          word: { word: "w0", meaning: "含义0", level: "CET4" },
        },
        {
          stem: "w1 的意思是？",
          options: ["含义1", "含义0", "含义2", "含义3"],
          correctIndex: 0,
          explanation: "e",
          word: { word: "w1", meaning: "含义1", level: "CET4" },
        },
      ],
    });
    await renderVideo(dto);
    const extra = renderSpy.mock.calls[0]?.[2] as { itemDurations?: number[] };
    expect(extra?.itemDurations).toEqual([1.2, 1.2]);
  });

  it("quiz 逐项合成失败：回退整段音频链路（不阻塞渲染）", async () => {
    synthesizeMock.mockRejectedValue(new Error("edge down"));
    renderSpy.mockResolvedValue({ frames: [], totalDuration: 0 });
    const dto = baseDto({
      template: "quiz",
      content: [
        {
          stem: "s",
          options: ["a", "b", "c", "d"],
          correctIndex: 0,
          explanation: "e",
          word: { word: "w", meaning: "m", level: "CET4" },
        },
      ],
    });
    const result = await renderVideo(dto);
    expect(result.url).toMatch(/^\/files\/video\//);
    expect(renderSpy.mock.calls[0]?.[2]).toBeUndefined();
  });

  it("style.bgm 透传到合成参数", async () => {
    renderSpy.mockResolvedValue({
      frames: [{ filePath: "/tmp/f.png", duration: 5 }],
      totalDuration: 5,
    });
    await renderVideo(baseDto({ style: { background: "white", bgm: "/files/bgm/x.mp3" } }));
    const compose = execFileMock.mock.calls.find((c) =>
      (c[1] as string[]).includes("-filter_complex"),
    );
    expect((compose?.[1] as string[]).join(" ")).toContain("-stream_loop -1");
  });
});
