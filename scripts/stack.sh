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

# ── 生产数据备份（docs/21 决策 1-4）────────────────────────────────
# 备份范围必须同时含「库」和「成片」：publish_records.video_asset_id 只存文件名，
# 成片丢了光恢复 DB 救不回来（2026-09-28 那次只能靠读成片截帧反推文案）。
BACKUP_DIR="${BACKUP_DIR:-${HOME}/language-flow-backups}"
BACKUP_KEEP="${BACKUP_KEEP:-10}"
PROD_UPLOADS_DIR="${HOME}/language-flow-uploads"
# 恢复演练专用 schema：建它 → 灌 dump → 与生产比对 → 当场删掉，不留残留；
# 永不等于 language_flow（下方有断言），也不触碰测试栈的业务库。
VERIFY_SCHEMA="lf_infra_verify"

# 对指定实例的指定库跑一条 SQL（-N -B：无表头、tab 分隔，便于机器比对）
# 失败不静默：错误原文要落到日志——否则比对拿到空值会被当成「一致」蒙过去（实测假通过过一次）
sql_on() {
  local container="$1" db="$2" query="$3" err
  err="$(mktemp)"
  if ! docker exec "${container}" mysql -udev -pdev -N -B -D "${db}" -e "${query}" 2>"${err}"; then
    log "  SQL 执行失败（库 ${db}）: $(grep -v 'Using a password' "${err}" | head -2 | tr '\n' ' ')" >&2
    rm -f "${err}"
    return 1
  fi
  rm -f "${err}"
}

# macOS 默认没有 sha256sum，只有 shasum -a 256
sha_tool() {
  if command -v sha256sum >/dev/null 2>&1; then echo "sha256sum"; else echo "shasum -a 256"; fi
}

# 表 -> 业务键表达式。**一律不用自增 id**：重灌夹具后自增 id 整段漂移，
# 按 id 比对会报出「指标全丢」的假警报（2026-10-03 实测踩过）。
backup_key_expr() {
  case "$1" in
    contents) echo "id" ;;
    publish_records) echo "CONCAT_WS('|',platform,IFNULL(platform_video_id,id))" ;;
    upload_marks) echo "CONCAT_WS('|',IFNULL(task_id,'-'),video_filename,platform)" ;;
    video_analytics) echo "content_id" ;;
    video_metrics) echo "CONCAT_WS('|',publish_record_id,metric_name)" ;;
    import_batch) echo "id" ;;
    # row_number 是 MySQL 8 保留字（窗口函数），不加反引号整条 SQL 报 1064
    import_row) echo "CONCAT_WS('|',batch_id,\`row_number\`)" ;;
    cet_words) echo "CONCAT_WS('|',word,level)" ;;
    *) echo "" ;;
  esac
}

BACKUP_CHECK_TABLES=(contents publish_records upload_marks video_analytics video_metrics import_batch import_row cet_words)

