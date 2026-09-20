/**
 * scene_word 片头：Three.js 约 1 秒主题化动效（24fps）
 * 主题归类：本地 LLM 将任意主题（含 AI 推荐）映射到母题枚举；失败再轻量关键词兜底。
 */
import { z } from "zod";
import { logger } from "../lib/logger";
import { LlmNotConfiguredError, chatCompletion, extractJson } from "../services/llm.service";
import { screenshotSeekAnimation } from "./playwright";
import type { RenderFrame } from "./renderer.interface";

export const INTRO_DURATION_SEC = 1;
export const INTRO_FPS = 24;

export const INTRO_MOTIFS = [
  "coffee",
  "forest",
  "campus",
  "tech",
  "city",
  "night",
  "interview",
  "office",
  "commute",
  "beach",
  "romance",
  "fitness",
  "music",
  "store",
  "medical",
  "home",
  "default",
] as const;

export type IntroMotif = (typeof INTRO_MOTIFS)[number];

export interface IntroTheme {
  motif: IntroMotif;
  label: string;
  primary: string;
  complement: string;
  bg: string;
}

/** 各母题默认配色（LLM 只负责选 motif + 短标签） */
const MOTIF_PALETTE: Record<IntroMotif, Omit<IntroTheme, "motif" | "label">> = {
  coffee: { primary: "#fbbf24", complement: "#fdba74", bg: "#1c1410" },
  forest: { primary: "#34d399", complement: "#a7f3d0", bg: "#0f1a14" },
  campus: { primary: "#60a5fa", complement: "#f9a8d4", bg: "#10151f" },
  tech: { primary: "#a78bfa", complement: "#67e8f9", bg: "#120f1c" },
  city: { primary: "#94a3b8", complement: "#f9a8d4", bg: "#12151a" },
  night: { primary: "#6366f1", complement: "#fbbf24", bg: "#07071a" },
  interview: { primary: "#38bdf8", complement: "#fbbf24", bg: "#0f172a" },
  office: { primary: "#94a3b8", complement: "#34d399", bg: "#111827" },
  commute: { primary: "#94a3b8", complement: "#38bdf8", bg: "#0f1419" },
  beach: { primary: "#22d3ee", complement: "#fde68a", bg: "#08202a" },
  romance: { primary: "#f472b6", complement: "#c4b5fd", bg: "#1a1020" },
  fitness: { primary: "#f87171", complement: "#fbbf24", bg: "#1a1010" },
  music: { primary: "#e879f9", complement: "#fde68a", bg: "#1a0a1c" },
  store: { primary: "#f97316", complement: "#fde68a", bg: "#1a1008" },
  medical: { primary: "#67e8f9", complement: "#e2e8f0", bg: "#0c1a1c" },
  home: { primary: "#fb923c", complement: "#86efac", bg: "#1a140c" },
  default: { primary: "#60a5fa", complement: "#fbbf24", bg: "#141418" },
};

const MOTIF_HINT: Record<IntroMotif, string> = {
  coffee: "餐饮咖啡美食",
  forest: "自然山林露营环保",
  campus: "校园学习图书馆考试书店",
  tech: "科技创业互联网数码",
  city: "城市街景摄影都市风貌",
  night: "夜晚加班夜归深夜月光窗灯",
  interview: "面试求职简历笔试",
  office: "办公职场电脑远程会议",
  commute: "地铁公交通勤路上",
  beach: "海边沙滩旅行度假",
  romance: "情感约会重逢思念宠物",
  fitness: "健身跑步运动夜跑",
  music: "音乐演出话剧演唱会",
  store: "便利店夜市市集购物开箱",
  medical: "医院就诊看病",
  home: "家庭厨房邻里搬家社区",
  default: "无法归类时的通用",
};

const llmOutSchema = z.object({
  motif: z.string(),
  label: z.string().min(1).max(16),
});

const themeCache = new Map<string, IntroTheme>();
/** 成功分类结果的进程内缓存上限（E10：原无界；满则按插入序淘汰最旧） */
const THEME_CACHE_MAX = 200;

/** 仅缓存成功分类结果；满则 FIFO 淘汰最旧一个（失败兜底不入缓存，下次重试 LLM） */
function cacheTheme(key: string, theme: IntroTheme): void {
  if (themeCache.size >= THEME_CACHE_MAX) {
    const oldest = themeCache.keys().next().value;
    if (oldest !== undefined) themeCache.delete(oldest);
  }
  themeCache.set(key, theme);
}

export function isIntroMotif(value: string): value is IntroMotif {
  return (INTRO_MOTIFS as readonly string[]).includes(value);
}

export function buildThemeFromMotif(motif: IntroMotif, label: string): IntroTheme {
  const palette = MOTIF_PALETTE[motif];
  return {
    motif,
    label: label.trim().slice(0, 12) || "情景记忆",
    ...palette,
  };
}

