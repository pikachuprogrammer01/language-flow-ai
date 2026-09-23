/**
 * shared DTO 运行时守卫单测 — 模板判别守卫（渲染分发与前端展示共用的类型收窄点）
 */
import { describe, expect, it } from "vitest";
import { isQuiz, isSceneWord, isWordCard } from "./content.dto";
import { TemplateTypeEnum } from "./enums";

const dto = (template: string) => ({ template }) as never;

describe("ContentDTO 模板守卫", () => {
  it("三种模板各认各的、互不误判", () => {
    expect(isSceneWord(dto("scene_word"))).toBe(true);
    expect(isSceneWord(dto("quiz"))).toBe(false);
    expect(isWordCard(dto("word_card"))).toBe(true);
    expect(isWordCard(dto("scene_word"))).toBe(false);
    expect(isQuiz(dto("quiz"))).toBe(true);
    expect(isQuiz(dto("word_card"))).toBe(false);
  });
});

describe("枚举常量（snake_case 入库契约）", () => {
  it("模板枚举值为 snake_case 字符串", () => {
    expect(Object.values(TemplateTypeEnum)).toEqual(["scene_word", "word_card", "quiz"]);
    expect(Object.values(TemplateTypeEnum).every((v) => v === v.toLowerCase())).toBe(true);
  });
});
