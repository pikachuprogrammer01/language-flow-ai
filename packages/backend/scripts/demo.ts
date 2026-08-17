/**
 * 一键端到端演示：content/generate → tts/from-content → video/render
 * 用法：pnpm exec tsx scripts/demo.ts "美食探店" CET4 8 60
 */
import type { ContentDTO } from "@ai-english/shared";

const [topic, level = "CET4", wordCount = "8", targetDuration = "60"] = process.argv.slice(2);
const BASE = "http://localhost:8080";

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok)
    throw new Error(`${path} ${res.status}: ${data.error ?? JSON.stringify(data).slice(0, 300)}`);
  return data;
}

async function main(): Promise<void> {
  console.log(`== 1. 生成内容：${topic}（${level}，${wordCount} 词）`);
  const gen = await post<{ content: ContentDTO }>("/api/content/generate", {
    topic,
    level,
    wordCount: Number(wordCount),
    targetDuration: Number(targetDuration),
  });
  const dto = gen.content;
  console.log(`   标题「${dto.title}」 段数 ${dto.content.length} 词数 ${dto.words.length}`);

  console.log("== 2. TTS 配音");
  const audio = await post<{ audio: { url: string; duration: number } }>("/api/tts/from-content", {
    template: "scene_word",
    content: dto.content,
  });
  console.log(`   ${audio.audio.url}（${audio.audio.duration}s）`);
  dto.audio = audio.audio as never;

  console.log("== 3. 渲染视频");
  const video = await post<{ video: { url: string } }>("/api/video/render", dto);
  console.log(`== ✅ 完成：${BASE}${video.video.url}`);
}

main().catch((err) => {
  console.error("失败:", err.message);
  process.exit(1);
});
