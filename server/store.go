package main

import (
	"crypto/subtle"
	"errors"
	"sort"
	"sync"
	"time"
)

// 有密码的房间被空闲注销后，密码在墓碑里再保留一段时间：
// 期间有人用原房间名重建，会自动继承原密码——防止"等房主走了重建无密码房"绕过门禁
const passwordTombstoneTTL = 24 * time.Hour

// Member 是房间里的一个在线成员。
// 成员身份由 WebSocket 连接的生死决定：连接建立 → 加入，连接断开 → 移除。
type Member struct {
	ID   string `json:"id"`   // 连接级唯一 ID（同一昵称开两个标签页也互不冲突）
	Name string `json:"name"` // 展示昵称
}

// RoomInfo 对外输出的房间快照。
// 刻意不带创建者信息：房间列表是公开接口，邮箱属于账号隐私，
// "我创建的房间"走需要登录的 /api/auth/my-rooms（服务端按会话过滤）
type RoomInfo struct {
	Name        string    `json:"name"`
	CreatedAt   time.Time `json:"createdAt"`
	MemberCount int       `json:"memberCount"`
	Members     []Member  `json:"members"`
	HasPassword bool      `json:"hasPassword"` // 是否设置了访问码（不泄露码本身）
}

var ErrRoomExists = errors.New("房间已存在")

// RoomStore 把房间和成员都放在内存里（原型不接数据库），用读写锁保护。
type RoomStore struct {
	mu                 sync.RWMutex
	rooms              map[string]*roomEntry // key: 房间名
	passwordTombstones map[string]passwordTombstone
}

type passwordTombstone struct {
	password  string
	expiresAt time.Time
}

type roomEntry struct {
	name       string
	password   string // 访问码，空串 = 无密码；只存内存，随房间注销一并消失
	creator    string // 创建者账号邮箱（游客兜底创建的为空）
	createdAt  time.Time
	lastActive time.Time // 最近一次创建/有人进出；空房间超过阈值未活跃即被清理
	members    map[string]Member
}

func newRoomEntry(name, password, creator string) *roomEntry {
	return &roomEntry{name: name, password: password, creator: creator, createdAt: time.Now(), lastActive: time.Now(), members: make(map[string]Member)}
}

func NewRoomStore() *RoomStore {
	return &RoomStore{
		rooms:              make(map[string]*roomEntry),
		passwordTombstones: make(map[string]passwordTombstone),
	}
}

// Create 创建房间（可带访问码）；已存在则返回 ErrRoomExists。creator 记录创建者邮箱
func (s *RoomStore) Create(name, password, creator string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.rooms[name]; ok {
		return ErrRoomExists
	}
	s.rooms[name] = newRoomEntry(name, password, creator)
	return nil
}

// getOrCreateLocked 内部方法：调用方必须已持有写锁。
// password 只在"新建"时生效——已存在的房间不会被此调用改密码。
// 新建时若墓碑里有未过期的原密码且本次未指定密码，则继承原密码（防绕过门禁）
func (s *RoomStore) getOrCreateLocked(name, password, creator string) *roomEntry {
	r, ok := s.rooms[name]
	if !ok {
		if password == "" {
			if ts, ok := s.passwordTombstones[name]; ok && time.Now().Before(ts.expiresAt) {
				password = ts.password
			}
		}
		r = newRoomEntry(name, password, creator)
		s.rooms[name] = r
	}
	r.lastActive = time.Now()
	return r
}

// CheckPassword 校验访问码。返回 (房间是否存在, 是否通过)。
// 不存在的房间：(false, false)；无密码房间：直接通过；有密码：常数时间比较，防时序侧信道
func (s *RoomStore) CheckPassword(name, code string) (exists, ok bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.rooms[name]
	if !ok {
		// 墓碑未过期：视同存在并校验墓碑密码，防"等房间注销后无码重建"绕过门禁
		if ts, has := s.passwordTombstones[name]; has && time.Now().Before(ts.expiresAt) {
			return true, subtle.ConstantTimeCompare([]byte(ts.password), []byte(code)) == 1
		}
		return false, false
	}
	if r.password == "" {
		return true, true
	}
	return true, subtle.ConstantTimeCompare([]byte(r.password), []byte(code)) == 1
}

// HasPassword 查询房间是否设置了访问码（不泄露密码本身）
func (s *RoomStore) HasPassword(name string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.rooms[name]
	return ok && r.password != ""
}

