# 本地开发与源码部署指南

主 README 只保留快速开始，本文是完整细节：本地联调、HTTPS 证书、源码方式上生产、调试工具。

## 本地部署（从零到双人互听）

> 前置软件：**Docker**（跑 LiveKit）、**Go 1.22+**（工具链会自动切换到 go1.26）、**Node 20+**。
> 先自检：`docker --version`、`go version`、`node -v`。三样齐了往下走，全程不需要改任何代码——
> LiveKit 密钥、端口全部有开发默认值，`devkey/devkeysecret` 与 `livekit.yaml` 预先配对。

### 第 1 步：启动 LiveKit 媒体服务器（Docker）

```bash
docker compose up -d          # 首次会拉镜像，一两分钟
docker compose ps             # STATUS 应为 running
curl http://localhost:7880    # 返回 OK 即信令可达
```

用的是根目录 `livekit.yaml`：信令 7880、TCP 媒体回退 7881、UDP 媒体 50000-50100。
停止用 `docker compose down`（无状态，随时可删）。

**没有 Docker？** 两条替代路径：

- 直接跑 [LiveKit 官方二进制](https://github.com/livekit/livekit/releases)：
  `livekit-server --config livekit.yaml`
- LiveKit 跑在别的机器/虚拟机：第 2 步启动后端时改两个环境变量（见下表），
  第 3 步启动前端时加 `LIVEKIT_PROXY_TARGET=http://那台机IP:7880`。

### 第 2 步：启动 Go 后端（默认 8080 端口）

```bash
cd server
go run .        # 首次编译 + 拉依赖，几十秒；保持这个终端开着
```

**验证**（另开一个终端）：

```bash
curl http://127.0.0.1:8080/api/health
# {"go":"ok","livekit":"ok"} 即成功；livekit 是 down 说明密钥/地址没配对
```

环境变量（都有默认值，按需覆盖）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8080` | Go 服务监听端口（被占用就换：`PORT=8090 go run .`） |
| `HOST` | `127.0.0.1` | 监听地址，本地开发不用动 |
| `LIVEKIT_API_KEY` | `devkey` | 与 livekit.yaml 的 keys 一致 |
| `LIVEKIT_API_SECRET` | `devkeysecret` | 同上 |
| `LIVEKIT_URL` | `ws://localhost:7880` | **浏览器**连接 LiveKit 用的地址 |
| `LIVEKIT_HTTP_URL` | `http://localhost:7880` | Go 后端调 LiveKit API 的地址 |

LiveKit 在别的机器时：`LIVEKIT_URL=ws://192.168.x.x:7880 LIVEKIT_HTTP_URL=http://192.168.x.x:7880 go run .`

首次运行会在 `server/` 下生成 `auth.db`（SQLite 账号库），删掉即重置账号数据。

### 第 3 步：启动前端 dev server

```bash
cd client
npm install     # 首次
npm run dev
```

本机访问 **http://localhost:5173** 就能进房间（localhost 天然是安全上下文，麦克风可用，
不需要证书）。填房间名和昵称 → 进入 → 点「打开麦克风」。

开发期 Vite 把 `/api` 与 `/ws` 代理到 Go 后端（`API_PROXY_TARGET` 环境变量可改目标），
无需配置 CORS。

### 自定义端口（所有组件都可改）

本地部署没有反代和容器，浏览器始终只访问前端 dev server 一个口（`/api`、`/ws`、
`/livekit` 都由 Vite 代为转发），所以改后端/LiveKit 端口不影响浏览器访问的端口：

| 组件 | 默认 | 怎么改 | 需要联动的地方 |
|---|---|---|---|
| 前端 dev server | `5173` | `npm run dev -- --port 5174`（暴露局域网再加 `--host`） | 无 |
| Go 后端 | `127.0.0.1:8080` | `PORT=8090 go run .` | 前端启动加 `API_PROXY_TARGET=http://localhost:8090` |
| LiveKit 信令 | `7880` | 改 `livekit.yaml` 的 `port:` | Go 的 `LIVEKIT_URL` / `LIVEKIT_HTTP_URL`、前端的 `LIVEKIT_PROXY_TARGET` 三处跟着改 |
| LiveKit 媒体 | TCP `7881` / UDP `50000-50100` | 改 `livekit.yaml` 的 `rtc` 段 | 无（浏览器直连，一般不用动） |

例：后端换到 8090、LiveKit 信令换到 7870：

```bash
# 1. livekit.yaml: port: 7870，然后 docker compose up -d
# 2. 后端
cd server && LIVEKIT_URL=ws://localhost:7870 LIVEKIT_HTTP_URL=http://localhost:7870 PORT=8090 go run .
# 3. 前端
cd ../client && API_PROXY_TARGET=http://localhost:8090 LIVEKIT_PROXY_TARGET=http://localhost:7870 npm run dev
```

### 局域网多人联调（手机/第二台电脑互听）

麦克风 API 只在**安全上下文**（HTTPS 或 localhost）暴露——局域网 IP 明文 HTTP
访问时浏览器不提供 `getUserMedia`。所以 dev server 配置为 HTTPS，需要一次性生成证书：

```bash
bash client/scripts/gen-certs.sh        # 自建 CA + 带 SAN 的服务器证书，10 年有效
```

脚本会自动把本机局域网 IP 写进证书 SAN（换网络后 IP 变了就重跑一次并重启 dev server）。
产物在 `client/.certs/`（含私钥，已被 .gitignore 忽略，每人自己生成，不进仓库）。

**信任 CA**（每个要用麦克风的设备做一次；不做也行，浏览器点「高级 → 继续访问」，
HTTPS 依然成立，麦克风照常可用）：

| 平台 | 命令 |
|---|---|
| Windows（管理员） | `certutil -addstore -f Root client\.certs\ca.crt`，卸载：`certutil -delstore Root "EchoRoom Dev CA"` |
| macOS | `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain client/.certs/ca.crt` |
| Debian/Ubuntu | `sudo cp client/.certs/ca.crt /usr/local/share/ca-certificates/echoroom-dev.crt && sudo update-ca-certificates` |

**把 dev server 暴露到局域网**（Vite 默认只听 localhost）：

```bash
npm run dev -- --host
# 其他设备打开 https://<本机局域网IP>:5173
```

首次启动 Windows 防火墙弹窗选择「允许」（Node.js 和 Docker 各一次）。
localStorage 按源隔离：`http://localhost` 与 `https://局域网IP` 的昵称互不相通，需各填一次。

**测试双人对讲**：两个 Chrome 窗口（一个正常 + 一个无痕）进同一房间，其中一人开麦即可互听；
首次开麦若浏览器拦截自动播放，房间页顶部会出现「点击开启声音」按钮，点一下即可。

### 信令为什么走 `/livekit` 路径代理

HTTPS 页面禁止连 `ws://` 明文信令（混合内容），而给 WebSocket 的自签证书点信任
又没有入口。本项目的做法：前端在 HTTPS 下自动把信令地址改写为
`wss://<当前域名>/livekit`（`api.ts` 的 `resolveSignalUrl`），由 dev server 转发到
真正的 LiveKit（`LIVEKIT_PROXY_TARGET` 环境变量可改目标）。浏览器全程只信任前端
一个证书；WebRTC 媒体流走 UDP/TCP 直连不经代理，LiveKit 本身无需任何 TLS 配置。
已实测 livekit-client@2.22 支持带路径的信令地址。

### 本地常见问题速查

| 现象 | 原因与处理 |
|---|---|
| `/api/health` 显示 `livekit: down` | LiveKit 没起（`docker compose ps`）或 `LIVEKIT_HTTP_URL` 不对 |
| 8080 端口被占用 | `PORT=8090 go run .`，前端加 `API_PROXY_TARGET=http://localhost:8090 npm run dev` |
| 令牌报 `token is not valid yet` | 机器时钟漂了，同步系统时间 |
| 进房后没有声音 | 默认闭麦：点「打开麦克风」；或自动播放被拦：点「点击开启声音」 |
| 麦克风按钮报权限错误 | 页面不是 HTTPS/localhost（局域网 IP 明文 HTTP），见上一节 |
| 局域网设备打不开 5173 | dev server 没加 `--host`，或本机防火墙拦了 Node |
| 两端都连上但互相听不见 | 检查 UDP 50000-50100：本地一般没事，虚拟机网络记得放行 |
| 同一昵称两个标签页互踢 | 正常——后连者顶替同名连接，换昵称或用无痕窗口 |

## 源码直跑上生产

不打包、不 Docker，服务器上 clone 即构建。前置：Go 1.22+、Node 20+、LiveKit
（Docker 或[官方二进制](https://github.com/livekit/livekit/releases)均可）。

```bash
git clone https://github.com/jiqing112/voice-room.git && cd voice-room

# 0. 生成一对 LiveKit 密钥（livekit 与 Go 后端必须用同一对）
export LK_KEY=$(openssl rand -hex 8) LK_SECRET=$(openssl rand -hex 24)

# 1. LiveKit：把根目录 livekit.yaml 的 keys: 改成 "${LK_KEY}: ${LK_SECRET}"，然后启动
vim livekit.yaml          # keys: <LK_KEY的值>: <LK_SECRET的值>
docker compose up -d      # 或 livekit-server --config livekit.yaml

# 2. 构建并跑 Go 后端（监听 127.0.0.1:8080）
cd server
LIVEKIT_URL=wss://你的域名/livekit \
LIVEKIT_API_KEY=$LK_KEY LIVEKIT_API_SECRET=$LK_SECRET \
GIN_MODE=release AUTH_DB=/opt/voice-rooms/auth.db \
go build -o voice-rooms . && ./voice-rooms

# 3. 构建并跑前端（监听 127.0.0.1:3000）
cd ../client
npm ci && npm run build && npm ci --omit=dev --ignore-scripts
ORIGIN=https://你的域名 PORT=3000 HOST=127.0.0.1 node build/index.js
```

三个进程起来后按主 README 的反代章节配置即可对外。**长期运行不建议 `nohup` 裸跑**——
把这三个命令写进 systemd（参考 `deploy/*.service` 模板），否则断线/重启后没人拉起。

## 调试工具

```bash
# 查看某房间在 LiveKit 服务端的参与者
go run ./server/tools/probe "房间名"

# 模拟一名持续说话的参会者（发带 RFC6464 电平的 RTP 包，可触发"正在说话"高亮）
go run ./server/tools/audiobot "房间名" 60
```

浏览器控制台调试钩子（`DEV` 构建或 `localStorage['echo:debug']=1` 时启用）：
`window.__lkRoom`（LiveKit Room 实例）、`window.__echoCtl`（房间控制器）。

## 已验证项

- [x] 令牌签发：JWT 权限为 `roomJoin + room + canPublish + canSubscribe`（2 小时有效）
- [x] 浏览器 ↔ 远端 LiveKit 真实 WebRTC 连接（两端均显示"语音已连接"）
- [x] 房间创建/列表/成员进出的实时同步（WebSocket 断开即移除成员）
- [x] "谁在说话"高亮（服务端说话人检测 → ActiveSpeakersChanged → UI 徽章，已用 audiobot 端到端验证）
- [x] 自动播放拦截的解锁路径（`room.startAudio()` + 手势按钮）
- [x] 麦克风开关与错误处理（拒绝授权时提示且不崩溃）
- [x] 访问码门禁 + 防爆破（错 5 次锁 10 分钟）、进房票据（码不进 URL/日志）
- [x] 账号系统（注册/登录/会话/改密/改昵称）与认证接口限速
- [x] Docker 三容器 / 单容器 all-in-one 部署（Debian 13 + Docker 实测）
- [x] Let's Encrypt IP 证书（Caddy 2.11 + shortlived profile）公网 IP 直连
