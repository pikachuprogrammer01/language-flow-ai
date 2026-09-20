/**
 * 真实 MySQL 集成测试（migration 0005 效应验证，非 mock）
 * 仅在 TEST_DATABASE_URL（或 DATABASE_URL）提供时运行，否则整体跳过（pre-push 单测不触发）。
 * 覆盖：TX7 FK ON DELETE CASCADE 级联删；TX8 publish_at datetime 越过 2038 往返。
 * 运行：TEST_DATABASE_URL=mysql://dev:dev@localhost:3306/language_flow_test pnpm --filter backend test:integration
 */
import { randomUUID } from "node:crypto";
import type { Connection, RowDataPacket } from "mysql2/promise";
import { createConnection } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface CountRow extends RowDataPacket {
  c: number;
}
interface PublishRow extends RowDataPacket {
  publish_at: Date | null;
}

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const dbSuite = url ? describe : describe.skip;

async function insertContent(conn: Connection, id: string): Promise<void> {
  await conn.execute(
    `INSERT INTO contents (id, template, title, level, target_duration, content, words, style, voice, status, created_at, updated_at)
     VALUES (?, 'scene_word', ?, 'CET4', 60, JSON_ARRAY(), JSON_ARRAY(), JSON_OBJECT(), JSON_OBJECT(), 'content_ready', NOW(), NOW())`,
    [id, `集成测试 ${id}`],
  );
}

async function insertAnalytics(
  conn: Connection,
  contentId: string,
  publishAt: string,
): Promise<void> {
  await conn.execute(
    "INSERT INTO video_analytics (content_id, story_topic, publish_at, allow_save, created_at, updated_at) VALUES (?, ?, ?, 1, NOW(), NOW())",
    [contentId, "t", publishAt],
  );
}

async function countAnalytics(conn: Connection, contentId: string): Promise<number> {
  const [rows] = await conn.execute<CountRow[]>(
    "SELECT COUNT(*) AS c FROM video_analytics WHERE content_id = ?",
    [contentId],
  );
  return rows[0]?.c ?? 0;
}

dbSuite("video_analytics migration 0005（真实 MySQL）", () => {
  let conn: Connection;
  const made: string[] = [];

  beforeAll(async () => {
    if (!url) return;
    conn = await createConnection(url);
  });

  afterAll(async () => {
    for (const id of made) {
      await conn.execute("DELETE FROM video_analytics WHERE content_id = ?", [id]).catch(() => {});
      await conn.execute("DELETE FROM contents WHERE id = ?", [id]).catch(() => {});
    }
    await conn?.end();
  });

  it("TX7：删除 content 级联删除其 video_analytics 行", async () => {
    const id = `it_${randomUUID().slice(0, 20)}`;
    made.push(id);
    await insertContent(conn, id);
    await insertAnalytics(conn, id, "2026-09-20 12:00:00");
    expect(await countAnalytics(conn, id)).toBe(1);
    await conn.execute("DELETE FROM contents WHERE id = ?", [id]);
    expect(await countAnalytics(conn, id)).toBe(0); // 级联生效：孤儿不残留（F4）
  });

  it("TX8：publish_at datetime 支持越过 2038 的时间并原样读回", async () => {
    const id = `it_${randomUUID().slice(0, 20)}`;
    made.push(id);
    await insertContent(conn, id);
    await insertAnalytics(conn, id, "2040-01-02 03:04:05"); // 超 timestamp 2038 上限（F5）
    const [rows] = await conn.execute<PublishRow[]>(
      "SELECT publish_at FROM video_analytics WHERE content_id = ?",
      [id],
    );
    const stored = rows[0]?.publish_at;
    expect(stored).toBeInstanceOf(Date);
    expect(stored?.getFullYear()).toBe(2040);
  });
});
