// 主题状态：亮/暗切换，偏好存 localStorage（key: echo:theme）。
// 首屏的类名由 app.html 里的内联脚本提前挂好，这里只负责读取与切换。
export type Theme = 'light' | 'dark';

const KEY = 'echo:theme';

function detect(): Theme {
	try {
		const saved = localStorage.getItem(KEY);
		if (saved === 'light' || saved === 'dark') return saved;
	} catch {
		/* 隐私模式等读不到就用系统偏好 */
	}
	return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export const theme = $state<{ current: Theme }>({ current: detect() });

export function toggleTheme() {
	theme.current = theme.current === 'dark' ? 'light' : 'dark';
	document.documentElement.classList.toggle('dark', theme.current === 'dark');
	try {
		localStorage.setItem(KEY, theme.current);
	} catch {
		/* 写不进就算了，本次会话仍然生效 */
	}
}
