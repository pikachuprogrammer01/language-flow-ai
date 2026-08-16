/**
 * 模板类型守卫（本地实现）
 * ponytail: 不在 renderer 中运行时导入 @ai-english/shared 的守卫函数——
 * tsx + Node 24 下包入口 index.ts 的 `export * from "./content.dto"` 重导出
 * 在运行时导出表缺失（typecheck/vitest 正常，仅 tsx 运行时异常）。
 * 升级路径：Node/tsx 修复 export * 解析后，可改回 `import { isSceneWord } from "@ai-english/shared"`。
 */
import type { ContentDTO, QuizItem, SceneWordSegment, WordCardItem } from "@ai-english/shared";

export function isSceneWord(dto: ContentDTO): dto is ContentDTO & { content: SceneWordSegment[] } {
  return dto.template === "scene_word";
}

export function isWordCard(dto: ContentDTO): dto is ContentDTO & { content: WordCardItem[] } {
  return dto.template === "word_card";
}

export function isQuiz(dto: ContentDTO): dto is ContentDTO & { content: QuizItem[] } {
  return dto.template === "quiz";
}
