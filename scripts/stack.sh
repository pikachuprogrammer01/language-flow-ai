#!/usr/bin/env bash
# 三轨环境切换（2026-09-21 版本双轨重构）：本地 dev / Docker 测试栈 / Docker 生产栈互不干扰
# 环境语义：
#   pnpm dev             本地开发 = 测试数据源（测试栈 MySQL :3307 + 测试 uploads，独占 5173/8080）
#                        —— 不再停生产栈：生产跑 deploy/prod.env 锁定的固定 tag，与工作树无关
#   pnpm docker:test     Docker 测试栈（:5174）：每次 --build，代码 = 当前工作树
#   pnpm docker:up       生产栈（:15173）：只启动已有 tag 镜像，不构建（开发期间可 7×24 常驻）
#   pnpm docker:release  发布：工作树 → 构建 → 打 v<git SHA> tag → 改 APP_VERSION → 滚动启动
#   pnpm docker:rollback 回滚：APP_VERSION 改回旧 tag 并重启（数据层不动）
#   pnpm docker:version  三轨当前版本/镜像/构建时间一览
# 用法：
#   scripts/stack.sh dev                # 释放本仓 dev 端口 → 拉起测试栈 MySQL → pnpm 前后端
#   scripts/stack.sh docker             # 校准生产 MySQL → compose up -d（用现有 tag）
#   scripts/stack.sh release [ver]      # 发布当前工作树为生产版本（默认 tag = v<git SHA>）
#   scripts/stack.sh rollback <ver>     # 回滚到已存在的 tag
#   scripts/stack.sh version            # 版本一览
#   scripts/stack.sh mysql              # 仅保证生产 MySQL 健康且在 compose 网络上
#   scripts/stack.sh stop               # 停生产 backend/frontend + 释放本仓 dev 端口（MySQL 保留）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

COMPOSE_NET="${COMPOSE_NET:-language-flow-ai_default}"
MYSQL_NAME="language-flow-mysql"
TEST_COMPOSE_FILE="docker-compose.test.yml"
TEST_MYSQL_NAME="language-flow-test-mysql"
TEST_DB_URL='mysql://dev:dev@localhost:3307/language_flow'
TEST_UPLOADS_DIR="${HOME}/language-flow-uploads-test"
# 生产栈版本/端口参数（compose 插值唯一来源，必须随子命令一起传入）
PROD_ENV_FILE="deploy/prod.env"
# 本地 dev 独占端口（生产栈已挪到 15173，不再参与争抢）
DEV_PORTS=(8080 5173)
PROD_BACKEND_IMAGE="language-flow-ai-backend"
PROD_FRONTEND_IMAGE="language-flow-ai-frontend"

log() { printf '[stack] %s\n' "$*"; }

# 生产栈统一入口：强制带 --env-file，避免裸跑 docker compose 时 APP_VERSION 解为空 tag
prod() { docker compose --env-file "${PROD_ENV_FILE}" -f docker-compose.yml "$@"; }

# 从 deploy/prod.env 读变量（不依赖 shell 已导出）
prod_env_get() {
  local key="$1"
  sed -nE "s/^[[:space:]]*${key}=//p" "${PROD_ENV_FILE}" | tail -1
}

# 改写 deploy/prod.env 里的变量值（仅动 APP_VERSION 一行，保留其余注释）
prod_env_set() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  awk -v k="${key}" -v v="${value}" '
    index($0, k "=") == 1 { print k "=" v; next }
    { print }
  ' "${PROD_ENV_FILE}" > "${tmp}"
  mv "${tmp}" "${PROD_ENV_FILE}"
  log "${PROD_ENV_FILE}: ${key}=${value}"
}

# 释放宿主机 dev 端口：只杀本仓启动的进程（tsx / vite / node）。
# 铁律：绝不 kill OrbStack、docker-proxy 等基础设施进程 —— 它们一旦被杀会连带
# 掉线同机器上其他项目的全部容器。非本仓占用时只报错交人工处理。
free_ports() {
  local p pids pid cmd
  for p in "${DEV_PORTS[@]}"; do
    pids="$(lsof -nP -iTCP:"$p" -sTCP:LISTEN -t 2>/dev/null || true)"
    [[ -z "${pids}" ]] && continue
    for pid in ${pids}; do
      cmd="$(ps -p "${pid}" -o args= 2>/dev/null || true)"
      if [[ "${cmd}" == *"${ROOT}"* ]]; then
        log "释放端口 ${p}（本仓 pid ${pid}）"
        kill "${pid}" 2>/dev/null || true
        sleep 0.4
        kill -9 "${pid}" 2>/dev/null || true
      else
        log "端口 ${p} 被非本仓进程占用（pid ${pid}: ${cmd%% *}）—— 不动它，请人工确认"
      fi
    done
  done
}

