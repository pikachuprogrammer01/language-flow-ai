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
    /** 生成审计档案（PRD 10.1.4）：输入/候选词/重试历史/修改日志 */
    audit: json("audit"),
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

// ── 视频上传标记表 ──
// 表示某个视频文件已上传到外部平台（一个视频可多条标记，即多个平台）
export const uploadMarks = mysqlTable(
  "upload_marks",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    /** 关联的任务 id（contents 表；重新渲染后文件名变化，标记按任务归属保证一致） */
    taskId: varchar("task_id", { length: 32 }),
    /** 关联的视频文件名（uploads/video/ 下的文件名，如 xxx.mp4） */
    videoFilename: varchar("video_filename", { length: 100 }).notNull(),
    /** 上传平台（前端下拉：抖音/小红书/视频号/B站/快手/其他；存 varchar 不锁死枚举，加平台免迁移） */
    platform: varchar("platform", { length: 50 }).notNull(),
    /** 作品链接（可选） */
    url: varchar("url", { length: 500 }),
    /** 备注（可选） */
    note: varchar("note", { length: 500 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (table) => [
    index("idx_upload_marks_video_filename").on(table.videoFilename),
    index("idx_upload_marks_task_id").on(table.taskId),
  ],
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
