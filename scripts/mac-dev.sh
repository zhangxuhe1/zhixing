#!/usr/bin/env bash
# 启动完整的 Mac Catalyst Debug 环境：Postgres、MinIO、开发 API 和 App。
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
API_DIR="$ROOT/apps/api"
IOS_DIR="$ROOT/apps/ios"
DERIVED_DATA="$IOS_DIR/DerivedData/mac-dev"
APP="$DERIVED_DATA/Build/Products/Debug-maccatalyst/Zhixing.app"
APP_EXECUTABLE="$APP/Contents/MacOS/Zhixing"
API_PORT=8787
API_BASE_URL="http://localhost:$API_PORT"
API_HEALTH_URL="$API_BASE_URL/health"
API_RUNTIME_DIR="/tmp/zhixing-mac-dev-$(id -u)"
API_LOG="$API_RUNTIME_DIR/api-dev.log"
API_ERROR_LOG="$API_RUNTIME_DIR/api-dev-error.log"
API_JOB_LABEL="app.zhixing.api-dev"
API_RUNNER_VERSION=2
NODE_BIN=$(node -p 'process.execPath' 2>/dev/null || true)
TSX_CLI="$API_DIR/node_modules/tsx/dist/cli.mjs"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "❌ 缺少命令：$1" >&2
    exit 1
  fi
}

wait_for_command() {
  local label="$1"
  local attempts="$2"
  shift 2

  for ((i = 1; i <= attempts; i++)); do
    if "$@" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "❌ 等待${label}超时。" >&2
  return 1
}

process_cwd() {
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'
}

api_is_ready() {
  local dev_auth_status=""
  local data_status=""

  curl --silent --fail --max-time 2 "$API_HEALTH_URL" >/dev/null || return 1

  dev_auth_status=$(curl --silent --output /dev/null --write-out '%{http_code}' \
    --max-time 2 --request POST "$API_BASE_URL/auth/dev" \
    --header 'content-type: application/json' --data '{}') || return 1
  [[ "$dev_auth_status" == "400" ]] || return 1

  data_status=$(curl --silent --output /dev/null --write-out '%{http_code}' \
    --max-time 5 "$API_BASE_URL/places/pins") || return 1
  [[ "$data_status" == "200" ]]
}

managed_api_needs_upgrade() {
  local job_detail=""

  job_detail=$(launchctl print "gui/$(id -u)/$API_JOB_LABEL" 2>/dev/null) || return 1
  [[ "$job_detail" != *"ZHIXING_DEV_RUNNER_VERSION=$API_RUNNER_VERSION"* ]]
}

wait_for_api_port_release() {
  for _ in {1..50}; do
    if ! lsof -nP -tiTCP:"$API_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done

  echo "❌ 本地 API 未能释放 ${API_PORT} 端口。" >&2
  return 1
}

stop_managed_api() {
  local pid=""
  local cwd=""

  if launchctl print "gui/$(id -u)/$API_JOB_LABEL" >/dev/null 2>&1; then
    echo "⏹  正在退出上次由脚本托管的本地 API…"
    # remove 在任务已开始退出时偶尔仍返回非零；后续以端口释放检查为准。
    launchctl remove "$API_JOB_LABEL" >/dev/null 2>&1 || true
    for _ in {1..50}; do
      if ! launchctl print "gui/$(id -u)/$API_JOB_LABEL" >/dev/null 2>&1; then
        break
      fi
      sleep 0.1
    done
    if launchctl print "gui/$(id -u)/$API_JOB_LABEL" >/dev/null 2>&1; then
      echo "❌ 本地 API 的 launchctl 任务未能卸载。" >&2
      exit 1
    fi
  fi

  # 兼容本脚本早期版本留下的 pid 文件；新版本统一交给 launchctl 托管。
  local legacy_pid_file="$DERIVED_DATA/api-dev.pid"
  if [[ -f "$legacy_pid_file" ]]; then
    pid=$(tr -d '[:space:]' < "$legacy_pid_file")
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
      cwd=$(process_cwd "$pid")
      if [[ "$cwd" == "$API_DIR" ]]; then
        echo "⏹  正在退出旧版脚本启动的本地 API…"
        kill -TERM "$pid"
        for _ in {1..30}; do
          if ! kill -0 "$pid" 2>/dev/null; then
            break
          fi
          sleep 0.1
        done
      fi
    fi
    rm -f "$legacy_pid_file"
  fi

  return 0
}

stop_api_on_port() {
  local listener_pids=""
  local pid=""
  local cwd=""
  local pgid=""
  local leader_command=""

  listener_pids=$(lsof -nP -tiTCP:"$API_PORT" -sTCP:LISTEN 2>/dev/null || true)
  [[ -z "$listener_pids" ]] && return 0

  for pid in $listener_pids; do
    cwd=$(process_cwd "$pid")
    if [[ "$cwd" != "$API_DIR" ]]; then
      echo "❌ ${API_PORT} 端口被其他进程占用（PID ${pid}，目录：${cwd:-未知}），为避免误关进程已停止。" >&2
      exit 1
    fi

    echo "⏹  正在重启已有的知行本地 API（PID ${pid}）…"
    pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d '[:space:]')
    leader_command=""
    if [[ "$pgid" =~ ^[0-9]+$ ]]; then
      leader_command=$(ps -o command= -p "$pgid" 2>/dev/null || true)
    fi

    # 兼容以前由 `pnpm ... dev` 启动的 tsx watch 进程：只在进程组领头命令
    # 明确属于本仓库 API 时终止整组，防止 watcher 立即拉起旧服务。
    if [[ "$leader_command" == *"pnpm --filter @zhixing/api dev"* ]] ||
      [[ "$leader_command" == *"tsx"*"watch src/server.ts"* ]]; then
      kill -TERM "-$pgid" 2>/dev/null || true
    else
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
}