stop_compose_app() {
  log "停止生产栈 backend / frontend（保留 mysql）"
  prod stop backend frontend >/dev/null 2>&1 || true
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

# 保证测试栈 MySQL 在跑且健康（本地开发唯一数据源，永不连生产库）
ensure_test_mysql() {
  log "启动测试栈 MySQL（${TEST_COMPOSE_FILE} · :3307）"
  docker compose -f "${TEST_COMPOSE_FILE}" up -d mysql
  local i status="starting"
  for i in $(seq 1 60); do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${TEST_MYSQL_NAME}" 2>/dev/null || echo missing)"
    [[ "${status}" == "healthy" ]] && { log "测试库就绪（healthy）"; return 0; }
    [[ "${status}" == "missing" ]] && { log "错误: 容器 ${TEST_MYSQL_NAME} 不存在（先 pnpm docker:test）"; exit 1; }
    sleep 1
  done
  log "警告: 等待测试库 healthy 超时（当前=${status}），继续尝试"
}

# 保证 language-flow-mysql 在跑、健康，且挂在 compose 默认网络（别名 mysql）——仅生产栈使用
ensure_mysql() {
  stop_conflicting_mysql
  log "启动 / 校准 MySQL（compose up -d mysql）"
  prod up -d mysql
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

# Three.js vendor 构建期产物（npm 依赖 + 拷贝生成，已 gitignore）：缺失时本地渲染片头会失败，故启动前确保生成
ensure_vendor() {
  log "生成 Three.js vendor（copy:vendor）"
  pnpm --filter @ai-english/backend copy:vendor
}

cmd_dev() {
  # 生产栈跑固定 tag 镜像，与本地 dev 端口不重叠（15173 vs 5173），因此不再停生产容器
  free_ports
  # 本地开发 = 测试数据源：测试栈库(:3307) + 测试 uploads（进程 env 优先于 --env-file，.env 保持生产配置不变）
  ensure_test_mysql
  mkdir -p "${TEST_UPLOADS_DIR}/audio" "${TEST_UPLOADS_DIR}/video" "${TEST_UPLOADS_DIR}/bgm" "${TEST_UPLOADS_DIR}/.open-requests"
  export DATABASE_URL="${TEST_DB_URL}"
  export UPLOADS_DIR="${TEST_UPLOADS_DIR}"
  export HOST_UPLOADS_DIR="${TEST_UPLOADS_DIR}"
  ensure_vendor
  log "启动本地 pnpm 前后端（http://localhost:5173 · API :8080 · 数据源=测试库 :3307，非生产）"
  log "生产版本常驻入口：http://localhost:$(prod_env_get PROD_UI_PORT)（tag=$(prod_env_get APP_VERSION)），与本地 dev 互不影响"
  exec pnpm exec concurrently -n be,fe -c blue,green \
    "pnpm --filter backend dev" \
    "pnpm --filter frontend dev"
}

# 构建生产镜像并打版本 tag（不启动）：context = 仓根，与原 compose build 语义一致
cmd_release() {
  local sha ver nocache=() tag
  sha="$(git rev-parse --short=7 HEAD)"
  ver="${1:-v${sha}}"
  if [[ "${NO_CACHE:-0}" == "1" ]]; then nocache=(--no-cache); fi
  if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
    if [[ "${FORCE:-0}" != "1" ]]; then
      log "错误: 工作树有未提交改动，发布镜像无法由 commit 复现。先提交，或确认后用 FORCE=1 重试"
      git status --short | head -20
      exit 1
    fi
    log "FORCE=1 → 忽略脏工作树继续发布（该 tag 不可由 commit ${sha} 精确复现）"
  fi
  ensure_uploads_link
  log "构建生产镜像 ${ver}（backend + frontend，取当前工作树）"
  docker build "${nocache[@]}" -f Dockerfile.backend -t "${PROD_BACKEND_IMAGE}:${ver}" .
  docker build "${nocache[@]}" -f Dockerfile.frontend -t "${PROD_FRONTEND_IMAGE}:${ver}" .
  prod_env_set APP_VERSION "${ver}"
  ensure_mysql
  log "滚动启动生产栈到 ${ver}（数据层：mysql_data 卷 + ${HOME}/language-flow-uploads 不动）"
  prod up -d
  log "发布完成 → http://localhost:$(prod_env_get PROD_UI_PORT)（版本 ${ver}）"
  log "回滚：pnpm docker:rollback <旧 tag>（pnpm docker:version 可查已有 tag）"
}

# 启动生产栈（不构建）：版本 = deploy/prod.env 的 APP_VERSION
cmd_docker() {
  ensure_mysql
  log "启动生产栈（不构建，镜像 tag=$(prod_env_get APP_VERSION)）"
  prod up -d
  log "生产 UI http://localhost:$(prod_env_get PROD_UI_PORT) · 镜像不随工作树变化"
  log "健康检查: curl -sS http://localhost:$(prod_env_get PROD_UI_PORT)/health"
}

# 回滚到已存在的镜像 tag
cmd_rollback() {
  local ver="${1:-}"
  if [[ -z "${ver}" ]]; then
    log "用法: scripts/stack.sh rollback <version>（已存 tag 见 pnpm docker:version）"
    exit 1
  fi
  if ! docker image inspect "${PROD_BACKEND_IMAGE}:${ver}" >/dev/null 2>&1 \
    || ! docker image inspect "${PROD_FRONTEND_IMAGE}:${ver}" >/dev/null 2>&1; then
    log "错误: 本地没有 ${PROD_BACKEND_IMAGE}:${ver} / ${PROD_FRONTEND_IMAGE}:${ver}，无法回滚"
    exit 1
  fi
  prod_env_set APP_VERSION "${ver}"
  ensure_mysql
  prod up -d
  log "已回滚到 ${ver} → http://localhost:$(prod_env_get PROD_UI_PORT)"
}

# 三轨版本一览
cmd_version() {
  log "生产栈 tag=$(prod_env_get APP_VERSION) · UI :$(prod_env_get PROD_UI_PORT)"
  for img in "${PROD_BACKEND_IMAGE}" "${PROD_FRONTEND_IMAGE}"; do
    docker images "${img}" --format '  {{.Repository}}:{{.Tag}}  built={{.CreatedSince}}  size={{.Size}}'
  done
  log "测试栈（代码=当前工作树，每次 --build）"
  docker images 'language-flow-test-*' --format '  {{.Repository}}:{{.Tag}}  built={{.CreatedSince}}'
  log "本地 dev：HEAD=$(git rev-parse --short=7 HEAD) $(git log -1 --format=%s)"
  if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
    log "  工作树有未提交改动（仅影响 dev/测试栈，不影响生产）"
  fi
}

# 无缓存重建并发布（原 docker:rebuild 语义，现归入发布流程）
cmd_rebuild() {
  NO_CACHE=1 cmd_release "${1:-}"
}

# 兼容旧入口 pnpm build：等价于 release（不启动），仅产出带 tag 的镜像
cmd_build() {
  local sha ver
  sha="$(git rev-parse --short=7 HEAD)"
  ver="${1:-v${sha}}"
  ensure_uploads_link
  log "构建并打 tag ${ver}（不切换生产版本，改版本请用 pnpm docker:release）"
  docker build -f Dockerfile.backend -t "${PROD_BACKEND_IMAGE}:${ver}" .
  docker build -f Dockerfile.frontend -t "${PROD_FRONTEND_IMAGE}:${ver}" .
}

cmd_stop() {
  stop_compose_app
  free_ports
  log "已停止生产应用容器与本仓 dev 进程（MySQL 仍运行，需要全停请: scripts/stack.sh 调用 compose down）"
}

cmd_mysql() {
  ensure_mysql
}

case "${1:-}" in
  dev) cmd_dev ;;
  docker) cmd_docker ;;
  release) cmd_release "${2:-}" ;;
  rollback) cmd_rollback "${2:-}" ;;
  version) cmd_version ;;
  rebuild) cmd_rebuild "${2:-}" ;;
  build) cmd_build "${2:-}" ;;
  mysql) cmd_mysql ;;
  stop) cmd_stop ;;
  *)
    cat <<'EOF'
