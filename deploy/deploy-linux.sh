#!/usr/bin/env bash
# =============================================================================
# deploy-linux.sh —— voice-rooms 一键部署（Ubuntu/Debian，root 运行）
#
# 用法:
#   sudo bash deploy-linux.sh                          # 局域网模式（自签 HTTPS）
#   sudo bash deploy-linux.sh --domain voice.example.com   # 公网域名（自动 HTTPS）
#   sudo bash deploy-linux.sh --http                   # 纯 HTTP（仅本机测试，远程无法用麦克风）
#
# 可选参数:
#   --basicauth 用户:密码   首页与建房接口的密码墙（缺省自动生成随机账号密码）
#   --register              开放注册/登录系统（缺省关闭）
#   --require-account       创建房间需要登录（缺省关闭，游客自由建房）
#
# 部署内容: Caddy(443/80) + LiveKit(7880/7881/UDP50000-50100) + Go 后端(127.0.0.1:8080)
#           + SvelteKit Web(127.0.0.1:3000)，全部 systemd 常驻开机自启
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"

# ---------- 参数 ----------
DOMAIN=""; LAN=0; HTTP=0; BA_USER=""; BA_PASS=""
while [[ $# -gt 0 ]]; do
	case "$1" in
		--domain) DOMAIN="$2"; shift 2 ;;
		--lan) LAN=1; shift ;;
		--http) HTTP=1; shift ;;
		--basicauth) BA_USER="${2%%:*}"; BA_PASS="${2##*:}"; shift 2 ;;
		--register) REGISTER=1; shift ;;
		--require-account) REQUIRE=1; shift ;;
		*) echo "未知参数: $1"; exit 1 ;;
	esac
done
[[ $EUID -eq 0 ]] || { echo "请用 root 运行"; exit 1; }
[[ -f bin/voice-rooms-linux && -d web/build ]] || { echo "请在解压后的部署包目录运行（缺 bin/ 或 web/build/）"; exit 1; }

REGISTER="${REGISTER:-0}"
REQUIRE="${REQUIRE:-0}"
if [[ -z "$DOMAIN" && $LAN -eq 0 && $HTTP -eq 0 ]]; then LAN=1; fi

# ---------- 随机密钥 ----------
LIVEKIT_KEY=$(openssl rand -hex 8)
LIVEKIT_SECRET=$(openssl rand -hex 24)
if [[ -z "$BA_USER" ]]; then BA_USER="admin"; BA_PASS=$(openssl rand -hex 6); fi

echo "================================================"
echo " 域名:        ${DOMAIN:-（无，$([[ $HTTP -eq 1 ]] && echo 'HTTP 模式' || echo '局域网自签 HTTPS 模式'）)}"
echo " BasicAuth:   $BA_USER / $BA_PASS"
echo " 注册系统:    $([[ $REGISTER == 1 ]] && echo 开启 || echo 关闭)"
echo " 建房需登录:  $([[ $REQUIRE == 1 ]] && echo 开启 || echo 关闭（游客自由建房）)"
echo "================================================"
sleep 2

# ---------- 1. 基础依赖 ----------
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl unzip openssl ca-certificates gnupg > /dev/null

# Node 20（已有 >=18 则跳过）
NEED_NODE=1
if command -v node > /dev/null; then
	V=$(node -v | tr -d v); MAJOR=${V%%.*}
	[[ $MAJOR -ge 18 ]] && NEED_NODE=0
fi
if [[ $NEED_NODE -eq 1 ]]; then
	curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null
	apt-get install -y -qq nodejs > /dev/null
fi
echo "node: $(node -v)"

# ---------- 2. 目录与文件 ----------
mkdir -p /opt/voice-rooms/bin /opt/voice-rooms/web
cp bin/voice-rooms-linux /opt/voice-rooms/bin/voice-rooms && chmod +x /opt/voice-rooms/bin/voice-rooms
rm -rf /opt/voice-rooms/web/build /opt/voice-rooms/web/node_modules
cp -r web/build /opt/voice-rooms/web/build
cp -r web/node_modules /opt/voice-rooms/web/node_modules
cp web/package.json /opt/voice-rooms/web/package.json

