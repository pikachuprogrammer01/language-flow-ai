/**
 * 音色目录服务单测（docs/24）
 *
 * 钉的是三条会真的咬人的口径，不是 CRUD 覆盖率：
 * 1. 下架 ≠ 非法——已下架音色必须仍在白名单里，否则历史内容一打开就变非法值；
 * 2. 容器（非 darwin）永远不出本地音色——这条从硬编码时代就有，搬家时最容易丢；
 * 3. 写操作必须让 30 秒缓存失效——否则界面上下了架，下拉还是旧的。
 * mock 边界：db（链式 fake）；不依赖网络与真库。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface FakeRow {
  id: string;
  label: string;
  gender: string;
  engine: string;
  enabled: number;
  lastCheckAt: Date | null;
  lastCheckStatus: string | null;
  lastCheckDetail: string | null;
}

const h = vi.hoisted(() => ({
  table: [] as unknown[],
  whereResult: [] as unknown[],
  selectCount: 0,
  updates: [] as { set: Record<string, unknown> }[],
}));

function edge(id: string, enabled = 1): FakeRow {
  return {
    id,
    label: id,
    gender: "女",
    engine: "edge",
    enabled,
    lastCheckAt: null,
    lastCheckStatus: null,
    lastCheckDetail: null,
  };
}

function chain(): unknown {
  const state = { filtered: false };
  const resolve = (): unknown[] => (state.filtered ? h.whereResult : h.table);
  const link = Object.assign(
    Promise.resolve().then(() => {
      h.selectCount += 1;
      return resolve();
    }),
    {
      from: () => link,
      where: () => {
        state.filtered = true;
        return link;
      },
      set: (payload: Record<string, unknown>) => {
        h.updates.push({ set: payload });
        return link;
      },
    },
  );
  return link;
}

vi.mock("../db", () => ({
  db: {
    select: () => chain(),
    update: () => chain(),
  },
}));

const {
  invalidateVoiceCatalogCache,
  isVoiceKnown,
  isVoiceSelectable,
  knownVoiceIds,
  loadVoiceCatalog,
  recordVoiceProbe,
  selectableVoices,
  setVoiceEnabled,
  voiceCatalogItems,
} = await import("./tts-voice.service");

beforeEach(() => {
  h.table = [
    edge("zh-CN-XiaoxiaoNeural"),
    edge("zh-CN-XiaohanNeural", 0),
    { ...edge("Tingting"), engine: "local", label: "婷婷（普通话·本地）" },
  ];
  h.whereResult = [];
  h.selectCount = 0;
  h.updates = [];
  invalidateVoiceCatalogCache();
});

describe("可选与白名单解耦", () => {
  it("已下架音色不进可选列表，但仍在白名单里（存量内容不被运营动作打成非法值）", async () => {
    const ids = (await selectableVoices("linux")).map((v) => v.id);
    expect(ids).toContain("zh-CN-XiaoxiaoNeural");
    expect(ids).not.toContain("zh-CN-XiaohanNeural");
    expect(await knownVoiceIds()).toContain("zh-CN-XiaohanNeural");
    expect(await isVoiceKnown("zh-CN-XiaohanNeural")).toBe(true);
    expect(await isVoiceSelectable("zh-CN-XiaohanNeural", "linux")).toBe(false);
  });

  it("容器（非 darwin）不出本地音色，宿主机 darwin 才出", async () => {
    expect((await selectableVoices("linux")).map((v) => v.id)).not.toContain("Tingting");
    expect((await selectableVoices("darwin")).map((v) => v.id)).toContain("Tingting");
  });

  it("对外列表保持 {id,name,gender} 既有结构", async () => {
    const items = await voiceCatalogItems("linux");
    expect(items[0]).toEqual({
      id: "zh-CN-XiaoxiaoNeural",
      name: "zh-CN-XiaoxiaoNeural",
      gender: "女",
    });
  });
});

describe("写操作与缓存", () => {
  it("下架写库并让缓存失效：紧接着的读拿到新状态", async () => {
    h.whereResult = [edge("zh-CN-XiaoxiaoNeural")];
    h.table = [edge("zh-CN-XiaoxiaoNeural")];
    const r = await setVoiceEnabled("zh-CN-XiaoxiaoNeural", false);
    expect(r.kind).toBe("updated");
    if (r.kind === "updated") expect(r.voice.enabled).toBe(false);
    expect(h.updates[0]?.set.enabled).toBe(0);

    h.table = [edge("zh-CN-XiaoxiaoNeural", 0)];
    expect(await isVoiceSelectable("zh-CN-XiaoxiaoNeural", "linux")).toBe(false);
  });

  it("音色不在目录里返回 not-found，不发写", async () => {
    h.whereResult = [];
    const r = await setVoiceEnabled("zh-CN-NoSuchNeural", true);
    expect(r.kind).toBe("not-found");
    expect(h.updates).toHaveLength(0);
  });

  it("实测结果落库带状态与细节，超长细节截到 200 字符", async () => {
    await recordVoiceProbe("zh-CN-XiaohanNeural", "no_audio", "E".repeat(300));
    const set = h.updates[0]?.set as {
      lastCheckAt: Date;
      lastCheckStatus: string;
      lastCheckDetail: string;
    };
    expect(set.lastCheckStatus).toBe("no_audio");
    expect(set.lastCheckDetail).toHaveLength(200);
    expect(set.lastCheckAt).toBeInstanceOf(Date);
  });
});

describe("目录排序", () => {
  it("可用音色在最前，本地音色不插进工作音色之前，已下架沉底", async () => {
    // 表里故意把本地音色写在最前：排序必须按「能不能用」重排，而不是照主键顺序（id 字典序会把
    // Meijia/Sinji/Tingting 顶到第一屏，运营打开管理页看到的全是灰行）
    h.table = [
      { ...edge("Tingting"), engine: "local" },
      edge("zh-CN-XiaohanNeural", 0),
      edge("zh-CN-XiaoxiaoNeural"),
      edge("zh-CN-YunxiNeural"),
    ];
    invalidateVoiceCatalogCache();
    expect((await loadVoiceCatalog("linux")).map((v) => v.id)).toEqual([
      "zh-CN-XiaoxiaoNeural",
      "zh-CN-YunxiNeural",
      "Tingting",
      "zh-CN-XiaohanNeural",
    ]);
  });
});

describe("目录缓存", () => {
  it("30 秒内重复读只打库一次", async () => {
    await loadVoiceCatalog();
    await loadVoiceCatalog();
    expect(h.selectCount).toBe(1);
    invalidateVoiceCatalogCache();
    await loadVoiceCatalog();
    expect(h.selectCount).toBe(2);
  });
});
