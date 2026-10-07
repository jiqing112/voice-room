package main

// 账号系统：注册/登录（邮箱+密码），SQLite 持久化。
//
// 邮箱验证码的能力（SMTP 发信、验证码校验、发信限频）已完整实现，
// 由环境变量 MAIL_VERIFY_ENABLED 控制开关——当前关闭（注册直接建号），
// 打开后注册必须携带验证码，前端配合加一步即可，无需改存储结构。
import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"math/big"
	"net/mail"
	"net/smtp"
	"os"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	_ "modernc.org/sqlite"
)

// —— 配置（全部环境变量，systemd 里维护）——
type authConfig struct {
	dbPath     string // SQLite 文件路径
	mailVerify bool   // 是否开启邮箱验证码（注册时必须携带）

	// —— 账号系统开关（可随时在环境变量里切换，无需改代码）——
	// AUTH_REGISTER_ENABLED=true：开放注册/登录（前端显示入口，注册需账号）
	// CREATE_REQUIRE_ACCOUNT=true：创建房间需要登录账号（进入已存在房间不受影响）
	// 两者都关闭 = 纯游客模式：任何人自由建房、自由加入
	registerEnabled      bool
	createRequireAccount bool

	smtpHost string
	smtpPort string
	smtpUser string // 发件邮箱（同时是认证账号）
	smtpPass string
	mailFrom string // 显示名
}

func loadAuthConfig() authConfig {
	return authConfig{
		dbPath:               envOr("AUTH_DB", "auth.db"),
		mailVerify:           os.Getenv("MAIL_VERIFY_ENABLED") == "true",
		registerEnabled:      os.Getenv("AUTH_REGISTER_ENABLED") == "true",
		createRequireAccount: os.Getenv("CREATE_REQUIRE_ACCOUNT") == "true",
		smtpHost:             envOr("MAIL_SMTP_HOST", "smtp.stackmail.com"),
		smtpPort:             envOr("MAIL_SMTP_PORT", "465"),
		smtpUser:             os.Getenv("MAIL_SMTP_USER"), // 凭据只走环境变量，不进代码
		smtpPass:             os.Getenv("MAIL_SMTP_PASS"),
		mailFrom:             envOr("MAIL_FROM_NAME", "回声室"),
	}
}

// —— 密码哈希：PBKDF2-HMAC-SHA256（标准库自实现，无第三方依赖）——
const pbkdf2Iters = 100000

func pbkdf2Key(password, salt []byte) []byte {
	prf := hmac.New(sha256.New, password)
	hashLen := prf.Size()
	numBlocks := (32 + hashLen - 1) / hashLen
	var buf [4]byte
	dk := make([]byte, 0, numBlocks*hashLen)
	u := make([]byte, hashLen)
	for block := 1; block <= numBlocks; block++ {
		prf.Reset()
		prf.Write(salt)
		buf[0] = byte(block >> 24)
		buf[1] = byte(block >> 16)
		buf[2] = byte(block >> 8)
		buf[3] = byte(block)
		prf.Write(buf[:4])
		dk = prf.Sum(dk)
		copy(u, dk[len(dk)-hashLen:])
		for n := 2; n <= pbkdf2Iters; n++ {
			prf.Reset()
			prf.Write(u)
			u = prf.Sum(u[:0])
			for i, b := range u {
				dk[len(dk)-hashLen+i] ^= b
			}
		}
	}
	return dk[:32]
}