# ---------- 3. LiveKit ----------
LK_VERSION=1.13.7
if [[ ! -f /opt/voice-rooms/bin/livekit-server ]]; then
	curl -fsSL -o /tmp/livekit.tar.gz "https://github.com/livekit/livekit/releases/download/v${LK_VERSION}/livekit_${LK_VERSION}_linux_amd64.tar.gz"
	tar -xzf /tmp/livekit.tar.gz -C /opt/voice-rooms/bin livekit-server && rm -f /tmp/livekit.tar.gz
fi
SCHEME=$([[ $HTTP -eq 1 ]] && echo http || echo https)
ORIGIN="${SCHEME}://$( [[ -n "$DOMAIN" ]] && echo "$DOMAIN" || hostname -I | awk '{print $1}' )"
cat > /opt/voice-rooms/livekit.yaml << EOF
port: 7880
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50100
  use_external_ip: true
keys:
  ${LIVEKIT_KEY}: ${LIVEKIT_SECRET}
# 如需 TURN 中继（UDP 被堵的网络），有域名证书后取消注释:
# turn:
#   enabled: true
#   domain: ${DOMAIN:-echo.example.com}
#   tls_port: 5349
#   udp_port: 3478
#   cert_file: /etc/ssl/...
#   key_file: /etc/ssl/...
EOF

cat > /etc/systemd/system/livekit.service << EOF
[Unit]
Description=LiveKit Media Server (voice-rooms)
After=network.target
[Service]
User=voice-rooms
ExecStart=/opt/voice-rooms/bin/livekit-server --config /opt/voice-rooms/livekit.yaml
Restart=always
[Install]
WantedBy=multi-user.target
EOF

# ---------- 4. Go 后端 ----------
cat > /etc/systemd/system/voice-rooms.service << EOF
[Unit]
Description=Voice Rooms Go API Server
After=network.target livekit.service
[Service]
User=voice-rooms
WorkingDirectory=/opt/voice-rooms
Environment=PORT=8080
Environment=GIN_MODE=release
Environment=LIVEKIT_API_KEY=${LIVEKIT_KEY}
Environment=LIVEKIT_API_SECRET=${LIVEKIT_SECRET}
Environment=LIVEKIT_URL=${SCHEME}://${ORIGIN#*://}/livekit
Environment=LIVEKIT_HTTP_URL=http://127.0.0.1:7880
Environment=WS_ALLOWED_ORIGIN=${ORIGIN}
Environment=AUTH_DB=/opt/voice-rooms/auth.db
Environment=AUTH_REGISTER_ENABLED=${REGISTER}
Environment=CREATE_REQUIRE_ACCOUNT=${REQUIRE}
# 邮箱验证码（预留）: MAIL_VERIFY_ENABLED=true 并填以下发信配置后重启
Environment=MAIL_VERIFY_ENABLED=false
Environment=MAIL_SMTP_HOST=smtp.example.com
Environment=MAIL_SMTP_PORT=465
Environment=MAIL_SMTP_USER=
Environment=MAIL_SMTP_PASS=
Environment=MAIL_FROM_NAME=回声室
ExecStart=/opt/voice-rooms/bin/voice-rooms
Restart=always
[Install]
WantedBy=multi-user.target
EOF

# ---------- 5. Web ----------
cat > /etc/systemd/system/voicerooms-web.service << EOF
[Unit]
Description=Voice Rooms Web (SvelteKit)
After=network.target
[Service]
User=voice-rooms
WorkingDirectory=/opt/voice-rooms/web
Environment=PORT=3000
Environment=HOST=127.0.0.1
# SvelteKit 需要知道对外源（绝对地址/CSRF 判定）；缺少它 adapter-node 只能
# 看到反代进来的 127.0.0.1:3000，依赖 origin 的逻辑在生产行为不可靠
Environment=ORIGIN=${ORIGIN}
ExecStart=$(command -v node) build/index.js
Restart=always
[Install]
WantedBy=multi-user.target
EOF