// List 返回所有房间的快照，按创建时间从旧到新排序
func (s *RoomStore) List() []RoomInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]RoomInfo, 0, len(s.rooms))
	for _, r := range s.rooms {
		out = append(out, RoomInfo{
			Name:        r.name,
			CreatedAt:   r.createdAt,
			MemberCount: len(r.members),
			Members:     membersLocked(r),
			HasPassword: r.password != "",
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out
}

// RoomsByCreator 返回指定创建者邮箱名下的房间快照（"我的房间"接口用）。
// 过滤在服务端完成——创建者邮箱不再出现在任何公开响应里
func (s *RoomStore) RoomsByCreator(creator string) []RoomInfo {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]RoomInfo, 0)
	for _, r := range s.rooms {
		if r.creator != creator {
			continue
		}
		out = append(out, RoomInfo{
			Name:        r.name,
			CreatedAt:   r.createdAt,
			MemberCount: len(r.members),
			Members:     membersLocked(r),
			HasPassword: r.password != "",
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out
}

// Exists 房间是否"有效存在"：含未过期的密码墓碑——有码房间刚被空闲注销时，
// 对外仍视同存在（访问码照旧校验），建房门槛的判定口径与之一致
func (s *RoomStore) Exists(name string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if _, ok := s.rooms[name]; ok {
		return true
	}
	ts, has := s.passwordTombstones[name]
	return has && time.Now().Before(ts.expiresAt)
}

// JoinOrCreate 访问码门禁与兜底建房在同一把写锁内原子完成：
//   - 房间已存在 → 常数时间校验访问码（无密码直接通过）；
//   - 房间不存在但墓碑未过期 → 校验墓碑密码（防"等注销后无码重建"绕门禁）；
//   - 房间不存在且无墓碑 → 以传入的 code 创建房间（进入即创建，code 可为空，记录创建者）。
//
// creator 仅在新建时记录。返回是否放行。原子化是为了消除"先校验、后建房"
// 两步之间的窗口：否则请求 A 校验通过后、建房前，无码的请求 B 也能混进带码新房
func (s *RoomStore) JoinOrCreate(name, code, creator string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r, ok := s.rooms[name]; ok {
		r.lastActive = time.Now()
		if r.password == "" {
			return true
		}
		return subtle.ConstantTimeCompare([]byte(r.password), []byte(code)) == 1
	}
	if ts, has := s.passwordTombstones[name]; has && time.Now().Before(ts.expiresAt) {
		return subtle.ConstantTimeCompare([]byte(ts.password), []byte(code)) == 1
	}
	s.getOrCreateLocked(name, code, creator)
	return true
}

// Members 返回某房间当前在线成员；房间不存在则返回空列表
func (s *RoomStore) Members(name string) []Member {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.rooms[name]
	if !ok {
		return []Member{}
	}
	return membersLocked(r)
}

// AddMember 往房间加一名成员并分配成员 ID；房间不存在会自动创建（无访问码、无创建者）
func (s *RoomStore) AddMember(roomName, name string) Member {
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.getOrCreateLocked(roomName, "", "")
	m := Member{ID: randHex(8), Name: name}
	r.members[m.ID] = m
	r.lastActive = time.Now()
	return m
}

// RemoveMember 移除成员；返回是否真的移除了一条记录
func (s *RoomStore) RemoveMember(roomName, memberID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.rooms[roomName]
	if !ok {
		return false
	}
	if _, ok := r.members[memberID]; !ok {
		return false
	}
	delete(r.members, memberID)
	r.lastActive = time.Now()
	return true
}

// SweepIdle 清理空闲房间：没有成员且超过 maxIdle 无活动的房间直接注销。
// 有密码的房间注销时密码进墓碑保留一段时间（见 passwordTombstoneTTL）。
// 返回被清理的房间名列表（调用方据此广播房间列表变更）。
// 宽限期的意义：页面刷新会短暂断开 WS，房间不会被误删，重连即恢复。
func (s *RoomStore) SweepIdle(maxIdle time.Duration) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	var removed []string
	for name, r := range s.rooms {
		if len(r.members) != 0 || now.Sub(r.lastActive) <= maxIdle {
			continue
		}
		if r.password != "" {
			s.passwordTombstones[name] = passwordTombstone{password: r.password, expiresAt: now.Add(passwordTombstoneTTL)}
		}
		delete(s.rooms, name)
		removed = append(removed, name)
	}
	// 顺带清理过期墓碑
	for name, ts := range s.passwordTombstones {
		if now.After(ts.expiresAt) {
			delete(s.passwordTombstones, name)
		}
	}
	return removed
}

// membersLocked 把 map 转成稳定排序的切片（调用方需已持有锁）
func membersLocked(r *roomEntry) []Member {
	out := make([]Member, 0, len(r.members))
	for _, m := range r.members {
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}