# 备份必须演一次真恢复：不看文件大小、不看「dump 退出码 0」就宣称备份成功不算数
cmd_backup_verify() {
  local src_dir="${1:-}" dump rc=0
  if [[ -z "${src_dir}" ]]; then
    src_dir="$(find "${BACKUP_DIR}" -maxdepth 1 -type d -name '2*' 2>/dev/null | sort | tail -1)"
  fi
  src_dir="${src_dir%/}"
  if [[ -z "${src_dir}" || ! -d "${src_dir}" ]]; then
    log "错误: 没有找到备份目录（先 pnpm docker:backup）"
    return 1
  fi
  dump="${src_dir}/language_flow.sql.gz"
  [[ -f "${dump}" ]] || { log "错误: 缺 dump 文件 ${dump}"; return 1; }
  [[ "${VERIFY_SCHEMA}" == "language_flow" || "${VERIFY_SCHEMA}" == "" ]] && {
    log "错误: VERIFY_SCHEMA 不能是业务库，拒绝执行"; return 1; }

  log "恢复演练对象: ${src_dir}"
  if ( cd "${src_dir}" && $(sha_tool) -c "$(basename "${dump}").sha256" ) >/dev/null 2>&1; then
    log "  完整性校验: OK（$(du -h "${dump}" | cut -f1)）"
  else
    log "  错误: 备份包 sha256 校验不通过，文件可能已损坏或被截断"
    return 1
  fi

  log "  灌入测试实例的临时 schema \`${VERIFY_SCHEMA}\`（不触碰 language_flow）"
  docker exec "${TEST_MYSQL_NAME}" mysql -uroot -proot -e \
    "DROP DATABASE IF EXISTS \`${VERIFY_SCHEMA}\`; CREATE DATABASE \`${VERIFY_SCHEMA}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; GRANT ALL PRIVILEGES ON \`${VERIFY_SCHEMA}\`.* TO 'dev'@'%'; FLUSH PRIVILEGES;" 2>/dev/null \
    || { log "  错误: 临时 schema 创建失败"; return 1; }
  if ! gunzip -c "${dump}" | docker exec -i "${TEST_MYSQL_NAME}" mysql -udev -pdev "${VERIFY_SCHEMA}" 2>/tmp/lf_restore_err.txt; then
    log "  错误: dump 回放失败"
    sed 's/^/      /' /tmp/lf_restore_err.txt | head -10 || true
    docker exec "${TEST_MYSQL_NAME}" mysql -uroot -proot -e "DROP DATABASE IF EXISTS \`${VERIFY_SCHEMA}\`;" 2>/dev/null || true
    return 1
  fi

  log "  与生产逐表按业务键对账（生产只读）"
  printf '  %-20s %10s %10s %-14s %s\n' "表" "生产行数" "恢复行数" "键校验和" "判定"
  local t expr pc psum bc bsum verdict q p_out b_out
  for t in "${BACKUP_CHECK_TABLES[@]}"; do
    expr="$(backup_key_expr "${t}")"
    [[ -z "${expr}" ]] && { log "  跳过 ${t}（未登记业务键）"; continue; }
    q="SELECT COUNT(*), COALESCE(SUM(CRC32(${expr})),0) FROM \`${t}\`"
    verdict="一致"
    p_out="$(sql_on "${MYSQL_NAME}" language_flow "${q}")" || { verdict="生产侧查询失败"; rc=1; }
    b_out="$(sql_on "${TEST_MYSQL_NAME}" "${VERIFY_SCHEMA}" "${q}")" || { verdict="恢复侧查询失败"; rc=1; }
    read -r pc psum <<<"${p_out}"
    read -r bc bsum <<<"${b_out}"
    # 空值/非数字必须算红灯：上一版假通过就是「SQL 报错 → 拿到空 → 空==空 → 判一致」
    if [[ "${verdict}" == "一致" && ( ! "${pc:-}" =~ ^[0-9]+$ || ! "${bc:-}" =~ ^[0-9]+$ ) ]]; then
      verdict="结果不可解析"; rc=1
    elif [[ "${verdict}" == "一致" && "${pc}" != "${bc}" ]]; then
      verdict="行数差异（差 $(( bc - pc )) 行）"; rc=1
    elif [[ "${verdict}" == "一致" && "${psum}" != "${bsum}" ]]; then
      verdict="键集合差异"; rc=1
    fi
    printf '  %-20s %10s %10s %-14s %s\n' "${t}" "${pc:-?}" "${bc:-?}" "${psum:-?}/${bsum:-?}" "${verdict}"
  done

  docker exec "${TEST_MYSQL_NAME}" mysql -uroot -proot -e "DROP DATABASE IF EXISTS \`${VERIFY_SCHEMA}\`;" 2>/dev/null || true
  if [[ "${rc}" -eq 0 ]]; then
    log "  清理完成: 临时 schema 已 DROP，全部表可对账且键集合一致 → 这份备份确实能恢复回去"
  else
    log "  清理完成: 临时 schema 已 DROP，但存在差异 —— 备份不可信，禁止在其上发布"
  fi
  return "${rc}"
}