/** LLM 未配置/失败时的轻量兜底（不维护主题清单） */
export function fallbackIntroTheme(topic: string): IntroTheme {
  const key = topic.trim();
  const rules: Array<{ match: RegExp; motif: IntroMotif }> = [
    { match: /加班|夜归|通宵|深夜回家/, motif: "night" },
    { match: /面试|求职|简历|笔试/, motif: "interview" },
    { match: /咖啡|美食|餐厅|点餐|食堂/, motif: "coffee" },
    { match: /森林|露营|环保|山川/, motif: "forest" },
    { match: /校园|图书馆|考试|备考|书店/, motif: "campus" },
    { match: /创业|科技|融资|编程|互联网/, motif: "tech" },
    { match: /地铁|通勤|公交/, motif: "commute" },
    { match: /健身|跑步|夜跑/, motif: "fitness" },
    { match: /约会|重逢|思念|恋爱/, motif: "romance" },
    { match: /海边|沙滩|度假/, motif: "beach" },
    { match: /医院|就诊/, motif: "medical" },
    { match: /音乐|演唱会|话剧/, motif: "music" },
    { match: /便利店|夜市|市集|网购/, motif: "store" },
    { match: /办公|职场|远程/, motif: "office" },
    { match: /家庭|厨房|搬家|邻里/, motif: "home" },
    { match: /城市|街拍|都市/, motif: "city" },
  ];
  for (const row of rules) {
    if (row.match.test(key)) {
      return buildThemeFromMotif(row.motif, key.slice(0, 8) || row.motif);
    }
  }
  return buildThemeFromMotif("default", key.slice(0, 8) || "情景记忆");
}

/**
 * 用本地 LLM 把主题归到已有母题（任意文案 / AI 推荐均可）。
 * 结果按 topic 缓存，同一主题重复渲染不重复问模型。
 */
export async function resolveIntroTheme(topic: string): Promise<IntroTheme> {
  const key = topic.trim() || "情景记忆";
  const cached = themeCache.get(key);
  if (cached) return cached;

  try {
    const motifList = INTRO_MOTIFS.map((m) => `- ${m}: ${MOTIF_HINT[m]}`).join("\n");
    const raw = await chatCompletion(
      [
        {
          role: "system",
          content:
            "你是短视频片头视觉分类器。根据用户主题，从给定 motif 枚举中选最贴切的一个，并给短中文标签。只输出 JSON。",
        },
        {
          role: "user",
          content: `主题：「${key}」\n\n可选 motif（必须选其一）：\n${motifList}\n\n输出格式：{"motif":"night","label":"加班夜归"}\n要求：motif 必须是列表中的英文枚举；label ≤8 个汉字，概括主题氛围。`,
        },
      ],
      { temperature: 0, timeoutMs: 20_000 },
    );
    const parsed = llmOutSchema.parse(extractJson<unknown>(raw));
    const motif = isIntroMotif(parsed.motif) ? parsed.motif : "default";
    const theme = buildThemeFromMotif(motif, parsed.label);
    cacheTheme(key, theme);
    logger.info(
      { topic: key, motif: theme.motif, label: theme.label },
      "intro theme classified by LLM",
    );
    return theme;
  } catch (err) {
    if (!(err instanceof LlmNotConfiguredError)) {
      logger.warn(
        { topic: key, err: err instanceof Error ? err.message : String(err) },
        "intro theme LLM 分类失败，使用兜底",
      );
    }
    const theme = fallbackIntroTheme(key);
    // 失败兜底不写缓存（E10/M3：避免瞬时 LLM 故障被永久固化为次优配色）
    return theme;
  }
}

/** @deprecated 同步配色查询：走兜底规则（测试/兼容） */
export function resolveIntroColors(topic: string): { primary: string; complement: string } {
  const t = fallbackIntroTheme(topic);
  return { primary: t.primary, complement: t.complement };
}

/** 测试用：清空主题缓存 */
export function clearIntroThemeCache(): void {
  themeCache.clear();
}

export interface IntroCaptureInput {
  topic: string;
  title: string;
  highlightWord?: string;
  workDir: string;
}

export async function captureThreeIntro(input: IntroCaptureInput): Promise<RenderFrame[] | null> {
  const themeResolved = await resolveIntroTheme(input.topic);
  const rendererRoot = import.meta.dirname;
  try {
    const paths = await screenshotSeekAnimation({
      htmlRelativePath: "templates/three-intro.html",
      rendererRoot,
      workDir: input.workDir,
      durationSec: INTRO_DURATION_SEC,
      fps: INTRO_FPS,
      filePrefix: "intro",
      initPayload: {
        title: input.title,
        highlightWord: input.highlightWord ?? "",
        topicLabel: themeResolved.label,
        motif: themeResolved.motif,
        primaryColor: themeResolved.primary,
        complementColor: themeResolved.complement,
        bgColor: themeResolved.bg,
      },
    });
    const frameDuration = INTRO_DURATION_SEC / paths.length;
    return paths.map((filePath) => ({ filePath, duration: frameDuration }));
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Three.js 片头截帧失败，跳过片头",
    );
    return null;
  }
}
