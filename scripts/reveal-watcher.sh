#!/bin/sh
# 监听 ~/language-flow-uploads/.open-requests/ 下的 *.req 标记文件，
# 收到后执行 open -R 在 Finder 中定位视频（配合后端 POST /api/files/reveal）。
# 由 launchd 常驻运行（com.languageflow.reveal-videos.plist，KeepAlive 自动重启）。
# 安装：cp scripts/com.languageflow.reveal-videos.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/com.languageflow.reveal-videos.plist
set -u

REQ_DIR="${HOME}/language-flow-uploads/.open-requests"
mkdir -p "$REQ_DIR"

while true; do
  for req in "$REQ_DIR"/*.req; do
    [ -f "$req" ] || continue
    target="$(cat "$req" 2>/dev/null || true)"
    if [ -n "$target" ] && [ -e "$target" ]; then
      open -R "$target"
      rm -f "$req"
    fi
    # 标记可能正在写入（writeFile 非原子）：内容无效时本轮跳过，下轮重试，避免丢请求
  done
  sleep 1
done
