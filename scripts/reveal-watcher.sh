#!/bin/sh
# 监听各 uploads 目录下的 .open-requests/*.req，收到后执行 open -R 在 Finder 中定位视频
# （配合后端 POST /api/files/reveal，见 packages/backend/src/routes/file-manager.ts）。
# 由 launchd 常驻运行（com.languageflow.reveal-videos.plist，KeepAlive 自动重启）。
# 安装：cp scripts/com.languageflow.reveal-videos.plist ~/Library/LaunchAgents/ && launchctl load ~/Library/LaunchAgents/com.languageflow.reveal-videos.plist
# 改动后需 reload 才生效：launchctl unload <plist> && launchctl load <plist>
set -u

# 目标缺失时的宽限期：后端写 req 前已 stat 过文件，仍不存在通常是用户刚删了视频
STALE_AFTER_SEC=60

# 单个 req：文件名 <ts>-<video>.req，内容是宿主机绝对路径（后端按 HOST_UPLOADS_DIR 换算）
handle_req() {
  req="$1"
  target="$(cat "$req" 2>/dev/null || true)"
  # 空内容 = 可能正在写入（writeFile 非原子）：本轮跳过，下轮重试，避免丢请求
  [ -n "$target" ] || return 0
  if [ -e "$target" ]; then
    open -R "$target"
    rm -f "$req"
    return 0
  fi
  # 超时仍未出现才丢弃（mtime 而非 birth time：req 一次写入，且 darwin/Linux 通用）
  now="$(date +%s)"
  mtime="$(stat -f %m "$req" 2>/dev/null || stat -c %Y "$req" 2>/dev/null || echo "$now")"
  [ $((now - mtime)) -ge "$STALE_AFTER_SEC" ] && rm -f "$req"
}

# 三层 uploads 一次覆盖：生产（language-flow-uploads）+ Docker 测试栈与本地 dev（language-flow-uploads-test）。
# glob 前缀加引号，$HOME 含空格也能正确展开；目录不存在时模式保持字面量，由下面的 -f 过滤掉。
while true; do
  for req in "$HOME"/language-flow-uploads*/.open-requests/*.req; do
    [ -f "$req" ] || continue
    handle_req "$req"
  done
  sleep 1
done
