# Docker 一键部署（全栈容器化）

三种布局任选其一（后两者端口相同，不要同时跑）：

| 布局 | 文件 | 适合 |
|---|---|---|
| 三容器（默认） | `compose.yaml` | 标准做法，组件独立、日志分明 |
| **单容器 all-in-one** | `compose.all-in-one.yaml` | 最简部署，一个镜像一条命令；家庭服务器/极简党 |
| systemd 二进制 | 上级目录 `deploy-linux.sh` | 不用 Docker 的裸机 |

## 三容器布局（默认）

三个服务（LiveKit 媒体、Go 后端、SvelteKit 前端）分别一个容器，
`docker compose up -d --build` 起全栈；宿主机保留一个**外部 Caddy**
做反代和 TLS。服务器上不需要装 Go/Node，只需要 Docker。

支持两种对外方式（反代配置二选一）：

- **有域名**：Caddy 自动签发/续期 Let's Encrypt 证书（`Caddyfile.example`）
- **只有公网 IP、没有域名**：申请 Let's Encrypt **IP 证书**（6 天短时效，
  Caddy 自动续期，需 Caddy ≥ 2.10，`Caddyfile.ip-direct.example`）

## 架构

```
浏览器
  │ https://域名-or-公网IP（443，宿主机 Caddy 终止 TLS）
  ▼
宿主机 Caddy（Docker 外部）
  ├─ /            → 127.0.0.1:3000  web 容器（SvelteKit）
  ├─ /api、/ws    → 127.0.0.1:8080  server 容器（Go）
  └─ /livekit/*   → 127.0.0.1:7880  livekit 容器（信令）
浏览器 ══ WebRTC 媒体直连 ══▶ 宿主机 7881/TCP + 50000-50100/UDP（端口映射进 livekit 容器）
```

页面/API/信令端口全部只绑定 `127.0.0.1`（外部无法绕过 Caddy 直连）；
只有媒体端口对公网开放。账号库 `auth.db` 持久化在 named volume `server-data`。

## 单容器 all-in-one 布局

三个服务打成一个镜像（`Dockerfile.all-in-one`），容器内由
`entrypoint-all-in-one.sh` 同时守护三个进程，**任一进程退出 → 整个容器退出 →
Docker restart 策略把三个一起拉起**（fail-fast，避免"半死"状态）。已在
Debian 13 + Docker 实测：三服务健康检查全绿，杀掉任一进程 2 秒内整容器退出。

```bash
# .env 与三容器方案共用同一份；只换 compose 文件
docker compose -f compose.all-in-one.yaml up -d --build
```

与三容器布局的差异：

- 镜像约 340MB（node 基础镜像 + 三件套）；环境变量、`.env`、反代、证书完全一致，
  仅内部互联从 `http://livekit:7880` 变成 `http://127.0.0.1:7880`（compose 已写好）；
- 对外端口发布规则不变：7881/TCP + UDP 段对公网，7880/8080/3000 只绑回环给 Caddy；
- 取舍：换来了"一条 docker run 也能跑"的最简心智模型，失去了按组件独立
  升级/扩缩容的能力（升级任何一部分都是整容器重建，语音会瞬断几秒）。
  个人/朋友自用无所谓；要认真运营建议三容器。

## 反代配置（二选一）

**方式一：有域名**——域名 A 记录指向服务器，80/443 放行，然后：

```bash
cp Caddyfile.example /etc/caddy/Caddyfile   # 改成你的域名
systemctl reload caddy                      # 证书自动签发 + 永久自动续期
```

**方式二：无域名、纯 IP 直连**——用的是 Let's Encrypt 2026 年起开放的
IP 证书能力（6 天短时效证书，Caddy 全自动续期）：

```bash
# 1. 确认 Caddy >= 2.10（老版本不认识 profile 指令；本项目 2.11.2 实测通过）
caddy version
#    不够就升级（注意 systemd 单元里 ExecStart 的二进制路径，apt 装的在 /usr/bin）：
#    curl -fsSL https://github.com/caddyserver/caddy/releases/download/v2.11.2/caddy_2.11.2_linux_amd64.tar.gz \
#      | tar -xz -C /usr/local/bin caddy

# 2. 写入配置（把里面的 IP 换成你的公网 IP）
cp Caddyfile.ip-direct.example /etc/caddy/Caddyfile
vim /etc/caddy/Caddyfile
systemctl reload caddy

# 3. 确认签发成功（日志出现 certificate obtained successfully）
journalctl -u caddy --since "2 min ago" | grep -i certificate
```

IP 方案的两个关键点（样例文件里有注释，这里说明原因）：

- **`default_sni` 全局项必须写**：客户端访问 IP 时不发送 SNI（RFC 规定），
  Caddy 没有 SNI 就选不出证书，TLS 握手直接报 internal error，
  站点表现为"完全连不上"。这是纯 IP 部署最常见的坑。
- **证书 6 天一换**：续期完全自动，但要求 80/443 的公网入站长期可达；
  服务器长时间离线会过期，开机联网后 Caddy 会立即续上。

