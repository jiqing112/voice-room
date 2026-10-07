package main

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

// wsClient 代表一条 WebSocket 连接。
// room 为空 → 大厅监听者：只接收房间列表广播；
// room 非空 → 房间内连接：同时代表一名在线成员（连接断开即离房）。
type wsClient struct {
	conn     *websocket.Conn
	send     chan []byte
	room     string
	memberID string
	name     string
}

var upgrader = websocket.Upgrader{
	// 原型不校验 Origin（开发期前端走 Vite 代理）。生产环境必须改成域名白名单！
	CheckOrigin: func(r *http.Request) bool { return true },
}

// Hub 维护所有 WebSocket 连接，负责两种广播：
//  1. 房间列表变化 → 广播给所有连接（大厅页实时刷新各房间人数）
//  2. 房间成员进出 → 广播给订阅该房间的连接（房间页显示"xx 加入了/离开了"）
type Hub struct {
	store   *RoomStore
	guard   *bruteGuard
	tickets *ticketStore
	mu      sync.Mutex
	clients map[*wsClient]struct{}
}

func NewHub(store *RoomStore, guard *bruteGuard, tickets *ticketStore) *Hub {
	return &Hub{store: store, guard: guard, tickets: tickets, clients: make(map[*wsClient]struct{})}
}

// HandleWS 处理 GET /ws?room=xxx&name=yyy&ticket=zzz
// （ticket 由 /api/token 签发；兼容旧的 code 参数口径）
func (h *Hub) HandleWS(c *gin.Context) {
	roomName := c.Query("room")
	name := c.Query("name")
	code := c.Query("code")
	if roomName != "" && name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "带 room 参数时必须同时带 name"})
		return
	}
	// 长度护栏（按字符数，与令牌接口口径一致）：正常前端远小于此，
	// 直接手搓 WS 连接时别想把超长昵称/访问码塞进查询串
	if utf8.RuneCountInString(name) > 32 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "昵称最长 32 个字符"})
		return
	}
	if utf8.RuneCountInString(code) > 32 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "访问码最长 32 个字符"})
		return
	}
	if utf8.RuneCountInString(roomName) > 64 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "房间名过长"})
		return
	}

	// 访问码门禁：优先凭进房票据（令牌签发时发放，码不进查询串/日志），
	// 无票则退回访问码校验（与令牌口径一致，错误计入防爆破）。
	// 房间不存在时直接拒绝——WS 不负责"进入即创建"，那要经过令牌接口的码校验
	if roomName != "" {
		if blocked, remain := h.guard.Blocked(c.ClientIP(), roomName); blocked {
			c.Header("Retry-After", remain.Round(time.Second).String())
			c.JSON(http.StatusTooManyRequests, gin.H{"error": "访问码错误次数过多，请稍后再试"})
			return
		}
		if ticket := c.Query("ticket"); ticket != "" && h.tickets.Validate(ticket, roomName) {
			// 凭有效票据接入
		} else {
			exists, ok := h.store.CheckPassword(roomName, code)
			if !exists {
				c.JSON(http.StatusForbidden, gin.H{"error": "房间不存在或已注销", "needsCode": true})
				return
			}
			if !ok {
				// 空码尝试不计入爆破（页面首次加载的正常探测），错码才计
				if code != "" {
					h.guard.RecordFail(c.ClientIP(), roomName)
				}
				c.JSON(http.StatusForbidden, gin.H{"error": "访问码不对", "needsCode": true})
				return
			}
			h.guard.Reset(c.ClientIP(), roomName)
		}
	}

	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		// Upgrade 失败时响应已写回，这里只需放弃
		return
	}
	client := &wsClient{conn: conn, send: make(chan []byte, 16), room: roomName, name: name}

	if roomName != "" {
		// 进房：登记成员。成员身份与这条 WS 连接同生共死——
		// 关标签页、断网、主动离开都会走到本函数结尾的清理逻辑。
		m := h.store.AddMember(roomName, name)
		client.memberID = m.ID
	}
	h.mu.Lock()
	h.clients[client] = struct{}{}
	h.mu.Unlock()

	// 先给新连接发一份当前快照（房间列表 + 该房间成员），再广播"列表变了"
	h.sendTo(client, h.snapshot(client))
	h.broadcastRooms()
	if roomName != "" {
		h.broadcastRoomMembers(roomName)
	}

	go h.writePump(client)
	h.readPump(client) // 阻塞，直到连接断开

	// —— 连接已断开：离房 → 移除成员 → 广播。——
	// 这就是"离开房间自动从成员列表移除"的服务端实现。
	if roomName != "" && client.memberID != "" {
		h.store.RemoveMember(roomName, client.memberID)
	}
	h.mu.Lock()
	delete(h.clients, client)
	close(client.send)
	h.mu.Unlock()
	h.broadcastRooms()
	if roomName != "" {
		h.broadcastRoomMembers(roomName)
	}
}