cmd_backup() {
  local ts sha dir rc=0
  ensure_mysql
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  sha="$(git -C "${ROOT}" rev-parse --short=7 HEAD 2>/dev/null || echo nogit)"
  dir="${BACKUP_DIR}/${ts}-${sha}"
  # set -e 在 `cmd_backup || ...` 这种上下文里是失效的，关键步骤必须显式判失败——
  # 实测：BACKUP_DIR 被占成文件时 mkdir 失败却继续往下跑，直到重定向才炸出难懂的报错
  mkdir -p "${dir}" || { log "错误: 无法创建备份目录 ${dir}（检查 BACKUP_DIR 路径）"; return 1; }
  log "备份目录 ${dir}"

  log "① 导出生产库（只读；--single-transaction 不锁表，生产容器不停）"
  # --no-tablespaces 必需：MySQL 8.0.21+ 默认导出表空间信息，而 dev 用户无 PROCESS 权限，
  # 会报 Access denied 且退出码非 0（数据段其实已写完，别以为成功了）
  if docker exec "${MYSQL_NAME}" mysqldump -udev -pdev --single-transaction --no-tablespaces \
      --set-gtid-purged=OFF --routines --triggers --default-character-set=utf8mb4 language_flow \
      | gzip > "${dir}/language_flow.sql.gz"; then
    log "  dump 完成: $(du -h "${dir}/language_flow.sql.gz" | cut -f1)"
  else
    rc=$?
    log "  错误: mysqldump 失败（退出码 ${rc}），备份中止 —— 不带成功的备份不许发布"
    return 1
  fi
  ( cd "${dir}" && $(sha_tool) "language_flow.sql.gz" > "language_flow.sql.gz.sha256" ) \
    || { log "  错误: 校验和写入失败"; return 1; }

  log "② 成片目录快照（rsync --link-dest 硬链接增量：10 份实际占用 ≈ 1 份 + 变更量）"
  if [[ -d "${PROD_UPLOADS_DIR}" ]]; then
    local latest="" linkargs=() before="" after=""
    # `|| true` 必需：首份备份时 grep 无匹配返回 1，pipefail + set -e 会在这里静默中止整个脚本
    latest="$( { find "${BACKUP_DIR}" -maxdepth 1 -type d -name '2*' 2>/dev/null | grep -v -F "${dir}" | sort | tail -1; } || true )"
    [[ -n "${latest}" && -d "${latest}/uploads" ]] && linkargs=(--link-dest="${latest}/uploads")
    before="$(du -sh "${BACKUP_DIR}" | cut -f1)"
    # 成片按相对路径被 DB 引用，保留目录结构与权限；不跟随外部软链
    rsync -a ${linkargs[@]+"${linkargs[@]}"} "${PROD_UPLOADS_DIR}/" "${dir}/uploads/" >/dev/null \
      || { log "  错误: 成片快照失败"; return 1; }
    after="$(du -sh "${BACKUP_DIR}" | cut -f1)"
    log "  成片快照完成（硬链接参照: ${latest:-无，本次为首份全量}）；备份根目录占用 ${before} → ${after}"
  else
    log "  警告: 未找到 ${PROD_UPLOADS_DIR}，本次只备份了库（成片未备份）"
  fi

  log "③ 保留策略：只留最近 ${BACKUP_KEEP} 份"
  local snaps=() line="" i=0
  while IFS= read -r line; do [[ -n "${line}" ]] && snaps+=("${line}"); done \
    < <(find "${BACKUP_DIR}" -maxdepth 1 -type d -name '2*' 2>/dev/null | sort -r)
  if [[ ${#snaps[@]} -gt ${BACKUP_KEEP} ]]; then
    for (( i = BACKUP_KEEP; i < ${#snaps[@]}; i++ )); do
      # 只删本命令自产、命名形如 <UTC时间戳>-<git sha> 的目录；不做任何全局 prune
      log "  删除超期备份: ${snaps[$i]}（$(du -sh "${snaps[$i]}" | cut -f1)）"
      rm -rf "${snaps[$i]}"
    done
  else
    log "  未超出保留数（当前 ${#snaps[@]} 份），无需裁剪"
  fi

  log "④ 恢复演练（备份不演一次恢复不算备份）"
  cmd_backup_verify "${dir}" || { log "  错误: 恢复演练未通过"; return 1; }
  log "备份完成 → ${dir}（库 $(du -h "${dir}/language_flow.sql.gz" | cut -f1) + 成片快照）"
}

# 「第 N 集」的 N 既写作阿拉伯数字也写作中文数字（生产实况：第七集 / 第36集 并存）。
# 只认阿拉伯数字会把「第七集」CAST 成 0，凭空造出「第 1~9 集缺失」的假警报——
# 而编号正是产品负责人定位一集的入口，不能因为难解析就静默跳过。
cn_digit() {
  case "$1" in
    一) echo 1 ;; 二) echo 2 ;; 三) echo 3 ;; 四) echo 4 ;; 五) echo 5 ;;
    六) echo 6 ;; 七) echo 7 ;; 八) echo 8 ;; 九) echo 9 ;; *) echo "" ;;
  esac
}

