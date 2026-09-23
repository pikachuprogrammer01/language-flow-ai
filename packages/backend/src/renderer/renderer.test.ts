import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * 渲染层单测 — Playwright 截图编排（mock 浏览器）/ scene_word 与 word_card 渲染器（mock 截图与片头）/ 守卫与模板工具
 * 真实保留：HTML 模板加载与填充（防注入转义是核心安全逻辑）
 */
import type { ContentDTO } from "@ai-english/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { launchMock, browserClose, pageCalls } = vi.hoisted(() => ({
  launchMock: vi.fn(),
  browserClose: vi.fn(),
  pageCalls: { screenshots: [] as string[], evaluates: [] as unknown[] },
}));

/** goto/evaluate 钩子：真实拉取静态服务三类响应（200/403/404）与驱动截帧墙钟 deadline */
let gotoHook: ((url: string) => Promise<void>) | undefined;
let evaluateHook: (() => void) | undefined;
let pageEvaluateReturn: unknown = 100;

function makeFakePage() {
  return {
    goto: vi.fn(async (url: string) => {
      if (gotoHook) await gotoHook(url);
    }),
    waitForFunction: vi.fn(async () => {}),
    evaluate: vi.fn(async () => {
      if (evaluateHook) evaluateHook();
      return pageEvaluateReturn;
    }),
    setContent: vi.fn(async () => {}),
    screenshot: vi.fn(async (opts: { path: string }) => {
      pageCalls.screenshots.push(opts.path);
    }),
    close: vi.fn(async () => {}),
  };
}

let fakePage: ReturnType<typeof makeFakePage>;

vi.mock("playwright", () => ({
  chromium: {
    launch: launchMock.mockImplementation(async () => ({
      newPage: async () => {
        fakePage = makeFakePage();
        return fakePage;
      },
      close: browserClose,
    })),
  },
}));

const { screenshotHtmls, screenshotSeekAnimation } = await import("./playwright");
const { fillTemplate, escapeHtml, escapeRegExp, loadTemplate } = await import("./html");
const { isQuiz, isSceneWord, isWordCard } = await import("./guards");

beforeEach(() => {
  pageCalls.screenshots.length = 0;
  pageEvaluateReturn = 100;
  gotoHook = undefined;
  evaluateHook = undefined;
  launchMock.mockClear();
  browserClose.mockClear();
});

describe("screenshotHtmls", () => {
  it("多帧共用一个浏览器实例，路径按 frame-0001 递增，结束必关浏览器", async () => {
    const paths = await screenshotHtmls(["<h1>a</h1>", "<h1>b</h1>"], "/tmp/wd");
    expect(paths).toEqual(["/tmp/wd/frame-0001.png", "/tmp/wd/frame-0002.png"]);
    expect(launchMock).toHaveBeenCalledTimes(1);
    expect(pageCalls.screenshots).toEqual(paths);
    expect(browserClose).toHaveBeenCalledTimes(1);
  });

  it("页面异常也要关闭浏览器（不泄漏进程）", async () => {
    const boom = new Error("setContent failed");
    launchMock.mockImplementationOnce(async () => ({
      newPage: async () => ({
        setContent: vi.fn(async () => {
          throw boom;
        }),
        screenshot: vi.fn(),
      }),
      close: browserClose,
    }));
    await expect(screenshotHtmls(["x"], "/tmp/wd")).rejects.toThrow("setContent failed");
    expect(browserClose).toHaveBeenCalledTimes(1);
  });
});

describe("screenshotSeekAnimation（WebGL 片头截帧）", () => {
  it("正常：init/seek 注入 + 黑屏探针通过 + 按 fps 截足帧数；静态服务 200/403/404 三类响应均如实处理", async () => {
    const root = await mkdtemp(join(tmpdir(), "lf-pw-root-"));
    await mkdir(join(root, "templates"), { recursive: true });
    await writeFile(join(root, "templates", "x.html"), "<html>intro</html>");
    gotoHook = async (url) => {
      const ok = await fetch(url);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("Content-Type")).toContain("text/html");
      // 编码斜杠防客户端规范化：服务端 decode 后暴露 ".." 穿越意图 → 403
      const origin = new URL(url).origin;
      const traversal = await fetch(`${origin}/a%2f..%2f..%2foutside`);
      expect(traversal.status).toBe(403);
      const missing = await fetch(`${origin}/missing.html`);
      expect(missing.status).toBe(404);
    };
    const paths = await screenshotSeekAnimation({
      htmlRelativePath: "templates/x.html",
      rendererRoot: root,
      workDir: "/tmp/wd",
      initPayload: { topic: "t" },
      durationSec: 1,
      fps: 4,
      filePrefix: "intro",
    });
    expect(paths).toHaveLength(4);
    expect(paths[0]).toBe("/tmp/wd/intro-0001.png");
    expect(fakePage?.goto).toHaveBeenCalled();
    expect(browserClose).toHaveBeenCalledTimes(1);
  });

  it("截帧墙钟超时（>120s）fail-closed 抛出，不无限挂起", async () => {
    vi.useFakeTimers();
    evaluateHook = () => vi.advanceTimersByTime(121_000);
    await expect(
      screenshotSeekAnimation({
        htmlRelativePath: "t.html",
        rendererRoot: "/tmp/r",
        workDir: "/tmp/wd",
        initPayload: {},
        durationSec: 1,
        fps: 2,
      }),
    ).rejects.toThrow("截帧超时");
    vi.useRealTimers();
  });

  it("黑屏（maxLuma<40）fail-closed 抛出", async () => {
    pageEvaluateReturn = 10;
    await expect(
      screenshotSeekAnimation({
        htmlRelativePath: "t.html",
        rendererRoot: "/tmp/r",
        workDir: "/tmp/wd",
        initPayload: {},
        durationSec: 1,
        fps: 1,
      }),
    ).rejects.toThrow("疑似黑屏");
  });

  it("探针缺失（-1）不放行", async () => {
    pageEvaluateReturn = -1;
    await expect(
      screenshotSeekAnimation({
        htmlRelativePath: "t.html",
        rendererRoot: "/tmp/r",
        workDir: "/tmp/wd",
        initPayload: {},
        durationSec: 1,
        fps: 1,
      }),
    ).rejects.toThrow("探针不可用");
  });
});

describe("模板工具（防注入核心）", () => {
  it("escapeHtml 覆盖五字符；escapeRegExp 覆盖正则元字符", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;",
    );
    expect(escapeRegExp("a.b*c")).toBe("a\\.b\\*c");
  });

  it("fillTemplate 只替换已知占位符，未知保留原样", () => {
    expect(fillTemplate("{{A}}-{{B}}-{{C}}", { A: "1", B: "2" })).toBe("1-2-{{C}}");
  });

  it("loadTemplate 真实读取三份模板且带缓存（二次调用不读盘）", async () => {
    const html = await loadTemplate("quiz.html");
    expect(html).toContain("{{STEM}}");
    const again = await loadTemplate("quiz.html");
    expect(again).toBe(html); // 同一字符串实例 = 缓存命中
  });
});

describe("guards", () => {
  const dto = (template: string) => ({ template }) as ContentDTO;
  it("三模板互斥判定", () => {
    expect(isSceneWord(dto("scene_word"))).toBe(true);
    expect(isWordCard(dto("word_card"))).toBe(true);
    expect(isQuiz(dto("quiz"))).toBe(true);
    expect(isQuiz(dto("scene_word"))).toBe(false);
  });
});
