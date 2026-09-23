/**
 * tts-catalog 纯函数单测 — 音色目录与环境可用性分流（回归：容器无 say 时本地音色不出列表）
 */
import { describe, expect, it } from "vitest";
import { MAC_VOICES, TTS_VOICES, allVoiceIds, availableVoices } from "./tts-catalog";

describe("availableVoices", () => {
  it("darwin（宿主机 dev）：Edge + Mac 本地全量", () => {
    const ids = availableVoices("darwin").map((v) => v.id);
    expect(ids).toEqual([...TTS_VOICES, ...MAC_VOICES].map((v) => v.id));
  });

  it("linux（Docker 容器，无 say）：本地音色不出列表，Edge 音色完整", () => {
    const ids = availableVoices("linux").map((v) => v.id);
    expect(ids).toEqual(TTS_VOICES.map((v) => v.id));
    for (const mac of MAC_VOICES) expect(ids).not.toContain(mac.id);
  });
});

describe("allVoiceIds（白名单口径，与列表可用性解耦）", () => {
  it("容器环境白名单仍含本地音色：存量数据遗留音色可回显/重配不被锁死", () => {
    expect(allVoiceIds()).toContain("Tingting");
    expect(allVoiceIds()).toContain("zh-CN-XiaoxiaoNeural");
  });
});
