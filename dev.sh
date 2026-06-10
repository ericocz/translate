#!/usr/bin/env bash
#
# dev.sh —— 一键起本地开发环境（tmux 三窗格）
#
#   ./dev.sh                  全起：server + admin + front
#   ./dev.sh server admin     只起指定子集（参数取 server / admin / front，顺序随意）
#
# 各服务命令：
#   server → uv run uvicorn app.main:app --port 8000 --reload   （:8000，热重载）
#   admin  → pnpm dev                                            （Next.js :3001）
#   front  → pnpm dev                                            （WXT，会自己拉起带扩展的 Chrome）
#
# 会话名固定 imt：已在跑就直接接入，不重复拉起；要重来先 `tmux kill-session -t imt`。

set -euo pipefail

SESSION=imt
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 返回某个服务在其子目录下要跑的命令
cmd_for() {
  case "$1" in
    server) echo "uv run uvicorn app.main:app --port 8000 --reload" ;;
    admin)  echo "pnpm dev" ;;
    front)  echo "pnpm dev" ;;
  esac
}

# 组装单个窗格要执行的整条命令：进子目录 → 跑服务 → 退出后落回 shell（方便看报错/重启）
pane_cmd() {
  local svc="$1"
  printf 'cd %q && %s; echo; echo "[%s] 已退出，按上箭头可重跑"; exec $SHELL' \
    "$ROOT/$svc" "$(cmd_for "$svc")" "$svc"
}

# ---- 解析参数 ----
SERVICES=()
if [ "$#" -eq 0 ]; then
  SERVICES=(server admin front)
else
  for arg in "$@"; do
    case "$arg" in
      server|admin|front) SERVICES+=("$arg") ;;
      -h|--help)
        sed -n '3,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
        exit 0 ;;
      *)
        echo "未知服务：${arg}（可选：server / admin / front）" >&2
        exit 1 ;;
    esac
  done
fi

# ---- 前置检查 ----
if ! command -v tmux >/dev/null 2>&1; then
  echo "没装 tmux。先装一下：brew install tmux" >&2
  exit 1
fi

# 接入会话：已在 tmux 里就 switch-client，否则 attach
attach_session() {
  if [ -n "${TMUX:-}" ]; then
    tmux switch-client -t "$SESSION"
  else
    exec tmux attach -t "$SESSION"
  fi
}

# 会话已存在 → 直接接入，不重复拉起
if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "tmux 会话 '$SESSION' 已在运行，直接接入。要重来先：tmux kill-session -t $SESSION"
  attach_session
fi

# ---- 创建会话 + 窗格 ----
first="${SERVICES[0]}"
tmux new-session -d -s "$SESSION" -n dev
tmux send-keys -t "$SESSION" "$(pane_cmd "$first")" C-m
tmux select-pane -t "$SESSION" -T "$first"

for svc in "${SERVICES[@]:1}"; do
  tmux split-window -t "$SESSION"
  tmux send-keys -t "$SESSION" "$(pane_cmd "$svc")" C-m
  tmux select-pane -t "$SESSION" -T "$svc"
  tmux select-layout -t "$SESSION" tiled >/dev/null
done

# 窗格边框上显示服务名（tmux ≥2.3；老版本忽略）
tmux set -t "$SESSION" pane-border-status top 2>/dev/null || true
tmux select-pane -t "$SESSION" -t 0 2>/dev/null || true

attach_session
