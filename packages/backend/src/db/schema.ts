// Drizzle ORM 表定义
// 表结构详见 SPEC.md §十

import {
  float,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";

// ── 视频内容表 ──
export const contents = mysqlTable(
  "contents",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    template: mysqlEnum("template", ["scene_word", "word_card", "quiz"]).notNull(),
    title: varchar("title", { length: 255 }).notNull(),
    level: mysqlEnum("level", ["CET4", "CET6"]).notNull(),
    targetDuration: int("target_duration").notNull(),
    content: json("content").notNull(),
    words: json("words").notNull(),
    style: json("style").notNull(),
    voice: json("voice").notNull(),
    audio: json("audio"),
    video: json("video"),
    status: mysqlEnum("status", [
      "draft",
      "ai_generating",
      "content_ready",
      "tts_processing",
      "audio_ready",
      "video_rendering",
      "completed",
      "failed",
    ])
      .notNull()
      .default("draft"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => [index("idx_status").on(table.status)],
);

// ── 四六级词库表 ──
export const cetWords = mysqlTable(
  "cet_words",
  {
    id: int("id").autoincrement().primaryKey(),
    word: varchar("word", { length: 100 }).notNull(),
    meaning: varchar("meaning", { length: 500 }).notNull(),
    level: mysqlEnum("level", ["CET4", "CET6"]).notNull(),
    frequency: float("frequency").default(0),
  },
  (table) => [index("idx_level_freq").on(table.level, table.frequency)],
);
