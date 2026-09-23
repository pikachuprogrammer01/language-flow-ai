/**
 * tts.service 单测 — Edge WebSocket 协议状态机 / say 分发与重试 / ffprobe 时长解析
 * mock 边界：ws（事件回放 FakeWS）、node:child_process（带 promisify.custom，say 可写假产物、ffprobe 回 stdout）
 * 真实保留：fs 临时目录（say 产物读取链路）与全部纯逻辑（转义/拼接/估算）
 */
import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { wsInstances, execFileMock } = vi.hoisted(() => ({
  wsInstances: [] as EventEmitter[] as FakeWS[],
  execFileMock: vi.fn(),
}));

class FakeWS extends EventEmitter {
  sent: string[] = [];
  closed = false;
  constructor() {
    super();
    wsInstances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
  emitMessage(buf: Buffer): void {
    this.emit("message", buf);
  }
  /** 完整成功剧本：open → 音频（含 metadata 干扰消息）→ turn.end */
  completeWith(audio: string): void {
    this.emit("open");
    this.emitMessage(Buffer.from('Path:audio.metadata\r\n{"Duration":123}'));
    this.emitMessage(Buffer.concat([Buffer.from("Path:audio\r\n"), Buffer.from(audio)]));
    this.emitMessage(Buffer.from("X-Timestamp:x\r\nPath:turn.end\r\n\r\n"));
  }
}

vi.mock("ws", () => ({
  default: vi.fn(function create() {
    return new FakeWS();
  }),
}));
// promisify(execFile) 依赖 nodejs.util.promisify.custom 才能拿到 { stdout }；显式实现该符号
vi.mock("node:child_process", () => {
  const custom = async (
    cmd: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> => {
    const out = await execFileMock(cmd, args);
    return { stdout: typeof out === "string" ? out : "12.340000", stderr: "" };
  };
  const execFile = (): void => {};
  Object.defineProperty(execFile, Symbol.for("nodejs.util.promisify.custom"), { value: custom });
  return { execFile };
});

const {
  buildQuizItemText,
  estimateSpeechSeconds,
  getAudioDuration,
  isMacVoice,
  buildTtsText,
  synthesizeSpeech,
} = await import("./tts.service");

function wsAt(i: number): FakeWS {
  const ws = wsInstances[i];
  if (!ws) throw new Error(`no ws instance #${String(i)}`);
  return ws;
}

beforeEach(() => {
  wsInstances.length = 0;
  execFileMock.mockReset();
  execFileMock.mockImplementation(() => undefined);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("synthesizeSpeech — Edge TTS 路径", () => {
  it("正常合成：open 连发 config+SSML（XML 转义+语速百分比），metadata 干扰消息被跳过，音频按 Path:audio\\r\\n 标记切出", async () => {
    const p = synthesizeSpeech("你好 <world> & 'quote'", "zh-CN-XiaoxiaoNeural", 1.2);
    wsAt(0).completeWith("AAA");
    await expect(p).resolves.toEqual(Buffer.from("AAA"));
    const ws = wsAt(0);
    expect(ws.sent).toHaveLength(2);
    expect(ws.sent[0]).toContain("Path:speech.config");
    expect(ws.sent[1]).toContain("Path:ssml");
    expect(ws.sent[1]).toContain('rate="+20%"');
    expect(ws.sent[1]).toContain("&lt;world&gt; &amp; &apos;quote&apos;");
  });

  it("全 3 次尝试均无音频：抛 No audio data（重试预算用尽）", async () => {
    const p = synthesizeSpeech("x", "zh-CN-XiaoxiaoNeural");
    // 同步驱动失败时，中间轮 rejection 到下一 microtask 才被重试循环接住——预挂 no-op catch 占位防 unhandled
    p.catch(() => {});
    for (let i = 0; i < 3; i++) {
      wsAt(i).emit("open");
      wsAt(i).close();
      await vi.advanceTimersByTimeAsync(1100);
    }
    await expect(p).rejects.toThrow("No audio data");
    expect(wsInstances).toHaveLength(3);
  });

  it("WebSocket error 事件：逐次透出并最终失败", async () => {
    const p = synthesizeSpeech("x", "zh-CN-XiaoxiaoNeural");
    p.catch(() => {});
    for (let i = 0; i < 3; i++) {
      wsAt(i).emit("error", new Error(`socket boom ${String(i)}`));
      await vi.advanceTimersByTimeAsync(1100);
    }
    await expect(p).rejects.toThrow("socket boom 0"); // 抛的是首次错误
  });

  it("首轮失败自动重试：第二次成功即返回（共 2 次连接）", async () => {
    const p = synthesizeSpeech("x", "zh-CN-XiaoxiaoNeural");
    wsAt(0).emit("open");
    wsAt(0).close();
    await vi.advanceTimersByTimeAsync(600);
    wsAt(1).completeWith("OK");
    await expect(p).resolves.toEqual(Buffer.from("OK"));
    expect(wsInstances).toHaveLength(2);
  });
});

describe("synthesizeSpeech — Mac say 路径", () => {
  it("Mac 音色分发到 say：-v/-r(175×rate)/-o 参数与产物读取", async () => {
    expect(isMacVoice("Tingting")).toBe(true);
    execFileMock.mockImplementation(async (_cmd: string, args: string[]) => {
      const out = args[args.indexOf("-o") + 1];
      if (out) await writeFile(out, "AIFFDATA");
    });
    const buf = await synthesizeSpeech("测试", "Tingting", 0.8);
    expect(buf.toString()).toBe("AIFFDATA");
    const args = execFileMock.mock.calls[0]?.[1] as string[];
    expect(args).toContain("-v");
    expect(args[args.indexOf("-r") + 1]).toBe("140");
  });

  it("say 产物为空文件：抛音色未安装可读错误", async () => {
    execFileMock.mockImplementation(async (_cmd: string, args: string[]) => {
      const out = args[args.indexOf("-o") + 1];
      if (out) await writeFile(out, "");
    });
    await expect(synthesizeSpeech("x", "Sinji")).rejects.toThrow("未安装");
  });
});

describe("getAudioDuration", () => {
  it("ffprobe stdout 解析为浮点秒", async () => {
    expect(await getAudioDuration("/tmp/a.mp3")).toBe(12.34);
  });
  it("无法解析时抛错（上层转 500）", async () => {
    execFileMock.mockResolvedValue("N/A");
    await expect(getAudioDuration("/tmp/bad.mp3")).rejects.toThrow("无法解析");
  });
});

describe("朗读文本纯函数", () => {
  it("estimateSpeechSeconds：中文/英文词/标点分项计时", () => {
    const secs = estimateSpeechSeconds("你好世界 hello world，");
    expect(secs).toBeCloseTo(1 + 2 / 1.8 + 0.35 + 0.5, 4);
  });

  it("buildQuizItemText：选项上限 4、词性剥离、无选项不出题", () => {
    const text = buildQuizItemText({
      stem: "resolve 的意思是",
      options: ["n.决定", "v.解决", "adj.高的", "prep.在", "多余选项"],
    });
    expect(text).toBe("resolve 的意思是。 A. 决定. B. 解决. C. 高的. D. 在.");
    expect(buildQuizItemText({ stem: "s", options: [] })).toBe("");
  });

  it("buildTtsText scene_word：英文词回替中文义项 + 标题朗读", () => {
    const text = buildTtsText(
      [
        {
          text: "He resolve the problem at centre.",
          words: [
            { word: "resolve", meaning: "解决" },
            { word: "centre", meaning: "中心" },
          ],
        },
      ],
      "scene_word",
      "森林 The Adventure",
    );
    expect(text).toBe("森林 The Adventure。He 解决 the problem at 中心.");
  });
});