// RunJanitor 周期性清理空闲房间（没人且超过 maxIdle 未活动），
// 有清理动作就广播最新房间列表，让所有大厅实时收敛。
func (h *Hub) RunJanitor(every, maxIdle time.Duration) {
	ticker := time.NewTicker(every)
	defer ticker.Stop()
	for range ticker.C {
		if removed := h.store.SweepIdle(maxIdle); len(removed) > 0 {
			log.Printf("已注销空闲房间: %v", removed)
			h.broadcastRooms()
		}
	}
}

// broadcastRooms 把最新房间列表推给所有连接
func (h *Hub) broadcastRooms() {
	payload, err := json.Marshal(gin.H{"type": "rooms", "rooms": h.store.List()})
	if err != nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for cl := range h.clients {
		h.sendLocked(cl, payload)
	}
}

// broadcastRoomMembers 把某房间的成员快照推给订阅它的连接
func (h *Hub) broadcastRoomMembers(roomName string) {
	payload, err := json.Marshal(gin.H{"type": "members", "room": roomName, "members": h.store.Members(roomName)})
	if err != nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for cl := range h.clients {
		if cl.room == roomName {
			h.sendLocked(cl, payload)
		}
	}
}

// snapshot 组装新连接的首屏数据：房间列表；房间内连接额外带该房间成员
func (h *Hub) snapshot(c *wsClient) []byte {
	body := gin.H{"type": "init", "rooms": h.store.List()}
	if c.room != "" {
		body["members"] = h.store.Members(c.room)
	}
	b, err := json.Marshal(body)
	if err != nil {
		return []byte("{}")
	}
	return b
}

// sendLocked 发送消息（调用方需持有 h.mu）。
// 队列满就丢弃：广播类消息下一轮快照自然会补上，原型不做背压。
func (h *Hub) sendLocked(c *wsClient, payload []byte) {
	select {
	case c.send <- payload:
	default:
		log.Println("warn: ws 发送队列已满，丢弃一条广播")
	}
}

// sendTo 非广播的单发封装
func (h *Hub) sendTo(c *wsClient, payload []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sendLocked(c, payload)
}

// readPump 只负责探活：客户端上行没有业务消息（协议留空，未来可扩展）。
// 浏览器端 WebSocket 会自动回应服务器的 ping。
func (h *Hub) readPump(c *wsClient) {
	defer c.conn.Close()
	c.conn.SetReadLimit(512)
	// 60 秒没收到 pong 就判定连接死亡
	c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})
	for {
		if _, _, err := c.conn.ReadMessage(); err != nil {
			return
		}
	}
}

// writePump 是该连接唯一的写协程：从 send 队列取消息写回，同时定时发 ping 保活
func (h *Hub) writePump(c *wsClient) {
	ticker := time.NewTicker(30 * time.Second)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()
	for {
		select {
		case payload, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				// send 队列被关闭：正常下线流程
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, payload); err != nil {
				return
			}
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
