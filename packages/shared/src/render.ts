/**
 * 渲染链路共享纯函数 — 后端渲染器与前端视频预览共用的呈现逻辑
 * 单一事实源：任何字号/布局档位调整必须同时生效于成片与预览，禁止在两侧各抄一份
 */

/**
 * scene_word 正文字号自适应（按文本总量分档，短文本大字号，长文本缩小保证放得下）
 * 消费方：backend renderer/scene-word.renderer.ts（成片帧）+ frontend CreateTask 手机预览
 */
export function fitSceneWordFontSize(textLength: number): number {
  if (textLength < 90) return 42;
  if (textLength < 160) return 36;
  if (textLength < 240) return 32;
  return 28;
}