# 阿拉伯数字直接取用；中文数字支持 1~99（十、十一、二十、三十五）；解析不了返回空
cn2num() {
  local s="$1" t o
  [[ "$s" =~ ^[0-9]+$ ]] && { echo "${s}"; return; }
  if [[ "$s" == *十* ]]; then
    t="${s%%十*}"; o="${s##*十}"
    [[ -z "${t}" ]] && t=1 || t="$(cn_digit "${t}")"
    [[ -z "${o}" ]] && o=0 || o="$(cn_digit "${o}")"
    [[ -n "${t}" && -n "${o}" ]] && echo $(( t * 10 + o )) || echo ""
  else
    cn_digit "${s}"
  fi
}

# ── 生产数据只读对账（docs/21 决策 8）─────────────────────────────
# 全程 SELECT + 文件系统存在性检查，不持有任何写路径。会话级 READ ONLY 是第二道保险。
# 存在的理由：测试库全绿但生产已经飘了，是最坏的一种假绿灯。
# 输出纪律：无漂移要说清「未发现漂移，未做任何修改」并且退出码 0，不得把无事可做报成失败。
cmd_audit() {
  local drift=0 missing_files=0
  # 可对账任意实例/库/uploads 目录：默认生产（只读），也可指向一份恢复出来的副本做演练
  local inst="${AUDIT_CONTAINER:-${MYSQL_NAME}}"
  local db_name="${AUDIT_DB:-language_flow}"
  local uploads="${AUDIT_UPLOADS_DIR:-${PROD_UPLOADS_DIR}}"
  log "只读对账（容器 ${inst} · 库 ${db_name} · uploads ${uploads}）"

  # 每条查询都先设 READ ONLY：本命令任何 SQL 都不该能写
  local ro="SET SESSION TRANSACTION READ ONLY;"

  # 1) 集数序列断号：note 里的「第 N 集」是产品负责人定位一集的主要入口，
  #    断号既是丢数据最直观的物理证据，也是他「看不看得见」的判断依据
  local notes seq="" unparsed="" raw="" mid="" num="" prev="" gap_list="" gaps=0
  notes="$(docker exec "${inst}" mysql -udev -pdev -N -B --default-character-set=utf8mb4 -D "${db_name}" -e \
    "${ro} SELECT DISTINCT note FROM upload_marks WHERE note LIKE '%第%集%' ORDER BY 1" 2>/dev/null | tr -d '\r')"
  while IFS= read -r raw; do
    [[ -z "${raw}" ]] && continue
    mid="${raw##*第}"; mid="${mid%%集*}"
    num="$(cn2num "${mid}")"
    if [[ -n "${num}" ]]; then
      seq+="${num}"$'\n'
    else
      unparsed+="  · ${raw}"$'\n'
    fi
  done <<<"${notes}"
  seq="$(printf '%s' "${seq}" | grep -E '^[0-9]+$' | sort -n | uniq)"
  if [[ -n "${seq}" ]]; then
    while IFS= read -r num; do
      [[ "${num}" =~ ^[0-9]+$ ]] || continue
      if [[ -n "${prev}" && $(( num - prev )) -gt 1 ]]; then
        gaps=$(( gaps + num - prev - 1 ))
        gap_list+=" $(( prev + 1 ))..$(( num - 1 ))"
      fi
      prev="${num}"
    done <<<"${seq}"
    if [[ "${gaps}" -gt 0 ]]; then
      log "  ✗ 集数断号：已登记到第 ${prev} 集，中间缺 ${gaps} 集 →${gap_list}"
      drift=1
    else
      log "  ✓ 集数序列连续（共 ${prev} 集，无断号）"
    fi
  else
    log "  · 没有带集数编号的标记（note 形如「情景英语四级词汇-第 N 集」），未做断号核对"
  fi
  if [[ -n "${unparsed}" ]]; then
    log "  ! 以下标记的编号解析不出来，未纳入断号核对（宁可显式承认盲区，不静默跳过）："
    printf '%s\n' "${unparsed}"
  fi

  # 2) 标记⇒发布记录：有归属任务的标记必须能派生出对应发布记录，否则该集从分析里静默消失
  local orphan_marks
  orphan_marks="$(docker exec "${inst}" mysql -udev -pdev -N -B --default-character-set=utf8mb4 -D "${db_name}" -e \
    "${ro} SELECT COUNT(*) FROM upload_marks m WHERE m.task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM publish_records p WHERE p.content_id = m.task_id AND p.platform = m.platform)" 2>/dev/null | tr -d '\r')"
  if [[ "${orphan_marks:-0}" == "0" ]]; then
    log "  ✓ 已绑定生成记录的上传标记全部派生出发布记录（0 条缺口）"
  else
    log "  ✗ ${orphan_marks} 条标记有归属却没有发布记录（这些集会从数据分析里消失）"
    drift=1
  fi

  # 3) 成片存在性：video_asset_id 只存文件名，文件丢了 DB 恢复也指回空路径
  local assets f asset_count
  assets="$(docker exec "${inst}" mysql -udev -pdev -N -B --default-character-set=utf8mb4 -D "${db_name}" -e \
    "${ro} SELECT DISTINCT video_asset_id FROM publish_records WHERE video_asset_id IS NOT NULL AND video_asset_id <> ''" 2>/dev/null | tr -d '\r')"
  asset_count="$(grep -c . <<<"${assets}")"
  while IFS= read -r f; do
    [[ -z "${f}" ]] && continue
    [[ -e "${uploads}/video/${f}" ]] || missing_files=$(( missing_files + 1 ))
  done <<<"${assets}"
  if [[ "${missing_files}" -eq 0 ]]; then
    log "  ✓ 发布记录指向的成片文件全部存在（共 ${asset_count} 个资产引用）"
  else
    log "  ✗ ${missing_files} 个成片文件在 ${uploads}/video 下找不到（指标还在，视频已丢）"
    drift=1
  fi

  # 4) 孤儿发布记录：FK 本该保证为 0，非 0 说明有人绕过应用直改过库
  local orphan_pr
  orphan_pr="$(docker exec "${inst}" mysql -udev -pdev -N -B --default-character-set=utf8mb4 -D "${db_name}" -e \
    "${ro} SELECT COUNT(*) FROM publish_records p LEFT JOIN contents c ON c.id = p.content_id WHERE c.id IS NULL" 2>/dev/null | tr -d '\r')"
  if [[ "${orphan_pr:-0}" == "0" ]]; then
    log "  ✓ 无孤儿发布记录（content_id 全部指向存在的内容）"
  else
    log "  ✗ ${orphan_pr} 条发布记录的 content_id 指向不存在的内容"
    drift=1
  fi

  # 5) 总量底账：给一行前后对账用的基准数（发布记录数 + 最后一次写入时间 = 「生产未变」的证据）
  docker exec "${inst}" mysql -udev -pdev -N -B --default-character-set=utf8mb4 -D "${db_name}" -e \
    "${ro} SELECT CONCAT('  · 底账 contents=', (SELECT COUNT(*) FROM contents),
      ' publish_records=', (SELECT COUNT(*) FROM publish_records),
      ' upload_marks=', (SELECT COUNT(*) FROM upload_marks),
      ' video_metrics=', (SELECT COUNT(*) FROM video_metrics),
      ' 最后写入 MAX(updated_at)=', IFNULL((SELECT MAX(updated_at) FROM contents),'NULL'))" 2>/dev/null

  if [[ "${drift}" -eq 0 ]]; then
    log "对账结论：未发现漂移，未做任何修改（全程只读）"
    return 0
  fi
  log "对账结论：发现漂移项（上方 ✗ 标记），本命令未做任何修改"
  return 1
}

