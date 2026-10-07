#!/usr/bin/env bash
# =============================================================================
# pack.sh —— 在开发机构建整套部署产物（一键打包）
#
# 产物: dist/voice-rooms-deploy-<时间>.tar.gz
#   voice-rooms-deploy/
#     ├── bin/voice-rooms-linux        Go 后端（Linux）
#     ├── bin/voice-rooms-windows.exe  Go 后端（Windows）
#     ├── web/                         前端构建产物 + 生产依赖（跨平台通用）
#     ├── deploy-linux.sh              目标 Linux 服务器一键部署脚本
#     └── deploy-windows.ps1           目标 Windows 服务器一键部署脚本
#
# 用法:
#   bash deploy/pack.sh
#   然后把 dist/ 下的 tar.gz 上传到目标服务器，解压后执行 deploy-linux.sh
#   （或直接用 deploy/push.sh root@服务器IP 一条命令推过去）
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
DIST="$ROOT/dist"
STAMP=$(date +%Y%m%d-%H%M)
OUT="$ROOT/dist/voice-rooms-deploy"
rm -rf "$OUT"
mkdir -p "$OUT/bin" "$OUT/web"

echo "==> 1/5 构建前端（SvelteKit → adapter-node 产物）"
( cd client && npm run build > /dev/null )

echo "==> 2/5 安装前端生产依赖（独立临时目录，不占用工作区 node_modules）"
TMPD="$ROOT/dist/pkg-deps"
mkdir -p "$TMPD"
cp client/package.json client/package-lock.json "$TMPD/"
# --ignore-scripts：跳过 package.json 的 prepare 钩子（它会调 svelte-kit，
# 而临时目录只装了生产依赖、没有 svelte-kit，不跳过会报"不是内部或外部命令"）
( cd "$TMPD" && npm ci --omit=dev --ignore-scripts > /dev/null )

echo "==> 3/5 收集前端产物"
cp -r client/build "$OUT/web/build"
cp -r "$TMPD/node_modules" "$OUT/web/node_modules"
cp client/package.json "$OUT/web/package.json"

echo "==> 4/5 交叉编译 Go 后端（Linux amd64 + Windows amd64）"
( cd server
  GOOS=linux   GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o "$OUT/bin/voice-rooms-linux" .
  GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o "$OUT/bin/voice-rooms-windows.exe" . )

echo "==> 5/5 复制目标机部署脚本"
cp deploy/deploy-linux.sh "$OUT/"
cp deploy/deploy-windows.ps1 "$OUT/"
cat > "$OUT/README.txt" << "EOF"
voice-rooms 一键部署包
======================
Linux (Ubuntu/Debian, root):
    tar -xzf voice-rooms-deploy-*.tar.gz
    cd voice-rooms-deploy
    sudo bash deploy-linux.sh                # 交互式（会询问域名/密码墙）
    sudo bash deploy-linux.sh --domain voice.example.com   # 指定域名自动 HTTPS

Windows Server (管理员 PowerShell):
    Set-ExecutionPolicy -Scope Process Bypass
    .\deploy-windows.ps1
EOF

tar -czf "$ROOT/dist/voice-rooms-deploy-$STAMP.tar.gz" -C "$DIST" voice-rooms-deploy
rm -rf "$OUT"
echo
echo "✅ 打包完成: dist/voice-rooms-deploy-$STAMP.tar.gz ($(du -h "$ROOT/dist/voice-rooms-deploy-$STAMP.tar.gz" | cut -f1))"
echo "   推送到服务器: bash deploy/push.sh root@服务器IP"
