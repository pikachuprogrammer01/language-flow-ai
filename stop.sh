#!/usr/bin/env bash
# 停止所有开发服务：后端(8080) / 前端(5173) / Ollama(11434) / MySQL 容器
# 用法：在仓库根目录运行 ./stop.sh
set -u

echo "== 停止开发服务 =="

# 1) 先杀 tsx watch 父进程（防止子进程被杀后自动重启）
if pkill -f "tsx watch" 2>/dev/null; then
  echo "✅ tsx watch（后端守护）已停止"
else
  echo "ℹ️  tsx watch 未在运行"
fi

# 2) 杀 concurrently / pnpm dev 编排进程
if pkill -f "concurrently" 2>/dev/null; then
  echo "✅ pnpm dev 编排进程已停止"
else
  echo "ℹ️  pnpm dev 编排进程未在运行"
fi

# 3) 按端口杀实际监听进程（node / vite / ollama）
for port_name in "8080:后端" "5173:前端" "11434:Ollama"; do
  port="${port_name%%:*}"
  name="${port_name##*:}"
  pids=$(lsof -ti ":$port" 2>/dev/null)
  if [ -n "$pids" ]; then
    kill $pids 2>/dev/null
    sleep 1
    # 兜底：SIGTERM 未退出则强杀
    pids=$(lsof -ti ":$port" 2>/dev/null)
    if [ -n "$pids" ]; then
      kill -9 $pids 2>/dev/null
    fi
    echo "✅ $name (:${port}) 已停止"
  else
    echo "ℹ️  $name (:${port}) 未在运行"
  fi
done

echo "== 停止 Docker 容器 =="
if ! docker info >/dev/null 2>&1; then
  echo "⚠️  Docker daemon 未运行，跳过 MySQL 容器（如已启动请手动 docker stop mysql）"
elif docker stop mysql 2>/dev/null; then
  echo "✅ MySQL 容器已停止（数据保留在 volume）"
else
  echo "ℹ️  MySQL 容器未在运行"
fi

echo ""
echo "🎉 停止流程完成。验证：curl -s localhost:8080/health 应无响应"