## 部署步骤

**0. 服务器侧准备**

- 装好 Docker 和 compose 插件（`docker compose version` 能出版本号）
- 云安全组/防火墙放行：TCP 22 / 80 / 443 / 7881 + **UDP 50000-50100**
  （8080/3000/7880 只在本机回环，不用放行；IP 证书方案 80/443 还兼做签发验证）

**1. 反代**：按上面"反代配置"二选一配置好 Caddy

**2. 写配置并启动**

```bash
cp .env.example .env
vim .env          # 改域名或 IP（两处）+ 生成密钥（命令在 .env 注释里）
docker compose up -d --build
```

首次构建约 3-5 分钟（拉 Go/Node 镜像 + 编译）。之后改代码重新部署还是同一条命令。

**3. 验证**

```bash
docker compose ps                  # 三个容器 Up（healthy）
curl https://你的域名或IP/api/health   # {"go":"ok","livekit":"ok",...}
```

浏览器两个设备进同一房间互听。听不见先查安全组 UDP 50000-50100。

## 在 incus / LXC 容器里跑

把整套 Docker 部署放进 incus（LXD 系）系统容器也可以，两点区别：

**1. 必须开 nesting**，否则容器里 Docker 起不来：

```bash
incus launch images:debian/13 voice-rooms -c security.nesting=true
incus config set voice-rooms security.syscalls.intercept.mknod=true
```

**2. 外层宿主机（或上一层容器）用 proxy 设备把端口转进来**。
推荐把本目录整套（Docker + 三个容器）放进 incus 容器、Caddy 留在外层的布局
（反代和证书不用动，只转发端口）：

```bash
# 先停掉外层旧的 compose 栈（监听端口要让出来），再添加：
incus config device add voice-rooms p3000 proxy listen=tcp:127.0.0.1:3000 connect=tcp:127.0.0.1:3000
incus config device add voice-rooms p8080 proxy listen=tcp:127.0.0.1:8080 connect=tcp:127.0.0.1:8080
incus config device add voice-rooms p7880 proxy listen=tcp:127.0.0.1:7880 connect=tcp:127.0.0.1:7880
incus config device add voice-rooms rtc-tcp proxy listen=tcp:0.0.0.0:7881 connect=tcp:127.0.0.1:7881 nat=true
incus config device add voice-rooms rtc-udp proxy listen=udp:0.0.0.0:50000-50100 connect=udp:127.0.0.1:50000-50100 nat=true
```

要点：

- `connect` 里的 `127.0.0.1` 是 **incus 容器自己的回环**（incus-proxy 在容器
  命名空间里发起连接），不用关心容器的内网 IP；
- 媒体端口两端号码必须一致——LiveKit 靠 `use_external_ip: true` 用 STUN
  探测公网地址，公网入站端口号必须和它宣告的候选端口一致，任何一层改号语音就不通；
- **`nat=true` 必加**：纯 DNAT、保留客户端真实源 IP。不加的话源地址会被
  incus-proxy 改写，后端按 IP 限速/防爆破/X-Forwarded-For 全部失效；
- 若想让 incus 容器完全自包含（连 Caddy 一起搬进去），把 `Caddyfile*.example`
  放进容器内配置，外层只转发 80/443 + 两个媒体端口，然后停用外层 Caddy。

## 日常运维

```bash
docker compose logs -f server      # 看某个服务日志（server/web/livekit）
docker compose restart server      # 重启某个服务
docker compose up -d --build       # 更新代码后重新部署
docker compose down                # 停止（volume 保留，账号库不丢）
docker compose down -v             # 连账号库一起删（慎用）
```

**备份账号库**（注册用户都在里面）：

```bash
docker run --rm -v voice-rooms_server-data:/data -v $(pwd):/bak alpine \
	tar czf /bak/auth-backup.tar.gz -C /data auth.db
```

## 迁移到新机器

旧机器：`docker compose down`，拷走整个 `deploy/docker/` 目录（含 `.env`）+
备份的 `auth-backup.tar.gz`；新机器：装 Docker + Caddy，放进目录，
还原账号库到 volume，`docker compose up -d --build`。
若旧机器跑在 incus 里且用方案 A 自包含布局，直接 `incus export` 整个容器更快。

## 与 systemd 方式的取舍

| | Docker（本目录） | systemd（deploy-linux.sh） |
|---|---|---|
| 服务器依赖 | 只需 Docker + Caddy | Node 20 + LiveKit 二进制 + Caddy（脚本自动装） |
| 启动命令 | `docker compose up -d --build` | `push.sh` 一条命令（打包+上传+部署） |
| 证书 | 跟宿主机 Caddy 走（域名或 IP 证书均可） | 跟宿主机 Caddy 走 |
| 隔离性 | 容器隔离、非 root 运行 | 专用系统账号 |
| 升级 | 重新 build | 重新 push |
| 适用 | 已有 Docker 经验、想和环境解耦 | 全新裸机、想全自动 |

两种方式二选一，不要混用（端口会冲突：7880/8080/3000/7881/UDP 段）。
