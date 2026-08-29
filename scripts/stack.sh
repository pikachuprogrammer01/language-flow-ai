#!/usr/bin/env bash
# 本地 pnpm dev ↔ Docker 全栈 互斥切换，并保证只用本仓库的 MySQL（language-flow-mysql）
# 用法：
#   scripts/stack.sh dev       # 停容器 backend/frontend → 起 compose mysql → pnpm 前后端
#   scripts/stack.sh build     # 仅构建 Docker 镜像（不启动）
#   scripts/stack.sh docker    # 释放端口 → 校准 MySQL → compose up -d --build
#   scripts/stack.sh rebuild   # 无缓存重建镜像并启动全栈
#   scripts/stack.sh mysql     # 仅保证 MySQL 健康且在 compose 网络上
#   scripts/stack.sh stop      # 停容器 backend/frontend + 释放 8080/5173（MySQL 保留）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

COMPOSE_NET="${COMPOSE_NET:-language-flow-ai_default}"
MYSQL_NAME="language-flow-mysql"
APP_PORTS=(8080 5173)

log() { printf '[stack] %s\n' "$*"; }

# 释放宿主机端口（杀掉监听进程；用于切换模式，避免 502 / bind 失败）
free_ports() {
  local p pids
  for p in "${APP_PORTS[@]}"; do
    pids="$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null || true)"
    if [[ -n "${pids}" ]]; then
      log "释放端口 ${p}（pid: ${pids//$'\n'/ }）"
      # shellcheck disable=SC2086
      kill ${pids} 2>/dev/null || true
      sleep 0.4
      # shellcheck disable=SC2086
      kill -9 ${pids} 2>/dev/null || true
    fi
  done
}

stop_compose_app() {
  log "停止 compose backend / frontend（保留 mysql）"
  docker compose stop backend frontend >/dev/null 2>&1 || true
}

# 停掉抢占 3306、且不是本项目 mysql 的常见冲突容器
stop_conflicting_mysql() {
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'mysql'; then
    log "发现冲突容器「mysql」，正在停止（请统一使用 ${MYSQL_NAME}）"
    docker stop mysql >/dev/null
  fi
}

ensure_uploads_link() {
  local host_dir="${HOME}/language-flow-uploads"
  local link="${ROOT}/packages/backend/uploads"
  mkdir -p "${host_dir}/audio" "${host_dir}/video" "${host_dir}/bgm" "${host_dir}/.open-requests"
  if [[ -L "${link}" ]]; then
    return 0
  fi
  if [[ -e "${link}" ]]; then
    log "警告: ${link} 已存在且不是软链；容器与本地可能看到不同 uploads。建议改为软链到 ${host_dir}"
    return 0
  fi
  ln -sfn "${host_dir}" "${link}"
  log "已创建 uploads 软链 → ${host_dir}"
}

# 保证 language-flow-mysql 在跑、健康，且挂在 compose 默认网络（别名 mysql）
ensure_mysql() {
  stop_conflicting_mysql
  log "启动 / 校准 MySQL（docker compose up -d mysql）"
  docker compose up -d mysql
  # docker start 或异常退出后再起时，偶发未挂回 user-defined 网络 → backend ENOTFOUND
  if ! docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' "${MYSQL_NAME}" 2>/dev/null | grep -q "${COMPOSE_NET}"; then
    log "MySQL 未在网络 ${COMPOSE_NET} 上，正在接入（alias=mysql）"
    docker network connect --alias mysql "${COMPOSE_NET}" "${MYSQL_NAME}" 2>/dev/null \
      || docker network connect "${COMPOSE_NET}" "${MYSQL_NAME}" 2>/dev/null \
      || true
  fi
  local i status="starting"
  for i in $(seq 1 60); do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${MYSQL_NAME}" 2>/dev/null || echo missing)"
    if [[ "${status}" == "healthy" || "${status}" == "running" ]]; then
      if [[ "${status}" == "healthy" ]]; then
        log "MySQL 就绪（healthy）"
        return 0
      fi
    fi
    if [[ "${status}" == "missing" ]]; then
      log "错误: 容器 ${MYSQL_NAME} 不存在"
      exit 1
    fi
    sleep 1
  done
  log "警告: 等待 MySQL healthy 超时（当前状态=${status}），继续尝试"
}

cmd_dev() {
  stop_compose_app
  free_ports
  ensure_mysql
  ensure_uploads_link
  log "启动本地 pnpm 前后端（http://localhost:5173 · API :8080）"
  exec pnpm exec concurrently -n be,fe -c blue,green \
    "pnpm --filter backend dev" \
    "pnpm --filter frontend dev"
}

# 仅构建镜像，不启动（适合预先构建）
cmd_build() {
  ensure_uploads_link
  log "构建 Docker 镜像（backend + frontend，不启动容器）"
  docker compose build
  log "镜像构建完成。启动全栈请执行: pnpm docker:up"
}

# 构建并启动（有缓存）
cmd_docker() {
  free_ports
  ensure_mysql
  ensure_uploads_link
  log "构建并启动 Docker 全栈"
  docker compose up -d --build
  log "前端 http://localhost:5173 · 后端 http://localhost:8080 · MySQL :3306"
  log "健康检查: curl -sS http://localhost:8080/health"
}

# 无缓存重建镜像并启动
cmd_rebuild() {
  free_ports
  ensure_mysql
  ensure_uploads_link
  log "无缓存重建 Docker 镜像…"
  docker compose build --no-cache
  log "启动全栈…"
  docker compose up -d
  log "前端 http://localhost:5173 · 后端 http://localhost:8080"
  log "健康检查: curl -sS http://localhost:8080/health"
}

cmd_stop() {
  stop_compose_app
  free_ports
  log "已停止应用进程/容器（MySQL 仍运行，需要全停请: docker compose down）"
}

cmd_mysql() {
  ensure_mysql
}

case "${1:-}" in
  dev) cmd_dev ;;
  build) cmd_build ;;
  docker) cmd_docker ;;
  rebuild) cmd_rebuild ;;
  mysql) cmd_mysql ;;
  stop) cmd_stop ;;
  *)
    cat <<'EOF'
用法: scripts/stack.sh <命令>

  dev       本地开发：停 Docker 应用容器 → 校准 MySQL → pnpm 前后端
  build     仅构建 Docker 镜像（不启动）
  docker    构建并启动全栈（有缓存）：释放端口 → 校准 MySQL → up --build
  rebuild   无缓存重建镜像并启动全栈
  mysql     仅校准 MySQL（健康 + 接入 compose 网络）
  stop      停 Docker backend/frontend + 释放 8080/5173（保留 MySQL）

推荐 pnpm 入口：
  pnpm build           → stack.sh build
  pnpm docker:up       → stack.sh docker
  pnpm docker:rebuild  → stack.sh rebuild
  pnpm docker:stop     → stack.sh stop
  pnpm dev             → stack.sh dev
EOF
    exit 1
    ;;
esac
