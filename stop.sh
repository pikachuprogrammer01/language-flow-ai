#!/usr/bin/env bash
# 停止所有开发服务：后端(8080) / 前端(5173) / MySQL 容器 / Ollama(11434)
# 用法：在仓库根目录运行 ./stop.sh
set -u

stop_port() {
  local port="$1" name="$2"
  local pids
  pids=$(lsof -ti ":$port" 2>/dev/null)
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null
    sleep 1
    echo "✅ $name 已停止"
  else
    echo "ℹ️  $name 未在运行"
  fi
}

echo "== 停止开发服务 =="
stop_port 8080 "后端 (:8080)"
stop_port 5173 "前端 (:5173)"
stop_port 11434 "Ollama (:11434)"

echo "== 停止 Docker 容器 =="
if docker stop mysql 2>/dev/null; then
  echo "✅ MySQL 容器已停止（数据保留在 volume）"
else
  echo "ℹ️  MySQL 容器未在运行"
fi

echo ""
echo "🎉 全部服务已停止"