# ── 发布质量门禁（docs/21 决策 5-6、9-10）────────────────────────
# 跑一步、失败就打印该步输出末段并记账；任一步红则不切 APP_VERSION。
# 放这里而不是 pre-push：风险发生在切生产版本那一刻，日常提交不该被分钟级检查拖住。
gate_run() {
  local label="$1"; shift
  local out="" rc=0 attempt
  for attempt in 1 2; do
    if out="$("$@" 2>&1)"; then
      log "${label} … 通过"
      return 0
    fi
    rc=$?
    # 并行会话抢 CPU 时含真实超时的用例（如文件管理 reveal）会偶发红：重试一次，仍红才算红
    [[ "${attempt}" == "1" ]] && log "${label} … 第 1 次失败，重试一次（并行会话偶发抢 CPU）"
  done
  log "${label} … 失败（退出码 ${rc}）"
  printf '%s\n' "${out}" | tail -15 | sed 's/^/      /'
  return "${rc}"
}

# E2E 必须打在新鲜产物上：镜像落后工作树时，同一份代码能测出完全相反的结论
# （本轮就发生过：旧镜像 9 红 vs 重建后 22 passed / 1 skipped）。
# 次序固定为 重建 → 重灌夹具 → 再跑：数据修复脚本会删 test% 行，次序反了用例必挂。
gate_e2e() {
  pnpm docker:test >/dev/null 2>&1 || { log "  E2E 前置：测试栈重建失败"; return 1; }
  pnpm docker:test:seed >/dev/null 2>&1 || { log "  E2E 前置：夹具重灌失败"; return 1; }
  E2E_BASE_URL="http://127.0.0.1:5174" pnpm e2e
}

