#!/usr/bin/env bash
# =============================================================================
# push.sh —— 打包部署产物并通过 SSH 推送到目标服务器执行一键部署
#
# 用法:
#   bash deploy/push.sh root@服务器IP                    # 默认局域网自签模式
#   bash deploy/push.sh root@服务器IP --domain voice.example.com
#   bash deploy/push.sh root@服务器IP --ssh-key ~/my.key  # 指定私钥
#
# 服务器上会安装/重启动 Caddy、LiveKit、voice-rooms、voicerooms-web 四个服务。
# =============================================================================
set -euo pipefail
if [[ $# -lt 1 ]]; then
	echo "用法: bash deploy/push.sh user@服务器IP [deploy-linux.sh 的参数...]"
	exit 1
fi
TARGET="$1"; shift
EXTRA_ARGS=("$@")
KEY=""
for i in "${!EXTRA_ARGS[@]}"; do
	if [[ "${EXTRA_ARGS[$i]}" == "--ssh-key" ]]; then KEY="${EXTRA_ARGS[$((i+1))]}"; fi
done
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
[[ -n "$KEY" ]] && SSH_OPTS+=(-i "$KEY")

echo "==> 1/2 打包"
( bash "$(dirname "$0")/pack.sh" )
BUNDLE=$(ls -t "$(dirname "$0")/../dist"/voice-rooms-deploy-*.tar.gz | head -1)

echo "==> 2/2 上传并在目标机执行部署"
scp "${SSH_OPTS[@]}" "$BUNDLE" "$TARGET:/tmp/voice-rooms-deploy.tgz"
ssh "${SSH_OPTS[@]}" "$TARGET" '
set -e
apt-get update -qq > /dev/null 2>&1 || true
apt-get install -y -qq unzip > /dev/null 2>&1 || true
rm -rf /opt/voice-rooms-deploy
mkdir -p /opt/voice-rooms-deploy
tar -xzf /tmp/voice-rooms-deploy.tgz -C /opt/voice-rooms-deploy
rm -f /tmp/voice-rooms-deploy.tgz
cd /opt/voice-rooms-deploy
sudo bash deploy-linux.sh '"${EXTRA_ARGS[*]:-}"'
'
echo "✅ 部署完成: 访问 https://服务器IP（或你指定的域名）"