用法: scripts/stack.sh <命令>

  dev       本地开发（测试数据源）：释放本仓 dev 端口 → 拉起测试栈 MySQL(:3307) → pnpm 前后端
  docker    启动生产栈（不构建）：校准生产 MySQL → compose up -d（镜像 = deploy/prod.env 的 APP_VERSION）
  release   发布当前工作树为生产版本：构建 → 打 v<git SHA> tag → 改 APP_VERSION → up -d（脏工作树需 FORCE=1）
  rollback  回滚生产到已存在的镜像 tag
  version   三轨版本/镜像/构建时间一览
  rebuild   无缓存重建并发布（NO_CACHE=1 的 release）
  build     仅构建并打 tag（不切版本、不启动）
  mysql     仅校准生产 MySQL（健康 + 接入 compose 网络）
  stop      停生产 backend/frontend + 释放本仓 dev 端口（保留 MySQL）

推荐 pnpm 入口：
  pnpm dev             → stack.sh dev（本地代码，测试库 :3307，永不碰生产数据）
  pnpm docker:test     → Docker 测试栈（:5174，每次 --build 当前工作树）
  pnpm docker:up       → stack.sh docker（生产老版本常驻，:15173）
  pnpm docker:release  → stack.sh release（你明确要求更新生产时才跑）
  pnpm docker:rollback → stack.sh rollback <tag>
  pnpm docker:version  → stack.sh version
  pnpm docker:stop     → stack.sh stop
EOF
    exit 1
    ;;
esac