cmd_gate() {
  local fails=()
  log "质量门禁（7 步；任一步红则 cmd_release 不切 APP_VERSION）"
  gate_run "1/7 全仓类型检查" pnpm typecheck || fails+=("类型检查")
  gate_run "2/7 单元测试" pnpm -r test || fails+=("单元测试")
  gate_run "3/7 覆盖率水位" pnpm coverage || fails+=("覆盖率")
  gate_run "4/7 真库不变量（测试库 :3307）" pnpm --filter @ai-english/backend test:invariants \
    || fails+=("真库不变量")
  gate_run "5/7 API 契约与文档覆盖" pnpm openapi:check || fails+=("API 契约")
  gate_run "6/7 E2E（重建测试栈 + 重灌夹具后整套默认套件）" gate_e2e || fails+=("E2E")
  gate_run "7/7 生产只读对账" cmd_audit || fails+=("生产只读对账")
  if [[ ${#fails[@]} -gt 0 ]]; then
    log "门禁结论：未通过 → ${fails[*]}"
    return 1
  fi
  log "门禁结论：7 步全绿"
  return 0
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
  # 备份不可跳：跳过它省的是 20 秒，代价是丢掉唯一回滚路径——代码能回滚，数据不能
  local prev_ver
  prev_ver="$(prod_env_get APP_VERSION)"
  cmd_backup || { log "错误: 备份失败或恢复演练未通过 —— 拒绝发布（生产保持 ${prev_ver}）"; exit 1; }
  if [[ "${GATE_SKIP:-0}" == "1" ]]; then
    log "警告: GATE_SKIP=1 → 跳过 7 步质量门禁（备份没有被跳过；本次发布未经完整验证）"
  else
    cmd_gate || { log "错误: 质量门禁未通过 —— 未构建、未切版本，生产保持 ${prev_ver}"; exit 1; }
  fi
  ensure_uploads_link
  log "构建生产镜像 ${ver}（backend + frontend，取当前工作树）"
  docker build ${nocache[@]+"${nocache[@]}"} -f Dockerfile.backend -t "${PROD_BACKEND_IMAGE}:${ver}" .
  docker build ${nocache[@]+"${nocache[@]}"} -f Dockerfile.frontend -t "${PROD_FRONTEND_IMAGE}:${ver}" .
  prod_env_set APP_VERSION "${ver}"
  ensure_mysql
  log "滚动启动生产栈到 ${ver}（数据层：mysql_data 卷 + ${HOME}/language-flow-uploads 不动）"
  prod up -d
  local port ok=0 i
  port="$(prod_env_get PROD_UI_PORT)"
  for i in $(seq 1 30); do
    curl -fsS --max-time 3 "http://localhost:${port}/health" >/dev/null 2>&1 && { ok=1; break; }
    sleep 2
  done
  if [[ "${ok}" -eq 1 ]]; then
    log "发布后健康检查通过（:${port}/health）"
    log "发布完成 → http://localhost:${port}（版本 ${ver}；上一版 ${prev_ver}）"
  else
    log "错误: 生产 UI 60 秒内未通过健康检查。版本已切到 ${ver}（上一版 ${prev_ver}），镜像与数据都还在"
    log "  确认要退回去就执行：pnpm docker:rollback ${prev_ver}"
    log "  （不自动回滚：重启生产容器属于需要你点头的动作）"
    exit 1
  fi
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
  backup) cmd_backup ;;
  backup:verify) cmd_backup_verify "${2:-}" ;;
  audit) cmd_audit ;;
  gate) cmd_gate ;;
  stop) cmd_stop ;;
  *)
    cat <<'EOF'
