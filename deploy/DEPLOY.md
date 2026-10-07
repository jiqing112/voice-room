# 生产部署指南（从零到公网可访问）

> **只想一条命令起全栈？** 全部容器化的 Docker 部署在
> [deploy/docker/](docker/README.md)：`docker compose up -d --build` +
> 宿主机 Caddy 一段反代即可，服务器不用装 Go/Node。有域名走域名证书；
> **无域名纯公网 IP 也支持直连**（Let's Encrypt IP 证书 + `default_sni`，
> 完整说明见 [docker/Caddyfile.ip-direct.example](docker/Caddyfile.ip-direct.example)）。
> 下文是 systemd 方式的分步指南。

## 架构总览

```
浏览器
  │ https://your-domain.com（443，TLS 由反代终止）
  ▼
反向代理（Caddy 或 nginx）
  ├─ /            → SvelteKit Node 服务   127.0.0.1:3000
  ├─ /api、/ws    → Go 后端               127.0.0.1:8080
  └─ /livekit/*   → LiveKit 信令          127.0.0.1:7880
浏览器 ──WebRTC 媒体（UDP 50000-50100 / TCP 7881）──→ LiveKit 直连，不经过反代
```

四个进程全部可以用 systemd 常驻在一台服务器上。这套代码里前端在 HTTPS 下会自动把
信令地址改写为 `wss://<当前域名>/livekit`（`client/src/lib/api.ts` 的
`resolveSignalUrl`），所以反代只要照抄上面的路径规则即可，业务代码零改动。

## 第 0 步：准备

| 需要 | 说明 |
|---|---|
| 一台公网服务器 | Ubuntu/Debian，1C2G 起步 |
| 一个域名（强烈建议） | A 记录指向服务器 IP。**有域名才能用 Let's Encrypt 免费证书自动签发**；纯 IP 只能自签（见第 5 步方案 C） |
| 开放端口 | TCP 22/80/443/7881 + UDP 50000-50100（云服务器在安全组里放行） |
| 软件包 | `apt install -y nodejs nginx caddy`（二选一反代）、Go 可不装（本地交叉编译） |

## 第 1 步：前端（SvelteKit）

开发机上：

```bash
cd client
npm run build          # 产物在 build/，依赖生产模块
```

上传到服务器（`build/`、`package.json`、`package-lock.json`），服务器上：

```bash
mkdir -p /opt/voice-rooms/web
# 上传后：
cd /opt/voice-rooms/web
npm ci --omit=dev      # 只装生产依赖（adapter-node 运行需要）
cp /path/to/deploy/voicerooms-web.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now voicerooms-web
# 验证：curl http://127.0.0.1:3000 返回页面 HTML
```

## 第 2 步：Go 后端

开发机交叉编译 → 上传 → systemd（与现有 voice-rooms.service 相同，改环境变量）：

```bash
cd server
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -o voice-rooms-linux .
```

service 环境变量（生产值）：

```ini
Environment=PORT=8080
Environment=GIN_MODE=release
Environment=LIVEKIT_API_KEY=CHANGE_ME_KEY
Environment=LIVEKIT_API_SECRET=CHANGE_ME_SECRET_AT_LEAST_32_CHARS
Environment=LIVEKIT_URL=wss://your-domain.com/livekit
Environment=LIVEKIT_HTTP_URL=http://127.0.0.1:7880
```

## 第 3 步：LiveKit

```bash
# 上传 deploy/livekit.production.yaml 到 /opt/voice-rooms/，改掉 keys
cp deploy/livekit.service /etc/systemd/system/
# ExecStart 里的 --config 改为 /opt/voice-rooms/livekit.production.yaml
systemctl daemon-reload && systemctl enable --now livekit
```

## 第 4 步：反代 + SSL 证书（三选一）

### 方案 A：Caddy（最省事，推荐）

前提：域名已解析到服务器，80/443 可达。Caddy 自动申请并**自动续期** Let's Encrypt 证书：

```bash
apt install -y caddy
cp deploy/caddy/Caddyfile /etc/caddy/Caddyfile   # 改域名
systemctl reload caddy
# 完成。证书自动管理，无需任何续期脚本
```

### 方案 B：nginx + Let's Encrypt

```bash
apt install -y nginx certbot python3-certbot-nginx
cp deploy/nginx/voicerooms.conf /etc/nginx/conf.d/   # 改域名
# 先注释掉 conf 里的 ssl_certificate 两行并临时监听 80，签发后再恢复：
certbot --nginx -d your-domain.com    # 自动改写 nginx 配置并配置自动续期
systemctl reload nginx
```

也可以用云厂商（阿里云/腾讯云）的**免费一年期证书**：在控制台申请域名证书 →
下载 nginx 格式 → 放到 `/etc/nginx/ssl/` → 按 voicerooms.conf 里注释的路径引用。

### 方案 C：纯内网、没有域名（自签证书）

生成带 IP SAN 的自建 CA 并安装到所有使用者的电脑信任库（本项目开发环境就是这么做的，
命令见 `client/.certs/` 的生成历史与主 README 的「HTTPS 与麦克风」一节）。
缺点：每个新使用者都要装一次 CA，手机端不友好。

## 第 5 步：验证清单

```bash
curl https://your-domain.com/api/health
# 期望：{"activeRooms":0,"go":"ok","livekit":"ok"}
```

浏览器打开站点 → 进房 → 两台设备互听。若能连上但听不见/画面不通：
1. 检查安全组 UDP 50000-50100 是否放行（最常见的坑）
2. 双方都在严格 NAT 后时，启用 livekit.production.yaml 里的 TURN 配置

## 与开发环境的差异速查

| 项 | 开发（现在） | 生产 |
|---|---|---|
| 前端 | Vite dev server（HTTPS 自签） | adapter-node + systemd，TLS 交给反代 |
| /api、/ws、/livekit 代理 | vite.config.ts 的 server.proxy | nginx/Caddy 的 location/handle |
| 证书 | 自建 CA（client/.certs） | Let's Encrypt 自动续期（或云证书） |
| LiveKit 密钥 | devkey/devkeysecret | 必须换成随机长密钥 |
| LiveKit use_external_ip | false（局域网） | true（公网） |
