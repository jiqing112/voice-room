// 原型是面向桌面 Chrome 的纯客户端应用：WebRTC、麦克风、localStorage
// 都依赖浏览器环境，直接关掉 SSR，省去服务端渲染的环境判断与水合差异问题
export const ssr = false;
