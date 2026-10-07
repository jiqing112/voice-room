package main

import (
	"errors"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
)

// validateRoomName 房间名统一校验（建房接口与令牌接口共用）：
// 1~64 个字符（按 Unicode 字符数），不含 URL 路径敏感字符与控制字符
func validateRoomName(name string) bool {
	if name == "" || utf8.RuneCountInString(name) > 64 {
		return false
	}
	if strings.ContainsAny(name, "/?#") {
		// 房间名会出现在 URL 路径里，避开路径敏感字符
		return false
	}
	for _, r := range name {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

// —— 账号接口：注册/登录/登出/me（会话用 HttpOnly Cookie 承载）——

const sessionCookieName = "echo_session"

func currentAccount(c *gin.Context) (Account, bool) {
	if tok, err := c.Cookie(sessionCookieName); err == nil && tok != "" {
		if a, ok := c.MustGet("authStore").(*userStore).UserBySession(tok); ok {
			return a, true
		}
	}
	return Account{}, false
}

// requireAccount 创建类接口的登录门槛
func requireAccount() gin.HandlerFunc {
	return func(c *gin.Context) {
		if _, ok := currentAccount(c); !ok {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "创建房间需要先注册登录", "needsAccount": true})
			return
		}
		c.Next()
	}
}

// handleRegister POST /api/auth/register {email, password, nickname, code?}
// 账号系统开关（AUTH_REGISTER_ENABLED）关闭时返回 403
func (s *userStore) handleRegister() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !s.cfg.registerEnabled {
			c.JSON(http.StatusForbidden, gin.H{"error": "账号系统未开启，如需账号请联系管理员"})
			return
		}
		var body struct{ Email, Password, Nickname, Code string }
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "请求体需要是 {email,password,nickname,code?}"})
			return
		}
		token, acc, err := s.Register(body.Email, body.Password, body.Nickname, body.Code, c.ClientIP())
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		c.Header("Set-Cookie", s.sessionCookie(token, int(sessionTTL.Seconds())))
		c.JSON(http.StatusOK, gin.H{"user": acc})
	}
}

// handleLogin POST /api/auth/login {email, password}
func (s *userStore) handleLogin() gin.HandlerFunc {
	return func(c *gin.Context) {
		var body struct{ Email, Password string }
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "请求体需要是 {email,password}"})
			return
		}
		token, acc, err := s.Login(body.Email, body.Password, c.ClientIP())
		if err != nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": err.Error()})
			return
		}
		c.Header("Set-Cookie", s.sessionCookie(token, int(sessionTTL.Seconds())))
		c.JSON(http.StatusOK, gin.H{"user": acc})
	}
}

// handleSendCode POST /api/auth/send-code {email}（仅账号系统开启且 MAIL_VERIFY_ENABLED=true 时可用）
func (s *userStore) handleSendCode() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !s.cfg.registerEnabled {
			c.JSON(http.StatusForbidden, gin.H{"error": "账号系统未开启"})
			return
		}
		var body struct{ Email string }
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "请求体需要是 {email}"})
			return
		}
		if err := s.SendCode(body.Email, c.ClientIP()); err != nil {
			status := http.StatusBadRequest
			if errors.Is(err, errRateLimited) {
				status = http.StatusTooManyRequests
			}
			c.JSON(status, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"sent": true})
	}
}

func (s *userStore) handleLogout() gin.HandlerFunc {
	return func(c *gin.Context) {
		if tok, err := c.Cookie(sessionCookieName); err == nil {
			s.Logout(tok)
		}
		c.Header("Set-Cookie", s.sessionCookie("", -1))
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// handleUpdatePassword POST /api/auth/password {oldPassword,newPassword}（需登录）：
// 修改密码。成功后该账号全部会话失效（含当前会话），前端引导重新登录
func (s *userStore) handleUpdatePassword() gin.HandlerFunc {
	return func(c *gin.Context) {
		tok, err := c.Cookie(sessionCookieName)
		if err != nil || tok == "" {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "请先登录"})
			return
		}
		acc, ok := s.UserBySession(tok)
		if !ok {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "请先登录"})
			return
		}
		var body struct{ OldPassword, NewPassword string }
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "请求体需要是 {oldPassword,newPassword}"})
			return
		}
		if err := s.UpdatePassword(acc.Email, body.OldPassword, body.NewPassword); err != nil {
			status := http.StatusBadRequest
			if errors.Is(err, errBadCredentials) {
				status = http.StatusUnauthorized
			}
			// 只有成功才登出；"当前密码不对/新密码太短"这类失败不能带 loggedOut，
			// 否则用户只是打错了旧密码，前端却当成会话已失效
			c.JSON(status, gin.H{"error": err.Error()})
			return
		}
		c.Header("Set-Cookie", s.sessionCookie("", -1))
		c.JSON(http.StatusOK, gin.H{"ok": true, "loggedOut": true})
	}
}

