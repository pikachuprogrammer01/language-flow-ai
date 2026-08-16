/**
 * POST /api/cet/validate-words 测试
 * 覆盖：全部匹配 / 部分匹配 / 全部未匹配 / 重复词去重 / frequency null
 *       / 空 words 400 / 空串 400 / 非法 level 400 / 内部错误 500
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CetWordRow, CetWordsDb } from "../services/cet.service";
import * as cetService from "../services/cet.service";
import { cet } from "./cet";

// mock db 模块：db/index.ts 顶层 await 连接真实 MySQL，测试环境无 DATABASE_URL
vi.mock("../db", () => ({ db: {} }));

// 测试替身：模拟 drizzle select().from().where() 链，返回固定行
const fakeDb = (rows: CetWordRow[]): CetWordsDb => ({
  select: () => ({
    from: () => ({
      where: async () => rows,
    }),
  }),
});

const ROW_CONTRACT: CetWordRow = {
  id: 1,
  word: "contract",
  meaning: "合同",
  level: "CET4",
  frequency: 0.85,
};
const ROW_CONTINENT: CetWordRow = {
  id: 2,
  word: "continent",
  meaning: "大陆",
  level: "CET4",
  frequency: 0.72,
};

// ── service 层 ──

describe("validateWords", () => {
  it("全部匹配：matchedWords 完整返回，unmatchedWords 为空", async () => {
    const result = await cetService.validateWords(
      ["contract", "continent"],
      "CET4",
      fakeDb([ROW_CONTRACT, ROW_CONTINENT]),
    );

    expect(result.matchedWords).toEqual([
      { word: "contract", level: "CET4", meaning: "合同", frequency: 0.85 },
      { word: "continent", level: "CET4", meaning: "大陆", frequency: 0.72 },
    ]);
    expect(result.unmatchedWords).toEqual([]);
  });

  it("部分匹配：未命中的词进入 unmatchedWords", async () => {
    const result = await cetService.validateWords(
      ["contract", "consultation"],
      "CET4",
      fakeDb([ROW_CONTRACT]),
    );

    expect(result.matchedWords.map((m) => m.word)).toEqual(["contract"]);
    expect(result.unmatchedWords).toEqual(["consultation"]);
  });

  it("全部未匹配：matchedWords 为空，全部进入 unmatchedWords", async () => {
    const result = await cetService.validateWords(["abc", "xyz"], "CET4", fakeDb([]));

    expect(result.matchedWords).toEqual([]);
    expect(result.unmatchedWords).toEqual(["abc", "xyz"]);
  });

  it("重复候选词去重，保持首次出现顺序", async () => {
    const result = await cetService.validateWords(
      ["contract", "contract", "continent"],
      "CET4",
      fakeDb([ROW_CONTINENT, ROW_CONTRACT]), // 数据库返回乱序，应重排为输入顺序
    );

    expect(result.matchedWords.map((m) => m.word)).toEqual(["contract", "continent"]);
  });

  it("frequency 为 null 时返回 undefined（可选字段省略）", async () => {
    const result = await cetService.validateWords(
      ["contract"],
      "CET4",
      fakeDb([{ ...ROW_CONTRACT, frequency: null }]),
    );

    expect(result.matchedWords[0]).toEqual({
      word: "contract",
      level: "CET4",
      meaning: "合同",
      frequency: undefined,
    });
  });

  it("空数组直接返回空结果，不执行查询", async () => {
    const result = await cetService.validateWords([], "CET4", fakeDb([]));

    expect(result).toEqual({ matchedWords: [], unmatchedWords: [] });
  });
});

// ── randomWords ──

const makeWordRow = (id: number, word: string, frequency: number | null): CetWordRow => ({
  id,
  word,
  meaning: `释义${id}`,
  level: "CET4",
  frequency,
});

describe("randomWords", () => {
  it("高频池随机抽取 count 个，无重复且等级正确", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => makeWordRow(i, `word${i}`, i / 20));
    const result = await cetService.randomWords("CET4", 5, fakeDb(rows));

    expect(result.words).toHaveLength(5);
    expect(new Set(result.words.map((w) => w.word)).size).toBe(5);
    for (const w of result.words) {
      expect(w.level).toBe("CET4");
      expect(w.meaning).toBeTruthy();
    }
  });

  it("词库不足时返回少于 count 个", async () => {
    const rows = [makeWordRow(1, "a", 0.1), makeWordRow(2, "b", 0.2), makeWordRow(3, "c", 0.3)];
    const result = await cetService.randomWords("CET4", 10, fakeDb(rows));

    expect(result.words).toHaveLength(3);
  });

  it("frequency 为 null 时字段省略，不影响抽取", async () => {
    const rows = [makeWordRow(1, "a", null), makeWordRow(2, "b", null), makeWordRow(3, "c", null)];
    const result = await cetService.randomWords("CET4", 2, fakeDb(rows));

    expect(result.words).toHaveLength(2);
    for (const w of result.words) {
      expect(w.frequency).toBeUndefined();
    }
  });

  it("空词库返回空 words", async () => {
    const result = await cetService.randomWords("CET4", 5, fakeDb([]));

    expect(result.words).toEqual([]);
  });
});

// ── route 层 ──

describe("POST /api/cet/validate-words", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const postJson = (body: unknown) =>
    cet.request("/validate-words", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("200：正常返回 matchedWords + unmatchedWords", async () => {
    vi.spyOn(cetService, "validateWords").mockResolvedValue({
      matchedWords: [{ word: "contract", level: "CET4", meaning: "合同", frequency: 0.85 }],
      unmatchedWords: ["consultation"],
    });

    const res = await postJson({ words: ["contract", "consultation"], level: "CET4" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      matchedWords: [{ word: "contract", level: "CET4", meaning: "合同", frequency: 0.85 }],
      unmatchedWords: ["consultation"],
    });
  });

  it("200：全部未匹配也返回 200（SPEC 错误码表）", async () => {
    vi.spyOn(cetService, "validateWords").mockResolvedValue({
      matchedWords: [],
      unmatchedWords: ["abc", "xyz"],
    });

    const res = await postJson({ words: ["abc", "xyz"], level: "CET4" });

    expect(res.status).toBe(200);
  });

  it("400：words 为空数组", async () => {
    const res = await postJson({ words: [], level: "CET4" });

    expect(res.status).toBe(400);
  });

  it("400：words 含空字符串", async () => {
    const res = await postJson({ words: [""], level: "CET4" });

    expect(res.status).toBe(400);
  });

  it("400：单词超过 100 字符（与 cet_words.word varchar(100) 对齐）", async () => {
    const res = await postJson({ words: ["a".repeat(101)], level: "CET4" });

    expect(res.status).toBe(400);
  });

  it("400：level 非法", async () => {
    const res = await postJson({ words: ["contract"], level: "CET8" });

    expect(res.status).toBe(400);
  });

  it("500：service 抛错时返回错误信息", async () => {
    vi.spyOn(cetService, "validateWords").mockRejectedValue(new Error("db down"));

    const res = await postJson({ words: ["contract"], level: "CET4" });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "词库查询失败" });
  });
});

// ── POST /api/cet/random-words ──

describe("POST /api/cet/random-words", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const postJson = (body: unknown) =>
    cet.request("/random-words", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("200：正常返回随机词汇列表", async () => {
    vi.spyOn(cetService, "randomWords").mockResolvedValue({
      words: [
        { word: "contract", level: "CET4", meaning: "合同", frequency: 0.85 },
        { word: "dense", level: "CET4", meaning: "茂密的", frequency: 0.5 },
      ],
    });

    const res = await postJson({ level: "CET4", count: 2 });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      words: [
        { word: "contract", level: "CET4", meaning: "合同", frequency: 0.85 },
        { word: "dense", level: "CET4", meaning: "茂密的", frequency: 0.5 },
      ],
    });
  });

  it("200：词库不足时返回少于 count 个（service 行为透传）", async () => {
    vi.spyOn(cetService, "randomWords").mockResolvedValue({
      words: [{ word: "contract", level: "CET4", meaning: "合同", frequency: 0.85 }],
    });

    const res = await postJson({ level: "CET4", count: 15 });

    expect(res.status).toBe(200);
  });

  it("400：count 为 0", async () => {
    const res = await postJson({ level: "CET4", count: 0 });

    expect(res.status).toBe(400);
  });

  it("400：count 超过 15", async () => {
    const res = await postJson({ level: "CET4", count: 16 });

    expect(res.status).toBe(400);
  });

  it("400：count 非整数", async () => {
    const res = await postJson({ level: "CET4", count: 1.5 });

    expect(res.status).toBe(400);
  });

  it("400：level 非法", async () => {
    const res = await postJson({ level: "CET8", count: 5 });

    expect(res.status).toBe(400);
  });

  it("500：service 抛错时返回错误信息", async () => {
    vi.spyOn(cetService, "randomWords").mockRejectedValue(new Error("db down"));

    const res = await postJson({ level: "CET4", count: 5 });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "词库查询失败" });
  });
});
