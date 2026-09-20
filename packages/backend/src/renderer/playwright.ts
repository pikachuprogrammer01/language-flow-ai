import { readFile } from "node:fs/promises";
/**
 * Playwright 截图封装（docs/10 §五）
 * - 一次浏览器实例渲染多帧，1080×1920 PNG
 * - Three.js 片头：本机 HTTP 托管模板/vendor（避免 file:// ES module CORS）
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";

const VIEWPORT = { width: 1080, height: 1920, deviceScaleFactor: 1 } as const;

/** WebGL 友好启动参数 */
const CHROMIUM_ARGS = [
  "--use-gl=angle",
  "--enable-webgl",
  "--ignore-gpu-blocklist",
  "--enable-unsafe-swiftshader",
];

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
};

async function launchBrowser(): Promise<
  Awaited<ReturnType<Awaited<typeof import("playwright")>["chromium"]["launch"]>>
> {
  const { chromium } = await import("playwright");
  return chromium.launch({ headless: true, args: CHROMIUM_ARGS });
}

/** 在 rootDir 上起一次性静态服务，供 Playwright 加载 ES module */
async function withStaticServer<T>(
  rootDir: string,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const root = resolve(rootDir);
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const rawPath = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
        const filePath = normalize(join(root, rawPath));
        if (!filePath.startsWith(root + sep) && filePath !== root) {
          res.writeHead(403).end("Forbidden");
          return;
        }
        const data = await readFile(filePath);
        res.writeHead(200, {
          "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream",
          "Cache-Control": "no-store",
        });
        res.end(data);
      } catch {
        res.writeHead(404).end("Not Found");
      }
    })();
  });
  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolveClose, reject) => {
      server.close((err) => (err ? reject(err) : resolveClose()));
    });
  }
}

export async function screenshotHtmls(htmlList: string[], workDir: string): Promise<string[]> {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({
      viewport: { width: VIEWPORT.width, height: VIEWPORT.height },
      deviceScaleFactor: VIEWPORT.deviceScaleFactor,
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

export interface SeekCaptureOptions {
  /** 相对 renderer 根目录的 HTML 路径，如 templates/three-intro.html */
  htmlRelativePath: string;
  /** renderer 根目录（含 templates/、vendor/） */
  rendererRoot: string;
  workDir: string;
  initPayload: Record<string, unknown>;
  durationSec: number;
  fps: number;
  filePrefix?: string;
}

/** 片头截帧整体墙钟超时（E9：截帧循环此前无总超时，浏览器/页面可无限挂起） */
const INTRO_CAPTURE_DEADLINE_MS = 120_000;
/** 页面须暴露的 seek 动画控制面 */
interface IntroWindow {
  __intro?: {
    init?: (payload: Record<string, unknown>) => void;
    seek?: (t: number) => void;
    ready?: boolean;
    sampleMaxLuma?: () => number;
  };
}

/** 加载可 seek 的动画页并注入初始数据，返回就绪的 page */
async function loadSeekablePage(
  browser: Awaited<ReturnType<typeof launchBrowser>>,
  pageUrl: string,
  initPayload: Record<string, unknown>,
  viewport: { width: number; height: number },
  deviceScaleFactor: number,
): Promise<Awaited<ReturnType<typeof browser.newPage>>> {
  const page = await browser.newPage({ viewport, deviceScaleFactor });
  await page.goto(pageUrl, { waitUntil: "networkidle", timeout: 30_000 });
  await page.waitForFunction(() => Boolean((window as unknown as IntroWindow).__intro?.init), {
    timeout: 15_000,
  });
  await page.evaluate((payload) => {
    (window as unknown as IntroWindow).__intro?.init?.(payload);
  }, initPayload);
  await page.waitForFunction(() => Boolean((window as unknown as IntroWindow).__intro?.ready), {
    timeout: 10_000,
  });
  return page;
}

/** t=0.3 seek 后采样黑屏：亮度 < 40 判黑屏；探针缺失 fail-closed 抛出（H2：不再静默放行） */
async function assertNotBlackScreen(
  page: Awaited<ReturnType<typeof loadSeekablePage>>,
): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as IntroWindow).__intro?.seek?.(0.3);
  });
  const maxLuma = await page.evaluate(() => {
    const intro = (window as unknown as IntroWindow).__intro;
    return typeof intro?.sampleMaxLuma === "function" ? intro.sampleMaxLuma() : -1;
  });
  if (maxLuma < 0) {
    throw new Error("WebGL 片头黑屏探针不可用（sampleMaxLuma 缺失）");
  }
  if (maxLuma < 40) {
    throw new Error(`WebGL 片头疑似黑屏（max luma=${maxLuma}）`);
  }
}

/** 逐时间点 seek + 截帧；每帧前检查墙钟 deadline，超时抛出 */
async function captureFrames(
  page: Awaited<ReturnType<typeof loadSeekablePage>>,
  workDir: string,
  filePrefix: string,
  frameCount: number,
  fps: number,
  deadlineAt: number,
): Promise<string[]> {
  const paths: string[] = [];
  for (let i = 0; i < frameCount; i++) {
    if (Date.now() > deadlineAt) {
      throw new Error(`WebGL 片头截帧超时（deadline ${INTRO_CAPTURE_DEADLINE_MS}ms）`);
    }
    const t = i / fps;
    await page.evaluate((time) => {
      (window as unknown as IntroWindow).__intro?.seek?.(time);
    }, t);
    const filePath = join(workDir, `${filePrefix}-${String(i + 1).padStart(4, "0")}.png`);
    await page.screenshot({ path: filePath, type: "png" });
    paths.push(filePath);
  }
  return paths;
}

/**
 * 加载可 seek 的动画页，按均匀时间点截帧。
 * 页面需暴露 window.__intro = { init, seek, ready, sampleMaxLuma? }
 */
export async function screenshotSeekAnimation(options: SeekCaptureOptions): Promise<string[]> {
  const {
    htmlRelativePath,
    rendererRoot,
    workDir,
    initPayload,
    durationSec,
    fps,
    filePrefix = "intro",
  } = options;
  const frameCount = Math.max(1, Math.round(durationSec * fps));

  return withStaticServer(rendererRoot, async (baseUrl) => {
    const browser = await launchBrowser();
    try {
      const pageUrl = `${baseUrl}/${htmlRelativePath.replace(/^\//, "")}`;
      const page = await loadSeekablePage(
        browser,
        pageUrl,
        initPayload,
        { width: VIEWPORT.width, height: VIEWPORT.height },
        VIEWPORT.deviceScaleFactor,
      );
      await assertNotBlackScreen(page);
      return await captureFrames(
        page,
        workDir,
        filePrefix,
        frameCount,
        fps,
        Date.now() + INTRO_CAPTURE_DEADLINE_MS,
      );
    } finally {
      await browser.close();
    }
  });
}