用法: scripts/stack.sh <命令>

  dev       本地开发（测试数据源）：释放本仓 dev 端口 → 拉起测试栈 MySQL(:3307) → pnpm 前后端
  docker    启动生产栈（不构建）：校准生产 MySQL → compose up -d（镜像 = deploy/prod.env 的 APP_VERSION）
  release   发布当前工作树为生产版本：备份 + 7 步质量门禁 → 构建 → 打 v<git SHA> tag → 改 APP_VERSION → up -d → 健康检查
            （脏工作树需 FORCE=1；质量段可用 GATE_SKIP=1 显式跳过，备份段不可跳）
  rollback  回滚生产到已存在的镜像 tag
  version   三轨版本/镜像/构建时间一览
  rebuild   无缓存重建并发布（NO_CACHE=1 的 release）
  build     仅构建并打 tag（不切版本、不启动）
  mysql     仅校准生产 MySQL（健康 + 接入 compose 网络）
  backup    备份生产数据：库 dump（只读、不锁表）+ 成片硬链接快照 + 校验和 + 保留 10 份，
            末尾自动演一次真恢复（灌临时 schema、按业务键与生产对账、当场清理）
  backup:verify [目录]   只对最近一次（或指定）备份做恢复演练，不产生新备份
  audit     生产数据只读对账（集数断号 / 标记未派生 / 成片缺失 / 孤儿发布记录），零写入
  gate      只跑 7 步质量门禁（类型/单测/覆盖率/真库不变量/API 契约/E2E/生产对账），不发布
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
