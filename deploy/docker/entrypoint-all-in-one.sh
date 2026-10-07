#!/bin/sh
# =============================================================================
# all-in-one 入口：在一个容器里守护三个进程
#   livekit-server（信令+媒体, 7880/7881/UDP） / voice-rooms（Go API, 8080）
#   node build/index.js（SvelteKit, 3000）
#
# fail-fast 语义：任何一个进程退出 → 整个容器退出 → 由 docker 的 restart
# 策略把三个一起拉起。不做单进程自动重启（那会掩盖半死状态，比如
# LiveKit 挂了但 API 还活着，进房全部失败还不自愈）。
#
# 实现注意：不用 `wait -n`——busybox ash 的 wait -n 在子进程退出时
# 可能不醒来（实测踩坑）；改为记录 PID + 定时 kill -0 轮询，行为确定。
# =============================================================================
set -u

cleanup() {
	kill 0 2>/dev/null
}
trap cleanup INT TERM

pids=""
livekit-server --config /etc/livekit.yaml &
pids="$pids $!"

echo "[aio] 启动 Go 后端 (0.0.0.0:${PORT:-8080})"
PORT="${PORT:-8080}" HOST="${HOST:-0.0.0.0}" voice-rooms &
pids="$pids $!"

echo "[aio] 启动 SvelteKit web (0.0.0.0:3000)"
cd /app/web
PORT=3000 HOST=0.0.0.0 node build/index.js &
pids="$pids $!"

echo "[aio] 三进程已启动，监督中:$pids"
while :; do
	sleep 2
	for p in $pids; do
		if ! kill -0 "$p" 2>/dev/null; then
			echo "[aio] 进程 $p 已退出，停止整个容器（由 restart 策略拉起全部）"
			cleanup
			exit 1
		fi
	done
done
