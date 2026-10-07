// voice-rooms 后端入口。
//
// 架构原则（重要）：
//   - 音视频媒体层完全交给 LiveKit Server（Docker 运行），本服务不碰任何 WebRTC 细节；
//   - 本服务只做两件事：签发 LiveKit 访问令牌、用内存结构维护房间/成员并经 WebSocket 同步。
package main

import (
	"crypto/rand"
	"encoding/hex"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/gin-gonic/gin"
)

// config 全部来自环境变量，均有本地开发默认值，开箱即用
type config struct {
	// Go 服务监听端口
	HTTPPort string
	// LiveKit 的 API Key/Secret，必须与 livekit.yaml 里 keys 配置一致
	APIKey    string
	APISecret string
	// 返回给浏览器的 LiveKit 信令地址（浏览器直连媒体服务器）
	LiveKitURL string
	// Go 后端调用 LiveKit HTTP API 用的地址（健康检查用）
	LiveKitAPIURL string
}

func loadConfig() config {
	return config{
		HTTPPort:      envOr("PORT", "8080"),
		APIKey:        envOr("LIVEKIT_API_KEY", "devkey"),
		APISecret:     envOr("LIVEKIT_API_SECRET", "devkeysecret"),
		LiveKitURL:    envOr("LIVEKIT_URL", "ws://localhost:7880"),
		LiveKitAPIURL: envOr("LIVEKIT_HTTP_URL", "http://localhost:7880"),
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// envDur 读取时间段型环境变量（支持 Go duration 写法，如 90s / 2m）
func envDur(key string, fallback time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			return d
		}
		log.Printf("warn: 环境变量 %s=%q 不是合法的正时长，使用默认值 %s", key, v, fallback)
	}
	return fallback
}

// randHex 生成 n 字节的随机十六进制串，用于拼出唯一的参会者 identity
func randHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		// 系统熵源不可用属于致命错误，原型里直接 panic
		panic(err)
	}
	return hex.EncodeToString(b)
}

func main() {
	cfg := loadConfig()
	authCfg := loadAuthConfig()
	authStore := newUserStore(authCfg)
	store := NewRoomStore()
	guard := newBruteGuard()
	limiter := newGlobalLimiter(globalPerMinute, time.Minute)
	// 认证类接口单独一道更紧的限速：注册/登录/发码此前不限速，
	// 密码爆破只被 PBKDF2 的全量哈希拖慢（顺带烧服务器 CPU）
	authLimiter := newGlobalLimiter(authPerMinute, time.Minute)
	authRateLimit := func(c *gin.Context) {
		if !authLimiter.Allow(c.ClientIP()) {
			c.Header("Retry-After", "60")
			c.JSON(http.StatusTooManyRequests, gin.H{"error": "请求太频繁，请稍后再试"})
			return
		}
		c.Next()
	}
	tickets := newTicketStore(ticketTTL)
	hub := NewHub(store, guard, tickets)

	// 空房间自动注销：没人且超过阈值未活动即清理（可按部署环境调整）
	go hub.RunJanitor(envDur("ROOM_SWEEP_EVERY", 30*time.Second), envDur("ROOM_IDLE_TTL", time.Minute))

	r := gin.Default()
	// 只信任本机反代（nginx/caddy）传来的 X-Forwarded-For，
	// 这样限速/防爆破才能拿到真实客户端 IP
	_ = r.SetTrustedProxies([]string{"127.0.0.1"})

	// WebSocket 跨源校验：设置了 WS_ALLOWED_ORIGIN（如 https://your-domain.com）
	// 就只放行该来源；未设置（本地开发）放行所有。生产环境务必设置！
	if allowed := os.Getenv("WS_ALLOWED_ORIGIN"); allowed != "" {
		upgrader.CheckOrigin = func(req *http.Request) bool {
			return req.Header.Get("Origin") == allowed
		}
	}

	// 接口一览：
	// GET  /api/health  健康检查（顺带探测 Go 后端 ↔ LiveKit 连通性）
	// GET  /api/rooms   房间列表（含各房间在线成员）
	// POST /api/rooms   创建房间
	// GET  /api/token   签发 LiveKit 令牌（进房凭证）
	// GET  /api/ip      调用方公网 IP（客户端经数据通道广播给房间成员展示）
	// GET  /ws          WebSocket：同步房间成员进出 + 广播房间列表
	r.GET("/api/health", healthCheck(cfg))
	// 把账号存储注入请求上下文（handlers 里 currentAccount 读取）
	r.Use(func(c *gin.Context) {
		c.Set("authStore", authStore)
		c.Next()
	})
	r.GET("/api/rooms", listRooms(store))
	r.POST("/api/rooms", createRoom(store, hub, authStore))
	r.GET("/api/token", guard.requireNotBlocked(), issueToken(cfg, store, guard, limiter, tickets, authStore, authCfg))
	r.POST("/api/token", guard.requireNotBlocked(), issueToken(cfg, store, guard, limiter, tickets, authStore, authCfg))
	// 账号系统：注册/登录/登出/me；send-code 仅在 MAIL_VERIFY_ENABLED=true 时可用。
	// 注册/登录/发码是无鉴权接口，套上独立的认证限速
	r.POST("/api/auth/register", authRateLimit, authStore.handleRegister())
	r.POST("/api/auth/login", authRateLimit, authStore.handleLogin())
	r.POST("/api/auth/logout", authStore.handleLogout())
	r.GET("/api/auth/me", authStore.handleMe())
	r.POST("/api/auth/nickname", authStore.handleUpdateNickname())
	r.POST("/api/auth/password", authStore.handleUpdatePassword())
	r.POST("/api/auth/send-code", authRateLimit, authStore.handleSendCode())
	r.GET("/api/auth/my-rooms", myRooms(store))
	r.GET("/api/ip", func(c *gin.Context) {
		// 与令牌接口共享每 IP 限速预算：这是个无鉴权的公开回显接口，
		// 不设防会被当免费 IP 回显服务滥用
		if !limiter.Allow(c.ClientIP()) {
			c.Header("Retry-After", "60")
			c.JSON(http.StatusTooManyRequests, gin.H{"error": "请求太频繁，请稍后再试"})
			return
		}
		c.Next()
	}, clientIP())
	r.GET("/ws", hub.HandleWS)

	// 只监听回环地址：外部流量全部经同机反代（nginx/caddy）进来，
	// 直接暴露 8080 会绕过反代的 TLS/日志/来源控制，也给访问码爆破留旁路。
	// 容器部署例外：Docker 端口发布的流量走容器网卡而非容器回环，
	// 因此 compose 里设 HOST=0.0.0.0（反正只发布到宿主机 127.0.0.1）
	listenHost := envOr("HOST", "127.0.0.1")
	log.Printf("Go 后端已启动: http://%s:%s （LiveKit 信令地址: %s）", listenHost, cfg.HTTPPort, cfg.LiveKitURL)
	log.Printf("开发期前端由 Vite 把 /api 与 /ws 代理到本端口，因此无需 CORS 配置")
	if err := r.Run(listenHost + ":" + cfg.HTTPPort); err != nil {
		log.Fatal(err)
	}
}
