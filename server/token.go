package main

import (
	"context"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/livekit/protocol/auth"
	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
)

// issueToken 签发 LiveKit 访问令牌。
//
// 支持 POST（JSON body，推荐——访问码不会出现在 URL 和访问日志里）
// 与 GET（查询串，兼容手工调试）。响应额外携带一张进房票据（ticket），
// 前端连成员同步 WS 时凭票接入，访问码同样不必进 WS 查询串。
//
// 访问码校验顺序：
//  1. 房间不存在 → 以传入的 code（可为空）创建房间并发令牌（"进入即创建"）
//  2. 房间存在且无访问码 → 直接发令牌
//  3. 房间存在且有访问码 → code 必须精确匹配；错误计入防爆破计数，
//     同一 IP 对同一房间错 5 次锁 10 分钟（见 security.go）
func issueToken(cfg config, store *RoomStore, guard *bruteGuard, limiter *globalLimiter, tickets *ticketStore, authStore *userStore, authCfg authConfig) gin.HandlerFunc {
	return func(c *gin.Context) {
		// 全局限速：单 IP 高频扫接口直接 429
		if !limiter.Allow(c.ClientIP()) {
			c.Header("Retry-After", "60")
			c.JSON(http.StatusTooManyRequests, gin.H{"error": "请求太频繁，请稍后再试"})
			return
		}

		var roomName, displayName, code string
		if c.Request.Method == http.MethodPost {
			var body struct{ Room, Name, Code string }
			if err := c.ShouldBindJSON(&body); err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": `请求体需要是 {"room","name","code?"}`})
				return
			}
			roomName, displayName, code = strings.TrimSpace(body.Room), strings.TrimSpace(body.Name), body.Code
		} else {
			roomName = strings.TrimSpace(c.Query("room"))
			displayName = strings.TrimSpace(c.Query("name"))
			code = c.Query("code")
		}
		if roomName == "" || displayName == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "room 和 name 参数不能为空"})
			return
		}
		// 与建房接口同一套校验（此前只有建房接口校验，令牌路径能绕过长名/特殊字符限制）
		if !validateRoomName(roomName) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "房间名长度需在 1~64 个字符之间，且不能包含 / ? # 字符"})
			return
		}
		if utf8.RuneCountInString(displayName) > 32 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "昵称最长 32 个字符"})
			return
		}
		if utf8.RuneCountInString(code) > 32 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "访问码最长 32 个字符"})
			return
		}

		// 爆破封锁检查放在这里（而非 requireNotBlocked 中间件）：
		// 中间件从 URL 查询参数取房间名，而前端走 POST+JSON body，
		// 查询参数里没有 room——封锁此前从未对 POST 请求生效过
		if blocked, remain := guard.Blocked(c.ClientIP(), roomName); blocked {
			c.Header("Retry-After", remain.Round(time.Second).String())
			c.JSON(http.StatusTooManyRequests, gin.H{
				"error":     "访问码错误次数过多，请 " + remain.Round(time.Minute).String() + " 后再试",
				"needsCode": true,
			})
			return
		}

		// —— 创建房间是否需要登录：由 CREATE_REQUIRE_ACCOUNT 环境变量控制 ——
		// 开启时，"进入即创建"的兜底路径也要登录账号（前端据此弹注册/登录框）；
		// 关闭（游客模式）时任何人可建房。已存在的房间游客照常可加入，不受影响。
		// 账号查询无副作用，提到门禁之前：原子建房时需要带上创建者身份
		var creator string
		hasAccount := false
		if tok, err := c.Cookie(sessionCookieName); err == nil && tok != "" {
			if a, ok := authStore.UserBySession(tok); ok {
				creator, hasAccount = a.Email, true
			}
		}
		if !hasAccount && authCfg.createRequireAccount && !store.Exists(roomName) {
			c.JSON(http.StatusUnauthorized, gin.H{
				"error":        "创建房间需要先注册登录",
				"needsAccount": true,
			})
			return
		}

		// 访问码门禁 + 兜底建房（同一把锁内原子完成，见 store.JoinOrCreate）；
		// 校验失败计入防爆破，成功则清零
		if !store.JoinOrCreate(roomName, code, creator) {
			guard.RecordFail(c.ClientIP(), roomName)
			c.JSON(http.StatusForbidden, gin.H{
				"error":     "访问码不对",
				"needsCode": true,
			})
			return
		}
		guard.Reset(c.ClientIP(), roomName)

		// LiveKit 用 identity 标识参会者：同一房间里两个相同 identity 的连接，
		// 后连上的会把先连的"挤下线"。所以 identity 拼上随机后缀保证唯一，
		// 昵称通过 SetName 传给 SDK，前端展示用 name 而不是 identity。
		identity := displayName + "-" + randHex(4)

		canPublish := true
		canSubscribe := true
		token := auth.NewAccessToken(cfg.APIKey, cfg.APISecret).
			SetVideoGrant(&auth.VideoGrant{
				RoomJoin:     true,
				Room:         roomName,
				CanPublish:   &canPublish,
				CanSubscribe: &canSubscribe,
			}).
			SetIdentity(identity).
			SetName(displayName).
			SetValidFor(2 * time.Hour) // 原型令牌 2 小时过期，够一次联调

		jwt, err := token.ToJWT()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "签发令牌失败: " + err.Error()})
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"token":    jwt,            // LiveKit 访问令牌，前端 room.connect() 时使用
			"url":      cfg.LiveKitURL, // 浏览器要连的 LiveKit 信令地址
			"room":     roomName,
			"identity": identity,
			"name":     displayName,
			"ticket":   tickets.Issue(roomName), // 进房票据：WS 凭票接入，码不进查询串
		})
	}
}

// healthCheck 健康检查：用 server-sdk-go 的 RoomServiceClient 调一次 LiveKit 的
// ListRooms 接口，顺带验证 Go 后端 ↔ LiveKit 的 key/secret/网络是否配对。
// 本地联调建议先跑通这个接口。
func healthCheck(cfg config) gin.HandlerFunc {
	// RoomServiceClient 是 server-sdk-go 提供的服务端管理客户端（内部自动签管理 JWT）
	client := lksdk.NewRoomServiceClient(cfg.LiveKitAPIURL, cfg.APIKey, cfg.APISecret)
	return func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c.Request.Context(), 3*time.Second)
		defer cancel()
		resp, err := client.ListRooms(ctx, &livekit.ListRoomsRequest{})
		if err != nil {
			c.JSON(http.StatusOK, gin.H{"go": "ok", "livekit": "down", "error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"go": "ok", "livekit": "ok", "activeRooms": len(resp.Rooms)})
	}
}
