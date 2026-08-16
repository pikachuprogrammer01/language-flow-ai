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
