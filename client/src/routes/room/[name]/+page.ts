import type { PageLoad } from './$types';

export const load: PageLoad = ({ params }) => {
	// 路由参数是 URL 编码过的，还原成原始房间名（含中文/空格）
	try {
		return { name: decodeURIComponent(params.name) };
	} catch {
		return { name: params.name };
	}
};
