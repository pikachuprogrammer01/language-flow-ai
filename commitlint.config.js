// commitlint.config.js — Commit 信息格式校验
// 规则文档: https://commitlint.js.org/reference/rules.html

/** @type {import('@commitlint/types').UserConfig} */
module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // type 必须是以下之一
    "type-enum": [2, "always", ["feat", "fix", "refactor", "docs", "test", "chore", "style"]],
    // scope 可选，但如果写必须是以下之一
    "scope-enum": [2, "always", ["shared", "backend", "frontend", "dify", "docs"]],
    // 描述长度 ≤ 72 字符（GitHub 友好）
    "header-max-length": [2, "always", 72],
    // type 和描述不能为空
    "type-empty": [2, "never"],
    "subject-empty": [2, "never"],
  },
};
