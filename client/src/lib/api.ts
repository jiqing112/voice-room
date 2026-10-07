// Go 后端 API 客户端。
// 开发期所有请求走相对路径（由 Vite 代理转发到 Go 后端），不区分环境。

export interface Member {
	id: string;
	name: string;
}

export interface RoomInfo {
	name: string;
	createdAt: string;
	memberCount: number;
	members: Member[];
	hasPassword: boolean; // 是否设置了访问码（不泄露码本身）
	// 创建者信息不下发：房间列表是公开接口，"我的房间"走 fetchMyRooms（需登录）
}

// 当前登录账号创建的房间（服务端按会话过滤，见 /api/auth/my-rooms）
export interface MyRoom {
	name: string;
	memberCount: number;
	hasPassword: boolean;
}

export interface TokenResponse {
	token: string; // LiveKit 访问令牌（JWT）
	url: string; // LiveKit 信令地址，浏览器直连媒体服务器用
	room: string;
	identity: string;
	name: string;
	ticket: string; // 进房票据：连接成员同步 WS 时凭票接入（避免访问码进 URL）
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
	const res = await fetch(input, init);
	if (!res.ok) {
		// 后端统一返回 {error: "文案"}，优先展示给用户
		let msg = `请求失败（HTTP ${res.status}）`;
		try {
			const body = await res.json();
			if (body?.error) msg = body.error;
		} catch {
			/* 非 JSON 响应，保留默认文案 */
		}
		throw new Error(msg);
	}
	return res.json();
}

export function fetchRooms(): Promise<{ rooms: RoomInfo[] }> {
	return request('/api/rooms');
}

// 我创建的房间（需要登录；服务端按会话身份过滤，不公开创建者邮箱）
export async function fetchMyRooms(): Promise<MyRoom[]> {
	const res = await fetch('/api/auth/my-rooms');
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error(body?.error || `获取失败（HTTP ${res.status}）`);
	}
	return (await res.json()).rooms as MyRoom[];
}

// 调用方公网 IP（后端从 X-Forwarded-For 解析）。
// 拿到后经 LiveKit 数据通道广播，房间成员的卡片弹窗互相可见
export async function fetchMyIp(): Promise<string> {
	const r = await request<{ ip: string }>('/api/ip');
	return r.ip;
}

// 令牌接口的结构化错误：needsCode 表示房间要访问码（或码不对）；
// needsAccount 表示新建房间需要先注册登录
export class TokenError extends Error {
	needsCode: boolean;
	needsAccount: boolean;
	constructor(message: string, needsCode: boolean, needsAccount = false) {
		super(message);
		this.needsCode = needsCode;
		this.needsAccount = needsAccount;
	}
}

// 当前登录账号（未登录为 null）
export interface Account {
	id: string;
	email: string;
	nickname: string;
	createdAt?: number; // 注册时间（unix 秒）
}

export interface AuthConfig {
	mailVerify: boolean; // 站点是否开启了邮箱验证码（true 时注册需填验证码）
	registerEnabled: boolean; // 账号系统开关（关闭时注册/登录入口隐藏）
	createRequireAccount: boolean; // 创建房间是否需要登录账号
}

// 修改密码。成功后全部会话失效（需重新登录）
export async function updatePassword(
	oldPassword: string,
	newPassword: string
): Promise<{ loggedOut: boolean }> {
	const res = await fetch('/api/auth/password', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ oldPassword, newPassword })
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(body?.error || `修改失败（HTTP ${res.status}）`);
	return body;
}

export async function updateNickname(nickname: string): Promise<Account> {
	const res = await fetch('/api/auth/nickname', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ nickname })
	});
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error(body?.error || `保存失败（HTTP ${res.status}）`);
	}
	return (await res.json()).user as Account;
}

export async function fetchMe(): Promise<{
	user: Account | null;
	mailVerify: boolean;
	registerEnabled: boolean;
	createRequireAccount: boolean;
}> {
	const res = await fetch('/api/auth/me');
	if (!res.ok) return { user: null, mailVerify: false, registerEnabled: false, createRequireAccount: false };
	return res.json();
}

export async function registerAccount(email: string, password: string, nickname: string, code = ''): Promise<Account> {
	const res = await fetch('/api/auth/register', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ email, password, nickname, code })
	});
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error(body?.error || `注册失败（HTTP ${res.status}）`);
	}
	return (await res.json()).user as Account;
}

export async function loginAccount(email: string, password: string): Promise<Account> {
	const res = await fetch('/api/auth/login', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ email, password })
	});
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error(body?.error || `登录失败（HTTP ${res.status}）`);
	}
	return (await res.json()).user as Account;
}

export async function sendEmailCode(email: string): Promise<void> {
	const res = await fetch('/api/auth/send-code', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ email })
	});
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error(body?.error || `发送失败（HTTP ${res.status}）`);
	}
}

export async function logoutAccount(): Promise<void> {
	await fetch('/api/auth/logout', { method: 'POST' });
}

export async function fetchToken(room: string, name: string, code = ''): Promise<TokenResponse> {
	// 用 POST：访问码放请求体里，不出现在 URL 和访问日志中
	const res = await fetch('/api/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ room, name, code })
	});
	if (!res.ok) {
		let msg = `请求失败（HTTP ${res.status}）`;
		let needsCode = false;
		let needsAccount = false;
		try {
			const body = await res.json();
			if (body?.error) msg = body.error;
			needsCode = !!body?.needsCode;
			needsAccount = !!body?.needsAccount;
		} catch {
			/* 非 JSON 响应，保留默认文案 */
		}
		throw new TokenError(msg, needsCode, needsAccount);
	}
	return res.json();
}

// 后端 WebSocket 地址（大厅与房间页共用，同样走 Vite 代理）
export function backendWsUrl(query = ''): string {
	const proto = location.protocol === 'https:' ? 'wss' : 'ws';
	return `${proto}://${location.host}/ws${query}`;
}

// 计算 LiveKit 信令地址：
// HTTPS 页面禁止连 ws:// 明文信令（混合内容），而后端返回的是它环境里的 LIVEKIT_URL。
// 因此 HTTPS 下把信令改写到同源路径 /livekit（由 dev 服务器代理转发到真正的 LiveKit），
// 浏览器全程只信任前端这一个证书；HTTP 页面（或后端直接给了 wss://）则原样使用。
export function resolveSignalUrl(url: string): string {
	if (location.protocol === 'https:' && !url.startsWith('wss:')) {
		return `wss://${location.host}/livekit`;
	}
	return url;
}
