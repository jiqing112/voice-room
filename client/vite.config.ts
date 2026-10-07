/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// Go 后端地址：默认 8080，可用环境变量覆盖（例如本机 8080 被占用时）
const backend = process.env.API_PROXY_TARGET || 'http://localhost:8080';
// LiveKit 信令（HTTP/WS 同端口）。LiveKit 不在本机时用环境变量覆盖，
// 例如 LIVEKIT_PROXY_TARGET=http://192.168.1.20:7880 npm run dev
const livekit = process.env.LIVEKIT_PROXY_TARGET || 'http://localhost:7880';

// 自签开发证书（.certs/ 目录，CA 可导入系统信任库实现免警告）。
// getUserMedia（麦克风）只在安全上下文（HTTPS 或 localhost）下可用，
// 局域网 IP 明文访问时浏览器不暴露该 API，因此 dev 也走 HTTPS。
// 证书只被 dev server 使用：Docker/CI 里构建产物没有 .certs，读不到就跳过
const https = (() => {
	try {
		return {
			key: readFileSync(resolve('.certs/server.key')),
			cert: readFileSync(resolve('.certs/server.crt'))
		};
	} catch {
		return undefined;
	}
})();

export default defineConfig({
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// adapter-node：构建出独立的 Node 服务（build/index.js），
			// 生产环境用 systemd 常驻，TLS 交给前面的 nginx/caddy 反向代理
			adapter: adapter()
		})
	],
	server: {
		https,
		proxy: {
			// 开发期把 API 请求与 WebSocket 都转发到 Go 后端，
			// 前端代码里全部使用相对路径，因此不需要在 Go 侧配 CORS
			'/api': { target: backend, changeOrigin: true },
			'/ws': { target: backend, ws: true, changeOrigin: true },
			// LiveKit 信令走同源路径代理（HTTPS 页面禁止连 ws:// 明文信令），
			// 前端在 HTTPS 下会把信令地址改写为 wss://<当前域名>/livekit，
			// 这样浏览器只需要信任 Vite 这一个证书；WebRTC 媒体流走 UDP/TCP 直连，不经过此代理
			'/livekit': {
				target: livekit,
				ws: true,
				changeOrigin: true,
				rewrite: (p) => p.replace(/^\/livekit/, '')
			}
		}
	}
});
