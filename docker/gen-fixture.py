"""生成 Docker 测试栈预置数据 SQL（真实词数 8-12，与生成链路约束一致）"""
import json
import os

words8 = ["flight", "missed", "reschedule", "ticket", "passport", "boarding", "delay", "gate"]
words12 = words8 + ["luggage", "check-in", "customs", "arrival"]
words10 = ["deadline", "project", "meeting", "report", "overtime", "budget", "client", "schedule", "review", "urgent"]


def seg(w):
    return {
        "text": f"This is a generated story sentence using {w} in an everyday context.",
        "words": [{"word": w, "meaning": f"释义-{w}", "level": "CET4"}],
    }


def card(w):
    return {"word": w, "pos": "n.", "meaning": f"释义-{w}", "example": f"The {w} matters today."}


def wl(ws, lvl="CET4"):
    return json.dumps([{"word": w, "meaning": f"释义-{w}", "level": lvl} for w in ws], ensure_ascii=False)


audit1 = {
    "input": {"topic": "机场英语", "level": "CET4", "wordCount": 8, "targetDuration": 60},
    "process": {
        "candidates": [{"source": "bank", "word": w} for w in words12],
        "attempts": [
            {"result": "rejected", "reason": "词超纲"},
            {"result": "accepted", "injectedWords": words8[:4]},
        ],
    },
    "modifications": [{"at": "2026-09-21T01:00:00Z", "fields": ["title"]}],
}
scene_content = [seg(w) for w in words8]
rows = [
    (
        "test0001scene", "scene_word", "测试：机场英语 错过登机", "CET4", 60,
        json.dumps(scene_content, ensure_ascii=False), wl(words8),
        '{"url":"/files/audio/b52537e5-2f1b-4df3-b889-1f61b12ca7bf.mp3","duration":45,"format":"mp3"}',
        '{"url":"/files/video/da40d3dc-4071-4e34-bcb0-4151781021c1.mp4","duration":48,"format":"mp4","introStatus":"rendered"}',
        "completed", json.dumps(audit1, ensure_ascii=False), 10, 5,
    ),
    (
        "test0002wordc", "word_card", "测试：职场高频词 deadline", "CET4", 45,
        json.dumps([card(w) for w in words10[:8]], ensure_ascii=False), wl(words10[:8]),
        "NULL", "NULL", "failed",
        json.dumps({"input": {"topic": "deadline", "level": "CET4"}, "process": {"attempts": [{"result": "rejected", "reason": "词库校验失败"}]}}, ensure_ascii=False),
        30, 2,
    ),
    (
        "test0003quiz0", "quiz", "测试：CET6 易错点", "CET6", 60,
        json.dumps([{"stem": f"Choose the wrong word {i}: ____", "options": ["abandon", "benefit", "capture", "deliver"], "correctIndex": 0, "explanation": "词义辨析题。", "word": {"word": "abandon", "meaning": "放弃", "level": "CET6"}} for i in range(10)], ensure_ascii=False),
        wl(["abandon", "benefit", "capture", "deliver", "essence", "fragile", "generous", "harmony", "instinct", "justice"], "CET6"),
        # 配音就绪无成片：故意不用 video_rendering——渲染链路同步完成、运行时从不落此状态，
        # 预置「渲染中」会永远等不到回写，与当前状态矛盾（2026-09-21 批注修正）
        '{"url":"/files/audio/test3.mp3","duration":30,"format":"mp3"}', "NULL", "audio_ready", "NULL",
        60, 50,
    ),
]


def esc(s):
    return s.replace("\\", "\\\\").replace("'", "\\'")


def q(v):
    """NULL 原样，JSON 串包单引号"""
    return "NULL" if v == "NULL" else f"'{esc(v)}'"


vals = ",\n".join(
    f"('{i}','{t}','{ti}','{lv}',{td},'{esc(c)}','{esc(w)}','{{}}','{{}}',{q(a)},{q(v)},'{st}',{q(au)},NOW() - INTERVAL {d1} MINUTE,NOW() - INTERVAL {d2} MINUTE)"
    for i, t, ti, lv, td, c, w, a, v, st, au, d1, d2 in rows
)
sql = (
    "-- Docker 测试栈预置数据（真实词数 8-12，与生成链路约束一致；仅测试库执行，INSERT IGNORE 幂等）\n"
    "INSERT IGNORE INTO contents (id, template, title, level, target_duration, content, words, style, voice, audio, video, status, audit, created_at, updated_at) VALUES\n"
    + vals
    + ";\n"
)
os.makedirs("docker/test-fixtures", exist_ok=True)
with open("docker/test-fixtures/test-data.sql", "w") as f:
    f.write(sql)
print("fixture written:", len(sql), "bytes")
