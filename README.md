# 回声室 · 多人语音聊天室（voice-rooms）

面向朋友间自建部署的语音开黑工具，替代 YY 的最小实现。**媒体层完全由 [LiveKit](https://livekit.io) 承担**（SFU、WebRTC、Opus、回声消除等全部不自己写），Go 后端只做两件事：签发 LiveKit 访问令牌、同步房间成员列表。

**使用流程**：打开首页 → 填房间名和昵称 → 进入（房间不存在会自动创建）；离开后没人的房间会自动注销，首页列表只显示当前在线的房间。清理阈值可用环境变量 `ROOM_IDLE_TTL`（默认 1m）与 `ROOM_SWEEP_EVERY`（默认 30s）调整。

**背景音乐**：房间页底部唱片按钮 → 上传音乐文件（mp3 等）→ 作为独立高保真音轨播放给全房间（不经过麦克风处理链，无损）；播放条支持暂停/音量/停止。音乐模式与之互补：音乐模式优化麦克风收音（唱歌），背景音乐直接播文件。

**按人调音量**：房间页每张远端成员卡片有独立音量滑杆（0-100%，步进 1），某人声音太大/太小时单独调整，只影响自己听到的音量。

**访问码与分享**：进入时填了访问码，该码就成为房间的门禁（校验点在令牌签发处，
拿不到令牌就进不了 LiveKit）。房间页"邀请"按钮会复制带访问码的链接
（`/room/房间名?code=xxx`），朋友点开免输码直接进；手动输入房间名进有码房间
则会看到输码界面。**防爆破**：同一 IP 对同一房间访问码错 5 次锁 10 分钟
（`security.go`），另有每 IP 每分钟 60 次的接口全局限速。

## 项目结构

```
2by/
├── docker-compose.yml        # LiveKit Server（Docker 方式启动用）
├── livekit.yaml              # LiveKit 配置（API key/secret、RTC 端口）
├── client/                   # SvelteKit + TypeScript + Tailwind v4（shadcn 风格）
│   ├── src/
│       ├── lib/
│       │   ├── api.ts                # 后端 API 客户端
│       │   ├── identity.ts           # 昵称存取（localStorage）
│       │   ├── audio-tuning.svelte.ts# 麦克风调校参数（localStorage 持久化）
│       │   ├── voice-processor.ts    # 语音处理链：低切/嘶声/压限/增益/RNNoise
│       │   ├── voice-room.svelte.ts  # LiveKit 房间控制器（核心）
│       │   └── ui/                   # shadcn 风格 UI 组件（手写）
│       └── routes/
│           ├── +page.svelte          # 大厅：昵称 / 创建房间 / 房间列表
│           └── room/[name]/          # 房间页：成员卡片 / 麦克风开关 / 说话高亮
│   └── scripts/
│       └── gen-certs.sh      # 一键生成开发用自签证书（首次本地部署用）
├── server/                   # Go + Gin 后端
│   ├── main.go               # 入口与路由
│   ├── token.go              # LiveKit 令牌签发 + 访问码门禁 + 健康检查
│   ├── store.go              # 房间/成员内存存储（map + RWMutex）
│   ├── handlers.go           # 房间创建/列表、账号接口
│   ├── auth.go               # 账号系统：注册/登录/会话/邮箱验证码（SQLite）
│   ├── security.go           # 访问码防爆破、接口限速、进房票据
│   ├── hub.go                # WebSocket 成员进出同步
│   └── tools/
│       ├── probe/            # 调试：查房间参与者
│       └── audiobot/         # 调试：带电平的测试音频机器人
└── deploy/                   # 打包/一键部署脚本（systemd + Caddy）
```

**账号系统（可选）**：注册/登录默认关闭，纯游客可用。`AUTH_REGISTER_ENABLED=true` 开放注册，`CREATE_REQUIRE_ACCOUNT=true` 创建房间需登录；配套邮箱验证码由 `MAIL_VERIFY_ENABLED` 控制。账号库为 SQLite（`AUTH_DB`，默认 `auth.db`），会话用 HttpOnly Cookie 承载。

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

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查（顺带探测 Go ↔ LiveKit 连通性） |
| GET | `/api/rooms` | 房间列表（含各房间在线成员，不含创建者信息） |
| POST | `/api/rooms` | 创建房间 `{"name": "房间名"}`，重名返回 409 |
| GET/POST | `/api/token` | 签发 LiveKit 令牌，`{room, name, code?}`；响应含进房票据 ticket（POST 推荐，码不进 URL） |
| GET | `/api/ip` | 调用方公网 IP（客户端经数据通道广播给房间成员展示） |
| GET | `/api/auth/me` | 当前登录账号 + 账号系统开关状态 |
| POST | `/api/auth/register` | 注册 `{email, password, nickname, code?}` |
| POST | `/api/auth/login` | 登录 `{email, password}` |
| POST | `/api/auth/logout` | 登出 |
| POST | `/api/auth/nickname` | 修改昵称（需登录） |
| POST | `/api/auth/password` | 修改密码（需登录，成功后全部会话失效） |
| POST | `/api/auth/send-code` | 发送邮箱验证码（`MAIL_VERIFY_ENABLED=true` 时可用） |
| GET | `/api/auth/my-rooms` | 我创建的房间（需登录，服务端按会话过滤） |
| GET | `/ws?room=xxx&name=yyy&ticket=zzz` | WebSocket：同步成员进出、广播房间列表 |

注册/登录/发码有每 IP 每分钟 10 次的限速；令牌接口每 IP 每分钟 60 次。

## 调试工具

```bash
# 查看某房间在 LiveKit 服务端的参与者
go run ./server/tools/probe "房间名"

# 模拟一名持续说话的参会者（发带 RFC6464 电平的 RTP 包，可触发"正在说话"高亮）
go run ./server/tools/audiobot "房间名" 60
```

## 已验证项

- [x] 令牌签发：JWT 权限为 `roomJoin + room + canPublish + canSubscribe`（2 小时有效）
- [x] 浏览器 ↔ 远端 LiveKit 真实 WebRTC 连接（两端均显示"语音已连接"）
- [x] 房间创建/列表/成员进出的实时同步（WebSocket 断开即移除成员）
- [x] "谁在说话"高亮（服务端说话人检测 → ActiveSpeakersChanged → UI 徽章，已用 audiobot 端到端验证）
- [x] 自动播放拦截的解锁路径（`room.startAudio()` + 手势按钮）
- [x] 麦克风开关与错误处理（拒绝授权时提示且不崩溃）

## 已知限制（按需求刻意不做）

- 无文字聊天、礼物、好友、房主权限、录制审核、移动端深度适配
- 本原型内嵌自动化浏览器（Electron WebView）不支持 `getUserMedia`，麦克风需用真实 Chrome 测试
- WS 的跨源校验默认放行（开发方便）；生产部署脚本会设置 `WS_ALLOWED_ORIGIN` 启用白名单
- 房间/成员仅存内存，进程重启即清空（账号库 `auth.db` 除外，SQLite 持久化）
- 房间页会向同房间成员广播自己的公网 IP（成员卡片"网络信息"弹窗），邀请链接可转发，介意者请知悉

## 部署到服务器

部署分两件事：**跑起来**（二选一）+ **反代与证书**（见下一节，无论哪种方式都一样）。

- **Docker 一键部署**（推荐，服务器只需 Docker + 外部 Caddy）：
  见 [deploy/docker/README.md](deploy/docker/README.md)，`docker compose up -d --build` 一条命令起全栈。
  布局二选一：**三容器**（默认，组件独立）或**单容器 all-in-one**（`compose.all-in-one.yaml`，最简）。
- **systemd 二进制部署**：完整分步指南见 [deploy/DEPLOY.md](deploy/DEPLOY.md)，
  或开发机 `bash deploy/push.sh root@服务器IP` 一条命令打包+上传+部署。

## 反向代理与 SSL 证书（生产必读）

### 先懂流量结构：三条反代规则

```
浏览器 ──https://域名或IP（443，TLS 在 Caddy 终止）──▶ Caddy 反代
    /             → 127.0.0.1:3000   SvelteKit 页面
    /api/*、/ws   → 127.0.0.1:8080   Go 后端（REST + 成员同步 WebSocket）
    /livekit/*    → 127.0.0.1:7880   LiveKit 信令（⚠ 必须剥掉 /livekit 前缀）
浏览器 ══ WebRTC 语音媒体直连 ══▶ 7881/TCP + 50000-50100/UDP（不经过反代）
```

为什么信令要走 `/livekit` 路径代理：HTTPS 页面禁止连 `ws://` 明文信令（混合内容），
前端会自动把信令地址改写成 `wss://当前域名/livekit`。而 LiveKit 不认识 `/livekit`
前缀，所以反代必须**剥前缀**转发（Caddy 用 `handle_path`；nginx 用结尾带斜杠的
`proxy_pass http://127.0.0.1:7880/`），否则信令 404。剥前缀后浏览器全程只信任
反代一个证书，LiveKit 本身**不需要任何 TLS 配置**；媒体流是 UDP/TCP 直连，也不经反代。

### SSL 证书四种方案（按你的条件对号入座）

**方案 A：有域名（推荐）——Caddy 自动签发 Let's Encrypt，零维护**

前提：域名 A 记录指向服务器，80/443 公网可达。`apt install caddy` 后写
`/etc/caddy/Caddyfile`：

```caddyfile
voice.example.com {
	encode gzip

	handle /api/* {
		reverse_proxy 127.0.0.1:8080
	}
	handle /ws {
		reverse_proxy 127.0.0.1:8080
	}
	# 必须用 handle_path：剥掉 /livekit 前缀，用 handle 会信令 404
	handle_path /livekit/* {
		reverse_proxy 127.0.0.1:7880
	}
	handle {
		reverse_proxy 127.0.0.1:3000
	}
}
```

`systemctl reload caddy` 即完成——签发和续期全自动，证书文件都不用找。

**方案 B：无域名、只有公网 IP——Let's Encrypt IP 证书（需 Caddy ≥ 2.10）**

Let's Encrypt 自 2026 年起给公网 IP 签发证书（6 天短时效，Caddy 自动续期）。
和方案 A 的差别只有两点：站点地址写 IP；`tls` 块里指定 `shortlived` 配置。
另外**必须加全局 `default_sni`**——客户端访问 IP 时不发送 SNI（RFC 规定），
缺了它 Caddy 选不出证书，TLS 握手直接失败，站点表现为完全连不上：

```caddyfile
{
	default_sni 203.0.113.10      # 换成你的公网 IP
}

203.0.113.10 {
	tls {
		issuer acme {
			dir https://acme-v02.api.letsencrypt.org/directory
			profile shortlived     # IP 证书只走这个配置；注意是 issuer 单数
		}
	}
	# 以下 handle 规则与方案 A 完全相同（照抄上面的四个 handle 块）
}
```

完整可抄文件：[deploy/docker/Caddyfile.ip-direct.example](deploy/docker/Caddyfile.ip-direct.example)。
签发是否成功看日志：`journalctl -u caddy | grep -i certificate` 出现
`certificate obtained successfully` 即成功。本项目 156 段服务器长期实测稳定。

**方案 C：已有证书文件（买的 / 云厂商免费送的）**

```caddyfile
voice.example.com {
	tls /etc/ssl/fullchain.pem /etc/ssl/privkey.pem
	# handle 规则同方案 A
}
```

**方案 D：纯内网（没域名没公网）——Caddy 自签**

站点地址写内网 IP，加一行 `tls internal`。浏览器首次访问点「高级 → 继续访问」
即可，HTTPS 依然成立，麦克风照常可用。开发机的证书生成见上文本地部署一节。

### 用 nginx？

等价配置在 [deploy/nginx/voicerooms.conf](deploy/nginx/voicerooms.conf)，与 Caddy
的差别要点：`/ws` 和 `/livekit/` 需要手动配 WebSocket 升级头
（`proxy_http_version 1.1` + `Upgrade`/`Connection` + 加大 `proxy_read_timeout`）；
`/livekit/` 的 `proxy_pass` 结尾**带斜杠**实现剥前缀；证书用 `ssl_certificate`
指令引用（Let's Encrypt 用 certbot 签发，或云厂商免费证书上传）。

### 防火墙放行清单（云安全组）

| 端口 | 协议 | 用途 | 对公网开放 |
|---|---|---|---|
| 80 / 443 | TCP | 页面 + API + 信令代理（兼 ACME 签发验证） | 是 |
| 7881 | TCP | WebRTC over TCP 回退 | 是 |
| 50000-50100 | UDP | 语音媒体流（**最常漏，漏了就是"连上但听不见"**） | 是 |
| 7880 / 8080 / 3000 | TCP | 信令/后端/页面源站 | **否**，只听 127.0.0.1 |

### 部署完验证

```bash
curl https://你的域名或IP/api/health
# 期望：{"go":"ok","livekit":"ok","activeRooms":0}
```

然后两台设备（一台正常窗口 + 一台无痕）进同一房间互听。听不见按顺序查：
安全组 UDP 50000-50100 → 双方都点过「打开麦克风」和「点击开启声音」。

## 常见问题

本地开发的问题见上文「本地常见问题速查」。服务器部署相关：

- **令牌报 `token is not valid yet`**：LiveKit 服务器与签发方时钟相差过大。同步时钟（`timedatectl set-ntp true` 或 `hwclock --hctosys`）。
- **能连上但互相听不见**：九成是云安全组没放行 **UDP 50000-50100**（TCP 7881 是回退通道）；双方都在严格 NAT 后时启用 TURN（见 `deploy/livekit.production.yaml` 注释）。
- **IP 直连部署握手失败/证书不匹配**：Caddy 配置缺 `default_sni`，见上文方案 B 与 [deploy/docker/Caddyfile.ip-direct.example](deploy/docker/Caddyfile.ip-direct.example) 的注释。
- **反代后信令 404**：`/livekit` 路径没剥前缀——Caddy 要用 `handle_path`，nginx 的 `proxy_pass` 结尾要带斜杠。