func hashPassword(password, salt string) string {
	return hex.EncodeToString(pbkdf2Key([]byte(password), []byte(salt)))
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// —— 错误哨兵（HTTP 层映射为状态码）——
var (
	errEmailTaken      = errors.New("该邮箱已注册，请直接登录")
	errEmailNotFound   = errors.New("该邮箱未注册")
	errBadCredentials  = errors.New("邮箱或密码不对")
	errBadCode         = errors.New("验证码不对或已过期")
	errCodeNotRequired = errors.New("未启用邮箱验证码")
	errEmailInvalid    = errors.New("邮箱格式不对")
	errPasswordWeak    = errors.New("密码至少 8 位")
	errRateLimited     = errors.New("请求太频繁，请稍后再试")
)

// —— 存储层 ——
type userStore struct {
	mu     sync.Mutex
	db     *sql.DB
	cfg    authConfig
	codeIP map[string]*ipWindow // 验证码发信的每 IP 计数（1 小时窗口，内存即可）
}

// ipWindow 固定窗口计数：窗口过了自动重新计数（否则"每小时 10 封"
// 会退化成"重启前总共 10 封"，正常用户也会被永久挡住）
type ipWindow struct {
	count int
	start time.Time
}

const mailWindow = time.Hour
const mailPerWindow = 10

// Account 对外视图（不含敏感字段）
type Account struct {
	ID        string `json:"id"`
	Email     string `json:"email"`
	Nickname  string `json:"nickname"`
	CreatedAt int64  `json:"createdAt"` // 注册时间（unix 秒）
}

func newUserStore(cfg authConfig) *userStore {
	db, err := sql.Open("sqlite", cfg.dbPath+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	if err != nil {
		log.Fatalf("打开账号数据库失败: %v", err)
	}
	for _, ddl := range []string{
		`CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, nickname TEXT NOT NULL,
			pass_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER NOT NULL)`,
		`CREATE TABLE IF NOT EXISTS sessions (
			token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
		`CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)`,
		`CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`,
		`CREATE TABLE IF NOT EXISTS email_codes (
			email TEXT PRIMARY KEY, code_hash TEXT NOT NULL,
			expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_sent INTEGER NOT NULL)`,
	} {
		if _, err := db.Exec(ddl); err != nil {
			log.Fatalf("初始化账号表失败: %v", err)
		}
	}
	s := &userStore{db: db, cfg: cfg, codeIP: map[string]*ipWindow{}}
	// 后台每小时清一次过期会话与验证码记录：两类行此前只增不删，会无限堆积
	go func() {
		for range time.Tick(time.Hour) {
			now := time.Now().Unix()
			if _, err := s.db.Exec(`DELETE FROM sessions WHERE expires_at < ?`, now); err != nil {
				log.Printf("warn: 清理过期会话失败: %v", err)
			}
			s.db.Exec(`DELETE FROM email_codes WHERE expires_at < ?`, now)
		}
	}()
	return s
}

const sessionTTL = 30 * 24 * time.Hour

// Register 创建账号；mailVerify 开启时要求验证码。成功返回新会话令牌
func (s *userStore) Register(email, password, nickname, code, ip string) (string, Account, error) {
	email = normalizeEmail(email)
	nickname = strings.TrimSpace(nickname)
	if email == "" {
		return "", Account{}, errEmailInvalid
	}
	if len(password) < 8 {
		return "", Account{}, errPasswordWeak
	}
	if nickname == "" {
		return "", Account{}, errors.New("昵称不能为空")
	}
	if utf8.RuneCountInString(nickname) > 32 {
		return "", Account{}, errors.New("昵称最长 32 个字符")
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	var exists bool
	if err := s.db.QueryRow(`SELECT EXISTS(SELECT 1 FROM users WHERE email=?)`, email).Scan(&exists); err != nil {
		return "", Account{}, err
	}
	if exists {
		return "", Account{}, errEmailTaken
	}
	if s.cfg.mailVerify {
		if code == "" {
			return "", Account{}, errors.New("请输入邮箱验证码")
		}
		if err := s.verifyCodeLocked(email, code); err != nil {
			return "", Account{}, err
		}
	}
	salt := randomHex(16)
	id := "u_" + randomHex(8)
	now := time.Now().Unix()
	if _, err := s.db.Exec(
		`INSERT INTO users (id, email, nickname, pass_hash, salt, created_at) VALUES (?,?,?,?,?,?)`,
		id, email, nickname, hashPassword(password, salt), salt, now); err != nil {
		return "", Account{}, err
	}
	s.consumeCodeLocked(email)
	token, err := s.createSessionLocked(id)
	return token, Account{ID: id, Email: email, Nickname: nickname, CreatedAt: now}, err
}

// normalizeEmail 解析并规范化邮箱：取 mail.ParseAddress 的地址部分并转小写。
// 直接存原始串会把 "Bob <a@b.c>" 这类带显示名的输入原样入库，登录时对不上
func normalizeEmail(raw string) string {
	raw = strings.TrimSpace(raw)
	addr, err := mail.ParseAddress(raw)
	if err != nil || !strings.Contains(addr.Address, "@") {
		return ""
	}
	return strings.ToLower(addr.Address)
}

func (s *userStore) Login(email, password, ip string) (string, Account, error) {
	email = normalizeEmail(email)
	s.mu.Lock()
	defer s.mu.Unlock()
	var id, nick, hash, salt string
	var createdAt int64
	err := s.db.QueryRow(`SELECT id, nickname, pass_hash, salt, created_at FROM users WHERE email=?`, email).
		Scan(&id, &nick, &hash, &salt, &createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		// 防用户枚举：与密码错误的提示一致、耗时一致
		hashPassword(password, "timing-equalizer-salt-000000000000")
		return "", Account{}, errBadCredentials
	}
	if err != nil {
		return "", Account{}, err
	}
	if subtle.ConstantTimeCompare([]byte(hashPassword(password, salt)), []byte(hash)) != 1 {
		return "", Account{}, errBadCredentials
	}
	token, err := s.createSessionLocked(id)
	return token, Account{ID: id, Email: email, Nickname: nick, CreatedAt: createdAt}, err
}

func (s *userStore) createSessionLocked(userID string) (string, error) {
	token := randomHex(32)
	if _, err := s.db.Exec(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)`,
		token, userID, time.Now().Add(sessionTTL).Unix()); err != nil {
		return "", err
	}
	return token, nil
}

// UserBySession 用会话令牌取账号；无效/过期返回 nil
func (s *userStore) UserBySession(token string) (Account, bool) {
	if token == "" {
		return Account{}, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var a Account
	err := s.db.QueryRow(
		`SELECT u.id, u.email, u.nickname, u.created_at FROM sessions s JOIN users u ON u.id=s.user_id
		 WHERE s.token=? AND s.expires_at > ?`, token, time.Now().Unix()).
		Scan(&a.ID, &a.Email, &a.Nickname, &a.CreatedAt)
	if err != nil {
		return Account{}, false
	}
	return a, true
}

// UpdatePassword 修改密码：校验旧密码，换新盐重哈希。成功同时吊销该账号全部会话
func (s *userStore) UpdatePassword(email, oldPassword, newPassword string) error {
	if len(newPassword) < 8 {
		return errPasswordWeak
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var hash, salt string
	var id string
	err := s.db.QueryRow(`SELECT id, pass_hash, salt FROM users WHERE email=?`, email).
		Scan(&id, &hash, &salt)
	if errors.Is(err, sql.ErrNoRows) {
		return errBadCredentials
	}
	if err != nil {
		return err
	}
	// 防时序对齐：旧密码错也做一次等量哈希
	computed := hashPassword(oldPassword, salt)
	hashPassword(oldPassword, "timing-equalizer-salt-000000000000")
	if subtle.ConstantTimeCompare([]byte(computed), []byte(hash)) != 1 {
		return errors.New("当前密码不对")
	}
	newSalt := randomHex(16)
	if _, err := s.db.Exec(`UPDATE users SET pass_hash=?, salt=? WHERE id=?`,
		hashPassword(newPassword, newSalt), newSalt, id); err != nil {
		return err
	}
	// 密码变更后所有会话失效（安全惯例），当前会话也会被登出
	s.db.Exec(`DELETE FROM sessions WHERE user_id=?`, id)
	return nil
}

func (s *userStore) Logout(token string) {
	if token == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.db.Exec(`DELETE FROM sessions WHERE token=?`, token)
}

func (s *userStore) sessionCookie(token string, maxAge int) string {
	return fmt.Sprintf("echo_session=%s; Path=/; MaxAge=%d; HttpOnly; Secure; SameSite=Lax", token, maxAge)
}

// —— 邮箱验证码（MAIL_VERIFY_ENABLED=true 时启用）——

func (s *userStore) SendCode(email, ip string) error {
	email = normalizeEmail(email)
	if email == "" {
		return errEmailInvalid
	}
	if !s.cfg.mailVerify {
		return errCodeNotRequired
	}
	if s.cfg.smtpUser == "" || s.cfg.smtpPass == "" {
		return errors.New("邮件服务未配置（缺少 MAIL_SMTP_USER/MAIL_SMTP_PASS）")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	// 每邮箱 60 秒一封；每 IP 每小时最多 10 封（窗口过自动重计）
	var lastSent int64
	s.db.QueryRow(`SELECT last_sent FROM email_codes WHERE email=?`, email).Scan(&lastSent)
	if time.Now().Unix()-lastSent < 60 {
		return errRateLimited
	}
	now := time.Now()
	if w, ok := s.codeIP[ip]; ok && now.Sub(w.start) < mailWindow {
		if w.count >= mailPerWindow {
			return errRateLimited
		}
		w.count++
	} else {
		s.codeIP[ip] = &ipWindow{count: 1, start: now}
		// 顺手清掉过期窗口，防 map 随独特 IP 数无限增长
		if len(s.codeIP) > 4096 {
			for k, w := range s.codeIP {
				if now.Sub(w.start) >= mailWindow {
					delete(s.codeIP, k)
				}
			}
		}
	}
	code := make([]byte, 6)
	for i := range code {
		b, _ := rand.Int(rand.Reader, big.NewInt(10))
		code[i] = '0' + byte(b.Int64())
	}
	codeHash := hashPassword(string(code), "code|"+email)
	nowUnix := time.Now().Unix()
	if _, err := s.db.Exec(`
		INSERT INTO email_codes (email, code_hash, expires_at, attempts, last_sent) VALUES (?,?,?,0,?)
		ON CONFLICT(email) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at,
			attempts=0, last_sent=excluded.last_sent`,
		email, codeHash, nowUnix+10*60, nowUnix); err != nil {
		return err
	}
	go func() {
		codeStr := string(code)
		html := buildCodeEmailHTML(s.cfg.mailFrom, codeStr)
		if err := sendMailTLS(s.cfg, email, fmt.Sprintf("【%s】你的验证码：%s", s.cfg.mailFrom, codeStr),
			fmt.Sprintf("【%s】你的验证码是 %s，10 分钟内有效。请勿透露给任何人。", s.cfg.mailFrom, codeStr), html); err != nil {
			log.Printf("warn: 验证码邮件发送失败 %s: %v", email, err)
		}
	}()
	return nil
}

func (s *userStore) verifyCodeLocked(email, code string) error {
	var hash string
	var expiresAt, attempts int64
	err := s.db.QueryRow(`SELECT code_hash, expires_at, attempts FROM email_codes WHERE email=?`, email).
		Scan(&hash, &expiresAt, &attempts)
	if errors.Is(err, sql.ErrNoRows) || time.Now().Unix() > expiresAt {
		return errBadCode
	}
	if attempts >= 5 {
		return errBadCode
	}
	if subtle.ConstantTimeCompare([]byte(hashPassword(code, "code|"+email)), []byte(hash)) != 1 {
		s.db.Exec(`UPDATE email_codes SET attempts=attempts+1 WHERE email=?`, email)
		return errBadCode
	}
	return nil
}

func (s *userStore) consumeCodeLocked(email string) {
	s.db.Exec(`DELETE FROM email_codes WHERE email=?`, email)
}

// sendMailTLS 通过 465 端口 SSL SMTP 发信（stackmail 通道）
func sendMailTLS(cfg authConfig, to, subject, text, html string) error {
	addr := cfg.smtpHost + ":" + cfg.smtpPort
	conn, err := tls.Dial("tcp", addr, &tls.Config{ServerName: cfg.smtpHost})
	if err != nil {
		return err
	}
	c, err := smtp.NewClient(conn, cfg.smtpHost)
	if err != nil {
		return err
	}
	defer c.Close()
	if err = c.Auth(smtp.PlainAuth("", cfg.smtpUser, cfg.smtpPass, cfg.smtpHost)); err != nil {
		return err
	}
	if err = c.Mail(cfg.smtpUser); err != nil {
		return err
	}
	if err = c.Rcpt(to); err != nil {
		return err
	}
	w, err := c.Data()
	if err != nil {
		return err
	}
	body := fmt.Sprintf("From: %s <%s>\r\nTo: %s\r\nSubject: %s\r\nMIME-Version: 1.0\r\n"+
		"Content-Type: text/html; charset=UTF-8\r\n\r\n%s",
		cfg.mailFrom, cfg.smtpUser, to, subject, html)
	if _, err = w.Write([]byte(body)); err != nil {
		return err
	}
	if err = w.Close(); err != nil {
		return err
	}
	return c.Quit()
}

// 验证码邮件模板（简洁样式，品牌与站点一致）
func buildCodeEmailHTML(brand, code string) string {
	return fmt.Sprintf(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"></head>
<body style="margin:0; padding:0; background-color:#f4f5f7;">
<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f5f7; padding:32px 0;">
<tr><td align="center">
  <table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0"
         style="background-color:#ffffff; border-radius:8px; font-family:-apple-system,'Helvetica Neue',Arial,'PingFang SC','Microsoft YaHei',sans-serif;">
    <tr><td style="padding:36px 48px 0 48px;">
      <span style="font-size:16px; font-weight:bold; color:#09090b;">%s</span>
    </td></tr>
    <tr><td style="padding:28px 48px 0 48px;">
      <h2 style="margin:0; font-size:18px; color:#09090b;">您的验证码</h2>
    </td></tr>
    <tr><td align="center" style="padding:24px 48px;">
      <span style="display:inline-block; font-size:34px; font-weight:bold; letter-spacing:10px;
                   color:#111111; font-family:Consolas,Menlo,monospace;">%s</span>
    </td></tr>
    <tr><td style="padding:0 48px 8px 48px;">
      <p style="margin:0; font-size:14px; color:#4a5568; line-height:1.8;">验证码 <strong>10 分钟</strong>内有效。请在页面中输入上方数字完成验证。</p>
    </td></tr>
    <tr><td style="padding:20px 48px 0 48px;">
      <p style="margin:0; font-size:13px; color:#71717a; line-height:1.8;">如果这不是您本人的操作，请忽略此邮件。请勿将验证码透露给任何人，包括%s的工作人员。</p>
    </td></tr>
    <tr><td style="padding:32px 48px 36px 48px;">
      <hr style="border:none; border-top:1px solid #e4e4e7; margin:0 0 16px 0;">
      <p style="margin:0; font-size:12px; color:#a1a1aa;">这是一封系统自动发送的邮件，请勿直接回复。</p>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`, brand, code, brand)
}
