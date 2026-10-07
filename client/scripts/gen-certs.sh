#!/usr/bin/env bash
# =============================================================================
# gen-certs.sh —— 生成本地开发用的自签证书（自建 CA + 带 SAN 的服务器证书）
#
# 为什么需要：getUserMedia（麦克风）只在安全上下文（HTTPS 或 localhost）暴露，
# 用局域网 IP 明文 HTTP 访问时浏览器不提供麦克风 API，因此 dev server 走 HTTPS。
#
# 用法（在仓库根目录或任意位置执行）：
#   bash client/scripts/gen-certs.sh                 # 自动检测本机局域网 IP 写进 SAN
#   bash client/scripts/gen-certs.sh 192.168.1.20    # 手动指定 IP（换网络后 IP 变了用这个）
#   bash client/scripts/gen-certs.sh 192.168.1.20 mypc.local   # 可混用多个 IP/域名
#
# 产物（client/.certs/，已在 .gitignore 忽略，每人自己生成，不进仓库）：
#   ca.crt / ca.key   自建 CA（CN=EchoRoom Dev CA，需装入系统信任库）
#   server.key / server.crt   dev server 用的证书（10 年有效，SAN 含 localhost + 你的 IP）
#
# 生成后把 ca.crt 装入信任库，方法见 README「HTTPS 与麦克风」一节。
# =============================================================================
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)/.certs"
mkdir -p "$DIR"

# 自动检测本机主 IPv4（Windows 中文/英文版 ipconfig 均可，其余平台用 hostname -I）
detect_ip() {
	if command -v ipconfig >/dev/null 2>&1; then
		ipconfig | grep 'IPv4' | grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' | grep -v '^127\.' | head -1
	else
		hostname -I 2>/dev/null | awk '{print $1}'
	fi
}

# SAN：localhost 恒有；参数优先，无参数时用检测到的局域网 IP
SAN="DNS:localhost,IP:127.0.0.1"
if [ "$#" -gt 0 ]; then
	for item in "$@"; do
		SAN="$SAN,IP:$item"
	done
	LAN_IP="$1"
else
	LAN_IP="$(detect_ip || true)"
	if [ -n "${LAN_IP:-}" ]; then
		SAN="$SAN,IP:$LAN_IP"
	fi
fi

echo "==> 输出目录: $DIR"
echo "==> 证书 SAN: $SAN"

# 1. 自建 CA（CN 必须是 EchoRoom Dev CA——README 里的信任/卸载命令按这个名字）。
#    subject 用配置文件传而不用 -subj "/CN=..."：Git Bash/MSYS 会把前导斜杠
#    误当 Windows 路径转换，-subj 在 Windows 上必然报错
cat > "$DIR/ca.cnf" <<'EOF'
[req]
distinguished_name = dn
prompt = no
x509_extensions = v3_ca
[dn]
CN = EchoRoom Dev CA
[v3_ca]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
EOF
openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
	-keyout "$DIR/ca.key" -out "$DIR/ca.crt" \
	-config "$DIR/ca.cnf"

# 2. 服务器私钥 + CSR
cat > "$DIR/server.cnf" <<'EOF'
[req]
distinguished_name = dn
prompt = no
[dn]
CN = localhost
EOF
openssl req -newkey rsa:2048 -nodes \
	-keyout "$DIR/server.key" -out "$DIR/server.csr" \
	-config "$DIR/server.cnf"

# 3. CA 签发服务器证书。Chrome 只认 SAN 字段，IP 必须显式写进 SAN；
#    叶子证书同时声明"非 CA + 服务器用途"，各平台信任库校验才严格通过
cat > "$DIR/san.cnf" <<EOF
basicConstraints = CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = $SAN
EOF
openssl x509 -req -in "$DIR/server.csr" -CA "$DIR/ca.crt" -CAkey "$DIR/ca.key" \
	-CAcreateserial -days 3650 -sha256 -extfile "$DIR/san.cnf" \
	-out "$DIR/server.crt"
rm -f "$DIR/server.csr" "$DIR/server.cnf" "$DIR/ca.cnf" "$DIR/san.cnf"

# 自检：证书链是否有效
openssl verify -CAfile "$DIR/ca.crt" "$DIR/server.crt"

echo
echo "✅ 证书已生成（10 年有效）。下一步把 CA 装入系统信任库："
echo "   Windows(管理员): certutil -addstore -f Root client\\.certs\\ca.crt"
echo "   macOS:           sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain client/.certs/ca.crt"
echo "   Debian/Ubuntu:   sudo cp client/.certs/ca.crt /usr/local/share/ca-certificates/echoroom-dev.crt && sudo update-ca-certificates"
echo "   （不装也行：浏览器点「高级 → 继续访问」，麦克风照常可用）"
