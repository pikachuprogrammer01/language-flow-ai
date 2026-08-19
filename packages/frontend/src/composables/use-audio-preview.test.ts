/**
 * use-audio-preview 单例状态机测试
 * mock HTMLAudioElement（jsdom 无真实音频），验证互斥/切换/暂停状态同步
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

class MockAudio {
  static instances: MockAudio[] = [];
  paused = true;
  src = "";
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(src: string) {
    this.src = src;
    MockAudio.instances.push(this);
  }
  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
}

vi.stubGlobal("Audio", MockAudio);

// 模块级单例：所有测试共享同一实例，beforeEach 重置
import { useAudioPreview } from "./use-audio-preview";

const { playing, play, stop, toggle, isPlaying } = useAudioPreview();

describe("use-audio-preview 单例状态机", () => {
  beforeEach(() => {
    stop();
    MockAudio.instances = [];
  });

  it("play 后 isPlaying(key) 为 true，异源自动停旧（互斥）", () => {
    play("voice", "/a.mp3");
    expect(isPlaying("voice")).toBe(true);
    expect(isPlaying("bgm")).toBe(false);
    play("bgm", "/b.mp3");
    expect(isPlaying("voice")).toBe(false);
    expect(isPlaying("bgm")).toBe(true);
  });

  it("toggle 同源播放中 → 暂停并同步状态（UI 跟随的根因修复）", () => {
    toggle("bgm", "/b.mp3");
    expect(isPlaying("bgm")).toBe(true);
    toggle("bgm", "/b.mp3");
    expect(isPlaying("bgm")).toBe(false);
    expect(playing.value).toBe(false);
  });

  it("toggle 异源时切换到新源", () => {
    toggle("voice", "/a.mp3");
    toggle("bgm", "/b.mp3");
    expect(isPlaying("bgm")).toBe(true);
    expect(isPlaying("voice")).toBe(false);
  });

  it("stop 清空全部状态", () => {
    play("voice", "/a.mp3");
    stop();
    expect(isPlaying("voice")).toBe(false);
    expect(playing.value).toBe(false);
  });

  it("播放结束（onended）自动释放状态", () => {
    play("voice", "/a.mp3");
    const el = MockAudio.instances[0];
    expect(el).toBeDefined();
    el.onended?.();
    expect(isPlaying("voice")).toBe(false);
  });
});
