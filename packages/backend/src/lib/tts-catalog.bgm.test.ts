/**
 * tts-catalog BGM 素材校验单测 — listBgmFiles / isBgmAllowed（路径穿越防御）
 * 真实 fs：临时 UPLOADS_DIR（env 注入须在模块导入前，动态 import）
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const dir = await mkdtemp(join(tmpdir(), "lf-bgm-catalog-"));
await mkdir(join(dir, "bgm"), { recursive: true });
await writeFile(join(dir, "bgm", "free-01.mp3"), "x");
process.env.UPLOADS_DIR = dir;
const { isBgmAllowed, listBgmFiles } = await import("./tts-catalog");

describe("listBgmFiles", () => {
  it("返回目录清单；目录不存在时返回空而非抛错", async () => {
    expect(listBgmFiles()).toEqual(["free-01.mp3"]);
    process.env.UPLOADS_DIR = join(dir, "missing");
    vi.resetModules();
    const fresh = await import("./tts-catalog");
    expect(fresh.listBgmFiles()).toEqual([]);
    process.env.UPLOADS_DIR = dir;
  });
});

describe("isBgmAllowed", () => {
  it("空值语义：null/undefined/空串 = 无 BGM，允许", () => {
    expect(isBgmAllowed(null)).toBe(true);
    expect(isBgmAllowed(undefined)).toBe(true);
    expect(isBgmAllowed("")).toBe(true);
  });

  it("存在的 /files/bgm/<name> 允许；不存在拒绝", () => {
    expect(isBgmAllowed("/files/bgm/free-01.mp3")).toBe(true);
    expect(isBgmAllowed("/files/bgm/ghost.mp3")).toBe(false);
  });

  it("路径穿越拒绝；目录错位拒绝；裸文件名按 basename 兼容存量（存在即允许）", () => {
    expect(isBgmAllowed("/files/bgm/../secret.mp3")).toBe(false);
    expect(isBgmAllowed("/files/bgm/../bgm/free-01.mp3")).toBe(false); // 穿越后仍指向 bgm 也拒绝（字符串比对）
    expect(isBgmAllowed("/files/audio/free-01.mp3")).toBe(false);
    expect(isBgmAllowed("free-01.mp3")).toBe(true); // 存量裸文件名：basename 一致且在清单内（白名单不锁历史的既定口径）
    expect(isBgmAllowed("ghost.mp3")).toBe(false);
  });
});
