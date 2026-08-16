/**
 * 渲染共用工具：HTML 转义、正则转义、模板加载缓存
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** HTML 特殊字符转义（注入模板前必须转义，防模板注入/错版） */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 正则特殊字符转义（用于 text 中高亮目标词） */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const templateCache = new Map<string, string>();

/** 读取模板文件（带缓存），返回原始 HTML */
export async function loadTemplate(name: string): Promise<string> {
  const cached = templateCache.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const html = await readFile(join(import.meta.dirname, "templates", name), "utf-8");
  templateCache.set(name, html);
  return html;
}

/** 模板占位符替换（{{KEY}} → 转义后的值） */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match);
}
