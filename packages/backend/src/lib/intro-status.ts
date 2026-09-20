/**
 * 片头渲染结果枚举运行时元组。
 * 类型真相源在 @ai-english/shared 的 `IntroStatus`；shared 为纯源码包运行时不导出值，
 * 故 zod 所需的字面量元组在此单独声明（与 IntroStatus 严格一致）。
 */
export const INTRO_STATUS_VALUES = ["rendered", "failed", "disabled", "unknown"] as const;