# ---------- 5.5 专用运行账号 ----------
# 三个服务（LiveKit/Go/SvelteKit）都不需要 root：建系统账号并交出目录属主
id -u voice-rooms >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin voice-rooms
chown -R voice-rooms:voice-rooms /opt/voice-rooms

systemctl daemon-reload
systemctl enable --now livekit voice-rooms voicerooms-web
sleep 2

# ---------- 6. Caddy ----------
CADDY_VERSION=2.11.2
if ! command -v caddy > /dev/null; then
	curl -fsSL -o /tmp/caddy.tar.gz "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_linux_amd64.tar.gz"
	tar -xzf /tmp/caddy.tar.gz -C /usr/local/bin caddy && rm -f /tmp/caddy.tar.gz
fi
BA_HASH=$(caddy hash-password --plaintext "$BA_PASS")

SITE_ADDR=$([[ -n "$DOMAIN" ]] && echo "$DOMAIN" || hostname -I | awk '{print $1}')
TLS_LINE=""
if [[ $HTTP -eq 0 ]]; then
	# 有域名走自动 HTTPS；无域名走 Caddy internal 自签（浏览器提示后点继续，麦克风可用）
	TLS_LINE=$([[ -n "$DOMAIN" ]] && echo "" || echo "	tls internal")
fi

cat > /etc/caddy/Caddyfile << EOF
${SITE_ADDR} {
${TLS_LINE}
	# 站点入口密码墙：仅保护首页；/api、/ws、/livekit、/room 邀请链接不受影响
	basic_auth / {
		${BA_USER} ${BA_HASH}
	}
	basic_auth /api/rooms {
		${BA_USER} ${BA_HASH}
	}
	@noCache {
		not path /_app/*
		not path /rnnoise/*
	}
	header @noCache Cache-Control "no-cache"

	handle /api/* {
		reverse_proxy 127.0.0.1:8080
	}
	handle /ws {
		reverse_proxy 127.0.0.1:8080
	}
	handle_path /livekit/* {
		# 剥掉浏览器自动附加的 Basic 凭据：LiveKit 只认 Bearer 令牌
		reverse_proxy 127.0.0.1:7880 {
			header_up -Authorization
		}
	}
	handle {
		reverse_proxy 127.0.0.1:3000
	}
}
EOF
# Caddy 只被下载了二进制、没有现成 systemd 单元时补一个——
# 否则下面的 enable/restart 会静默失败，站点实际没人监听
if ! systemctl cat caddy.service >/dev/null 2>&1; then
	cat > /etc/systemd/system/caddy.service << EOF
[Unit]
Description=Caddy Web Server (voice-rooms)
After=network.target network-online.target
Wants=network-online.target
[Service]
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
Restart=always
[Install]
WantedBy=multi-user.target
EOF
	systemctl daemon-reload
fi
systemctl restart caddy 2>/dev/null || (systemctl enable --now caddy 2>/dev/null && systemctl restart caddy)

# ---------- 7. NTP ----------
timedatectl set-ntp true 2>/dev/null || true

# ---------- 8. 健康检查 ----------
sleep 2
HEALTH=$(curl -s -m 5 http://127.0.0.1:8080/api/health | head -c 80)
WEB=$(curl -s -m 5 -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/)

echo
echo "================================================"
echo " ✅ 部署完成"
echo " 访问地址:   ${ORIGIN}"
echo " 站点密码:   ${BA_USER} / ${BA_PASS}  ← 发给需要进首页的朋友"
echo " 后端健康:   $HEALTH"
echo " Web:        $WEB"
echo
echo " 需放行的端口（云安全组/防火墙）:"
[[ $HTTP -eq 1 ]] && echo "   TCP 80（HTTP 模式）" || echo "   TCP 80+443（HTTPS，$([[ -n "$DOMAIN" ]] && echo 自动证书 || echo 自签证书）)"
echo "   TCP 7881 + UDP 50000-50100（语音媒体）"
echo "   （3478/5349 仅在启用 TURN 后需要）"
echo
echo " 服务管理: systemctl restart|status voice-rooms livekit voicerooms-web caddy"
echo " 配置文件: /opt/voice-rooms/livekit.yaml, /etc/systemd/system/voice-rooms.service"
echo "================================================"