// handleUpdateNickname POST /api/auth/nickname {nickname}（需登录）：
// 修改账号昵称——它同时是加入房间时的默认展示昵称
func (s *userStore) handleUpdateNickname() gin.HandlerFunc {
	return func(c *gin.Context) {
		tok, err := c.Cookie(sessionCookieName)
		if err != nil || tok == "" {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "请先登录"})
			return
		}
		acc, ok := s.UserBySession(tok)
		if !ok {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "请先登录"})
			return
		}
		var body struct{ Nickname string }
		if err := c.ShouldBindJSON(&body); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "请求体需要是 {nickname}"})
			return
		}
		nick := strings.TrimSpace(body.Nickname)
		if nick == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "昵称不能为空"})
			return
		}
		if utf8.RuneCountInString(nick) > 32 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "昵称最长 32 个字符"})
			return
		}
		if _, err := s.db.Exec(`UPDATE users SET nickname=? WHERE id=?`, nick, acc.ID); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "保存失败"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"user": Account{ID: acc.ID, Email: acc.Email, Nickname: nick}})
	}
}

func (s *userStore) handleMe() gin.HandlerFunc {
	return func(c *gin.Context) {
		var user *Account
		if tok, err := c.Cookie(sessionCookieName); err == nil && tok != "" {
			if a, ok := s.UserBySession(tok); ok {
				user = &a
			}
		}
		// 配置开关一并下发：前端据此显示/隐藏登录入口和创建门槛
		c.JSON(http.StatusOK, gin.H{
			"user":                 user,
			"mailVerify":           s.cfg.mailVerify,
			"registerEnabled":      s.cfg.registerEnabled,
			"createRequireAccount": s.cfg.createRequireAccount,
		})
	}
}

// listRooms GET /api/rooms：返回房间列表（含每个房间的在线成员）
func listRooms(store *RoomStore) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"rooms": store.List()})
	}
}

// myRooms GET /api/auth/my-rooms：当前登录账号创建的房间。
// 需要登录，服务端按会话身份过滤——替代旧版"公开列表带 creator 邮箱、
// 客户端自行匹配"的做法（那会把所有建房者的邮箱暴露给任何访客）
func myRooms(store *RoomStore) gin.HandlerFunc {
	return func(c *gin.Context) {
		acc, ok := currentAccount(c)
		if !ok {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "请先登录"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"rooms": store.RoomsByCreator(acc.Email)})
	}
}

// clientIP GET /api/ip：返回调用方的公网 IP。
// 反代（nginx/caddy 同机）会写 X-Forwarded-For，gin 只信任 127.0.0.1，
// ClientIP 拿到的就是真实来源。客户端拿到后经 LiveKit 数据通道广播给
// 房间成员，用于成员卡片"网络信息"小弹窗的展示。
func clientIP() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ip": c.ClientIP()})
	}
}

type createRoomReq struct {
	Name     string `json:"name"`
	Password string `json:"password"` // 可选访问码
}

// createRoom POST /api/rooms {"name": "房间名", "password": "可选访问码"}
// 仅注册用户可创建（会话 Cookie 鉴权）。注意：页面的"进入即创建"走的是
// /api/token 的兜底建房，同样受账号门槛约束；这个接口主要供脚本/管理用。
// 创建成功后广播房间列表——否则大厅的列表要等下一次成员进出才会刷新
func createRoom(store *RoomStore, hub *Hub, auth *userStore) gin.HandlerFunc {
	return func(c *gin.Context) {
		// 创建门槛由 CREATE_REQUIRE_ACCOUNT 环境变量控制：
		// 关闭（当前）= 游客可自由建房；开启 = 必须登录账号
		var creator string
		if auth.cfg.createRequireAccount {
			acc, ok := currentAccount(c)
			if !ok {
				c.JSON(http.StatusUnauthorized, gin.H{"error": "创建房间需要先注册登录", "needsAccount": true})
				return
			}
			creator = acc.Email
		}
		var req createRoomReq
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": `请求体需要是 {"name": "房间名"}`})
			return
		}
		name := strings.TrimSpace(req.Name)
		if !validateRoomName(name) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "房间名长度需在 1~64 个字符之间，且不能包含 / ? # 字符"})
			return
		}
		if utf8.RuneCountInString(req.Password) > 32 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "访问码最长 32 个字符"})
			return
		}
		if err := store.Create(name, strings.TrimSpace(req.Password), creator); errors.Is(err, ErrRoomExists) {
			c.JSON(http.StatusConflict, gin.H{"error": "房间已存在，可以直接加入"})
			return
		}
		hub.broadcastRooms()
		c.JSON(http.StatusCreated, gin.H{"name": name, "hasPassword": req.Password != ""})
	}
}
