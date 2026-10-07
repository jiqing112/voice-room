package main

import (
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// ============ 防爆破与限速（内存实现，原型够用） ============
//
// 三层防线：
//   1. globalLimiter：每 IP 对令牌接口的全局限速，防止高频扫接口
//   2. bruteGuard：每 (IP, 房间) 的访问码错误计数，5 次错误锁 10 分钟
//   3. ticketStore：进房票据——令牌签发成功时发放，WS 凭票接入，
//      这样访问码不必出现在 WS 查询串里（查询串会进访问日志）

const (
	bruteMaxFails   = 5                // 窗口内允许的错误次数
	bruteWindow     = 10 * time.Minute // 错误计数窗口
	bruteBlockFor   = 10 * time.Minute // 触发后的封锁时长
	globalPerMinute = 60               // 每 IP 每分钟最多请求令牌次数
	authPerMinute   = 10               // 每 IP 每分钟认证类（注册/登录/发码）请求上限
	ticketTTL       = 30 * time.Minute // 进房票据有效期（可重复使用，供 WS 断线重连）
)

// ---- 访问码爆破防护 ----

type failRecord struct {
	count        int
	firstAt      time.Time
	blockedUntil time.Time
}

type bruteGuard struct {
	mu    sync.Mutex
	fails map[string]*failRecord
}

func newBruteGuard() *bruteGuard {
	return &bruteGuard{fails: make(map[string]*failRecord)}
}

// Blocked 返回该 (ip, room) 是否处于封锁期，以及剩余时长
func (g *bruteGuard) Blocked(ip, room string) (bool, time.Duration) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.pruneLocked(time.Now())
	rec, ok := g.fails[g.key(ip, room)]
	if !ok {
		return false, 0
	}
	if time.Now().Before(rec.blockedUntil) {
		return true, time.Until(rec.blockedUntil)
	}
	return false, 0
}

// RecordFail 记一次错误；窗口内累计到阈值就封锁
func (g *bruteGuard) RecordFail(ip, room string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := time.Now()
	g.pruneLocked(now)
	key := g.key(ip, room)
	rec, ok := g.fails[key]
	// 无记录或窗口已过：重新计数
	if !ok || now.Sub(rec.firstAt) > bruteWindow {
		g.fails[key] = &failRecord{count: 1, firstAt: now}
		return
	}
	rec.count++
	if rec.count >= bruteMaxFails {
		rec.blockedUntil = now.Add(bruteBlockFor)
	}
}

// Reset 验证成功后清零计数
func (g *bruteGuard) Reset(ip, room string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.fails, g.key(ip, room))
}

func (g *bruteGuard) key(ip, room string) string { return ip + "|" + room }

// pruneLocked 清理过期记录，防止 map 随时间无限增长（调用方持锁）
func (g *bruteGuard) pruneLocked(now time.Time) {
	for k, rec := range g.fails {
		if now.Sub(rec.firstAt) > bruteWindow && now.After(rec.blockedUntil) {
			delete(g.fails, k)
		}
	}
}

// ---- 令牌接口全局限速（固定窗口计数，原型足够） ----

type globalLimiter struct {
	mu     sync.Mutex
	hits   map[string]*windowCount
	limit  int
	window time.Duration
}

type windowCount struct {
	count int
	start time.Time
}

func newGlobalLimiter(limit int, window time.Duration) *globalLimiter {
	return &globalLimiter{hits: make(map[string]*windowCount), limit: limit, window: window}
}

// Allow 报告一次请求；返回是否放行
func (l *globalLimiter) Allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	// 偶发清理过期窗口，防止 map 随独特 IP 数无限增长
	if len(l.hits) > 4096 {
		for k, wc := range l.hits {
			if now.Sub(wc.start) > l.window {
				delete(l.hits, k)
			}
		}
	}
	wc, ok := l.hits[ip]
	if !ok || now.Sub(wc.start) > l.window {
		l.hits[ip] = &windowCount{count: 1, start: now}
		return true
	}
	wc.count++
	return wc.count <= l.limit
}

// ---- 进房票据：替代在 WS 查询串里明文传访问码 ----

type ticketEntry struct {
	room string
	exp  time.Time
}

type ticketStore struct {
	mu      sync.Mutex
	tickets map[string]ticketEntry
	ttl     time.Duration
}

func newTicketStore(ttl time.Duration) *ticketStore {
	return &ticketStore{tickets: make(map[string]ticketEntry), ttl: ttl}
}

// Issue 为房间签发一张进房票据（随令牌一起返回给前端）
func (t *ticketStore) Issue(room string) string {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := time.Now()
	// 顺手清理过期票据
	for k, e := range t.tickets {
		if now.After(e.exp) {
			delete(t.tickets, k)
		}
	}
	ticket := randHex(16)
	t.tickets[ticket] = ticketEntry{room: room, exp: now.Add(t.ttl)}
	return ticket
}

// Validate 校验票据是否对应该房间且未过期（票据在有效期内可重复使用，支撑断线重连）
func (t *ticketStore) Validate(ticket, room string) bool {
	if ticket == "" {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	e, ok := t.tickets[ticket]
	return ok && e.room == room && time.Now().Before(e.exp)
}

// requireNotBlocked 中间件式的检查：被封锁直接 429，写好 Retry-After
func (g *bruteGuard) requireNotBlocked() gin.HandlerFunc {
	return func(c *gin.Context) {
		ip := c.ClientIP()
		room := c.Query("room")
		if blocked, remain := g.Blocked(ip, room); blocked {
			c.Header("Retry-After", remain.Round(time.Second).String())
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{
				"error":     "访问码错误次数过多，请 " + remain.Round(time.Minute).String() + " 后再试",
				"needsCode": true,
			})
			return
		}
		c.Next()
	}
}
