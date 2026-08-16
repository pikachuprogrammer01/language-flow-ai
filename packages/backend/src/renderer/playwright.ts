/**
 * Playwright 截图封装（docs/10 §五）
 * - 一次浏览器实例渲染多帧，1080×1920 PNG
 * - playwright 为按需安装依赖：未安装时动态 import 抛错 → 上层 500（渲染启动失败路径）
 */
import { join } from "node:path";

export async function screenshotHtmls(htmlList: string[], workDir: string): Promise<string[]> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1080, height: 1920 },
      deviceScaleFactor: 1,
    });
    const paths: string[] = [];
    for (let i = 0; i < htmlList.length; i++) {
      const filePath = join(workDir, `frame-${String(i + 1).padStart(4, "0")}.png`);
      await page.setContent(htmlList[i], { waitUntil: "load" });
      await page.screenshot({ path: filePath, type: "png" });
      paths.push(filePath);
    }
    return paths;
  } finally {
    await browser.close();
  }
}
