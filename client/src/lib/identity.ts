// 原型不做注册登录：昵称存 localStorage，丢了就重新输一次
const KEY = 'voice-room:nickname';

export function getNickname(): string | null {
	try {
		return localStorage.getItem(KEY);
	} catch {
		return null;
	}
}

export function setNickname(name: string) {
	try {
		localStorage.setItem(KEY, name);
	} catch {
		/* 隐私模式等场景写不进去就算了，不影响本次会话使用 */
	}
}