start_api() {
  : > "$API_LOG"
  : > "$API_ERROR_LOG"
  if ! launchctl submit -l "$API_JOB_LABEL" -o "$API_LOG" -e "$API_ERROR_LOG" -- \
    /usr/bin/env ZHIXING_DEV_AUTH=1 PORT="$API_PORT" \
    ZHIXING_DEV_RUNNER_VERSION="$API_RUNNER_VERSION" \
    "$NODE_BIN" "$TSX_CLI" watch "$API_DIR/src/server.ts"; then
    echo "❌ 无法提交本地 API 的 launchctl 任务。" >&2
    exit 1
  fi

  if ! wait_for_command "本地 API 启动" 30 \
    curl --silent --fail --max-time 2 "$API_HEALTH_URL"; then
    echo "   API 日志：$API_LOG" >&2
    tail -n 30 "$API_LOG" >&2 || true
    tail -n 30 "$API_ERROR_LOG" >&2 || true
    exit 1
  fi

  local dev_auth_status
  dev_auth_status=$(curl --silent --output /dev/null --write-out '%{http_code}' \
    --max-time 2 --request POST "$API_BASE_URL/auth/dev" \
    --header 'content-type: application/json' --data '{}')
  if [[ "$dev_auth_status" != "400" ]]; then
    echo "❌ 本地 API 已启动，但开发登录端点校验失败（HTTP ${dev_auth_status}）。" >&2
    echo "   API 日志：$API_LOG" >&2
    exit 1
  fi

  local data_status
  data_status=$(curl --silent --output /dev/null --write-out '%{http_code}' \
    --max-time 5 "$API_BASE_URL/places/pins")
  if [[ "$data_status" != "200" ]]; then
    echo "❌ 本地 API 已启动，但数据库查询校验失败（HTTP ${data_status}）。" >&2
    echo "   API 日志：$API_LOG" >&2
    exit 1
  fi

  echo "✅ 本地 API 可用（开发登录 + 数据查询）：$API_BASE_URL"
  echo "   API 日志：$API_LOG"
}

for command in curl docker launchctl lsof node open pnpm ps xcodebuild xcodegen; do
  require_command "$command"
done

if [[ ! -f "$TSX_CLI" ]]; then
  echo "❌ 未找到 API 启动器：${TSX_CLI}，请先运行 pnpm install。" >&2
  exit 1
fi

mkdir -p "$DERIVED_DATA" "$API_RUNTIME_DIR"
chmod 700 "$API_RUNTIME_DIR"

if ! docker info >/dev/null 2>&1; then
  echo "▶️  Docker 尚未运行，正在启动 Docker Desktop…"
  if ! open -a Docker; then
    echo "❌ 无法启动 Docker Desktop，请确认已安装。" >&2
    exit 1
  fi
  wait_for_command " Docker Desktop 启动" 60 docker info
fi

echo "▶️  正在启动 Postgres 和 MinIO…"
cd "$ROOT"
pnpm db:up
wait_for_command " Postgres 就绪" 30 \
  docker compose exec -T db pg_isready -U zhixing -d zhixing
wait_for_command " MinIO 就绪" 30 \
  curl --silent --fail --max-time 2 http://localhost:9000/minio/health/live
echo "✅ Postgres 和 MinIO 已就绪。"

if api_is_ready && ! managed_api_needs_upgrade; then
  echo "✅ 本地 API 已完整就绪，复用现有进程：$API_BASE_URL"
else
  if managed_api_needs_upgrade; then
    echo "♻️  本地 API 托管方式需要升级，正在重启一次…"
  else
    echo "♻️  本地 API 未通过完整检查，正在启动或修复…"
  fi
  stop_managed_api
  stop_api_on_port
  wait_for_api_port_release
  start_api
fi

cd "$IOS_DIR"
xcodegen generate

xcodebuild -project Zhixing.xcodeproj -scheme Zhixing -configuration Debug \
  -destination 'generic/platform=macOS,variant=Mac Catalyst' \
  -derivedDataPath "$DERIVED_DATA" \
  CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="-" \
  build

if [[ ! -d "$APP" ]]; then
  echo "❌ 构建完成但未找到 App：$APP" >&2
  exit 1
fi

# 旧 Debug 实例可能仍指向上一版二进制；只匹配本次 DerivedData 产物的完整路径，
# 避免误关 /Applications 里安装的正式版或其他同名进程。
if pgrep -f -x "$APP_EXECUTABLE" >/dev/null; then
  echo "⏹  正在退出旧的 Zhixing 实例…"
  pkill -TERM -f -x "$APP_EXECUTABLE"
  for _ in {1..30}; do
    if ! pgrep -f -x "$APP_EXECUTABLE" >/dev/null; then break; fi
    sleep 0.1
  done
  if pgrep -f -x "$APP_EXECUTABLE" >/dev/null; then
    echo "❌ 旧的 Zhixing 实例未能退出，请手动关闭后重试。" >&2
    exit 1
  fi
fi

open -n "$APP"
for _ in {1..30}; do
  if pgrep -f -x "$APP_EXECUTABLE" >/dev/null; then
    echo "✅ 已启动 Debug Catalyst App：$APP"
    exit 0
  fi
  sleep 0.1
done

echo "❌ App 未成功启动，请检查 macOS 弹窗或系统日志。" >&2
exit 1
