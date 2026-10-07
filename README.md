# 回声室 voice-room

自建多人语音聊天室：替代 YY 的最小实现。**媒体层完全交给 [LiveKit](https://livekit.io)**
（SFU、WebRTC、Opus、回声消除全部不自己写），Go 后端只做令牌签发和房间成员同步，
SvelteKit 5 前端负责界面。设计给朋友间自建部署，一台 1C2G 的服务器即可承载。

## 功能

- 🎙️ **多人实时语音**：说话高亮、按人独立调音量、自动舒适音量、延迟与网络信息展示
- 🎵 **背景音乐**：上传音乐文件作为独立高保真音轨全房播放，支持播放列表/单曲循环/进度
- 🔇 **语音处理链**：低切、嘶声抑制、防炸压限、输入增益、RNNoise AI 降噪、唱歌/乐器音乐模式
- 🔐 **访问码门禁**：房间可设访问码，邀请链接带码免输（码不进服务器日志）；错 5 次锁 10 分钟
- 👤 **账号系统（可选）**：邮箱注册登录、验证码、可要求建房必须登录；默认游客即可玩
- 🌐 **无域名也能上生产**：Let's Encrypt IP 证书，纯公网 IP 直连 HTTPS

## 架构

```
浏览器 ──https──▶ Caddy 反代（443，TLS 终止）
                    ├─ /             → SvelteKit 页面    127.0.0.1:3000
                    ├─ /api、/ws     → Go 后端           127.0.0.1:8080
                    └─ /livekit/*    → LiveKit 信令      127.0.0.1:7880（剥前缀）
浏览器 ══ WebRTC 语音媒体直连（UDP 50000-50100 / TCP 7881）══▶ LiveKit，不经反代
```

## 快速开始（本地试玩）

前置：**Docker**、**Go 1.22+**、**Node 20+**。密钥端口全部有默认值，零配置：

```bash
git clone https://github.com/jiqing112/voice-room.git && cd voice-room
docker compose up -d                     # ① LiveKit 媒体服务器
cd server && go run .                    # ② Go 后端（127.0.0.1:8080）
cd ../client && npm install && npm run dev   # ③ 前端
```

打开 **http://localhost:5173** → 填房间名和昵称 → 进入 → 点「打开麦克风」。
两个浏览器窗口（一个无痕）进同一房间即可互听。

局域网手机互听需要 HTTPS 证书（一条脚本生成）等细节，见
**[docs/development.md](docs/development.md)**。

## 生产部署

四种方式反代与证书完全相同（见下一节），按手头条件选：

| 方式 | 服务器需要 | 怎么部署 | 适合 |
|---|---|---|---|
| ① Docker 三容器 | Docker | 见 [deploy/docker/README.md](deploy/docker/README.md) | **推荐** |
| ② Docker 单容器 | Docker | 同上，换 `-f compose.all-in-one.yaml` | 极简自用 |
| ③ 二进制 + systemd | 无（全自动安装） | 开发机 `bash deploy/push.sh root@服务器IP` | 裸机快速上线 |
| ④ 源码直跑 | Go + Node + LiveKit | 见 [docs/development.md](docs/development.md) | 临时演示 |

Docker 方式共三步：clone → `cp .env.example .env` 填域名（或公网 IP）和密钥 →
`docker compose up -d --build`。详细分步、运维、备份都在
[deploy/docker/README.md](deploy/docker/README.md)。

## 反向代理与 SSL 证书

反代（Caddy/nginx）只监听 443（80 做 HTTPS 跳转），把不同**路径**转发到本机**三个端口**：

| 浏览器发出的请求 | 反代转发到 | 端口上跑的是什么 | 说明 |
|---|---|---|---|
| `https://域名/` | `127.0.0.1:3000` | SvelteKit 页面 | 所有未匹配路径都归它 |
| `https://域名/api/rooms` | `127.0.0.1:8080` | Go 后端 REST API | 前缀原样透传 |
| `wss://域名/ws` | `127.0.0.1:8080` | Go 后端成员同步 WebSocket | 与 API 同端口，靠路径区分 |
| `wss://域名/livekit/rtc` | `127.0.0.1:7880`/`rtc` | LiveKit 信令 WebSocket | **必须剥掉 `/livekit` 前缀**，否则 404 |
| 语音媒体（不是网页请求） | 浏览器**直连** `7881/TCP + 50000-50100/UDP` | LiveKit 媒体 | **不经反代**，安全组直接放行 |

要点：反代只接触 **3000 / 8080 / 7880** 三个回环端口；**7881 和 UDP 段是媒体直连
端口，反代管不着**——这正是语音延迟低的原因，也是安全组必须单独放行它们的原因。

证书按条件四选一（Caddy 全自动，无需 certbot）：

| 条件 | 配法 |
|---|---|
| 有域名（推荐） | 站点地址写域名，Let's Encrypt 自动签发续期 |
| 无域名纯公网 IP | [IP 证书方案](deploy/docker/Caddyfile.ip-direct.example)：`shortlived` 配置 + 全局 `default_sni`，需 Caddy ≥ 2.10 |
| 已有证书文件 | `tls /路径/fullchain.pem /路径/privkey.pem` |
| 纯内网 | `tls internal` 自签，浏览器点一次「继续访问」 |

域名版完整 Caddyfile（其余方案只差 `tls` 块）：

<details>
<summary>点开查看 /etc/caddy/Caddyfile</summary>

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

</details>

用 nginx 的话等价配置如下（WebSocket 升级头三件套 + `/livekit/` 结尾斜杠剥前缀是两处最易错点）：

<details>
<summary>点开查看 /etc/nginx/conf.d/voicerooms.conf</summary>

```nginx
map $http_upgrade $connection_upgrade {
	default upgrade;
	''      close;
}

server {
	listen 443 ssl;
	http2 on;
	server_name voice.example.com;
	ssl_certificate     /etc/letsencrypt/live/voice.example.com/fullchain.pem;
	ssl_certificate_key /etc/letsencrypt/live/voice.example.com/privkey.pem;

	# 页面 → 3000
	location / {
		proxy_pass http://127.0.0.1:3000;
		proxy_set_header Host $host;
		proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
		proxy_set_header X-Forwarded-Proto $scheme;
	}
	# API → 8080
	location /api/ {
		proxy_pass http://127.0.0.1:8080;
		proxy_set_header Host $host;
		proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
	}
	# 成员同步 WebSocket → 8080（长连接要加大超时）
	location /ws {
		proxy_pass http://127.0.0.1:8080;
		proxy_http_version 1.1;
		proxy_set_header Upgrade $http_upgrade;
		proxy_set_header Connection $connection_upgrade;
		proxy_read_timeout 3600s;
	}
	# LiveKit 信令 → 7880；proxy_pass 结尾斜杠 = 剥掉 /livekit 前缀
	location /livekit/ {
		proxy_pass http://127.0.0.1:7880/;
		proxy_http_version 1.1;
		proxy_set_header Upgrade $http_upgrade;
		proxy_set_header Connection $connection_upgrade;
		proxy_read_timeout 3600s;
	}
}
# 80 → 443 跳转的 server 块见 deploy/nginx/voicerooms.conf
```

</details>

**防火墙**：放行 TCP 80/443/7881 + **UDP 50000-50100**（语音媒体，最常漏）；
7880/8080/3000 只听 127.0.0.1，不要放行。

**验证**：`curl https://域名或IP/api/health` 返回 `{"go":"ok","livekit":"ok"}`，
两台设备进房互听。

## API 速览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查（含 Go ↔ LiveKit 连通性） |
| GET | `/api/rooms` | 房间列表（含在线成员） |
| POST | `/api/token` | 签发 LiveKit 令牌 `{room, name, code?}`，响应含进房票据 |
| GET | `/api/ip` | 调用方公网 IP |
| GET/POST | `/api/auth/*` | 注册/登录/登出/me/改昵称/改密码/发验证码/我的房间 |
| GET | `/ws?room=&name=&ticket=` | WebSocket：成员进出同步、房间列表广播 |

## 常见问题

| 现象 | 处理 |
|---|---|
| `livekit: down` | LiveKit 没起，或 `LIVEKIT_HTTP_URL` / 密钥没配对 |
| `token is not valid yet` | 服务器时钟漂了：`timedatectl set-ntp true` |
| 能连上但听不见 | 九成是安全组没放行 UDP 50000-50100；都开麦且点过「开启声音」 |
| IP 直连握手失败 | Caddy 缺 `default_sni`，见 [IP 证书样例](deploy/docker/Caddyfile.ip-direct.example) |
| 反代后信令 404 | `/livekit` 没剥前缀：`handle_path` / `proxy_pass` 结尾带斜杠 |

更多见 [docs/development.md](docs/development.md)（本地）与 [deploy/](deploy/)（生产）。

## 项目结构

```
client/   SvelteKit 5 前端：大厅/房间页、语音处理链（RNNoise）、UI 组件
server/   Go + Gin 后端：令牌签发、房间存储、WS 同步、账号（SQLite）、防爆破
deploy/   部署全家桶：Docker 编排与文档、一键打包推送、systemd、反代样例
docs/     开发指南（本地联调细节、源码部署、调试工具）
```

## 已知限制

房间/成员仅存内存（重启清空，账号库除外）；无文字聊天、录制、房主权限；
房间内成员互相可见公网 IP（邀请链接可转发，介意者知悉）；WS 跨源校验生产
部署时由 `WS_ALLOWED_ORIGIN` 启用白名单。

## License

[MIT](LICENSE)
