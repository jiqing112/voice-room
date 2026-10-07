<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { backendWsUrl, fetchToken, TokenError, fetchMe, type Member, type Account, type AuthConfig } from '#lib/api';
	import { getNickname, setNickname } from '#lib/identity';
	import { cn } from '#lib/utils';
	import { VoiceRoom } from '#lib/voice-room.svelte';
	import { AccountModal, Avatar, Badge, Button, Card, CardContent, Icon, Input, ThemeToggle } from '#lib/ui';


	let { data }: { data: { name: string } } = $props();
	const roomName = $derived(data.name);

	// —— 账号：创建房间被拦（needsAccount）时弹注册/登录框，成功后自动重试 ——
	let showAuthModal = $state(false);
	let authCfg = $state<AuthConfig>({ mailVerify: false, registerEnabled: false, createRequireAccount: false });
	let retryNickname = $state('');

	// 链接进房但没设置过昵称：不再弹回大厅，就地弹模态框输入昵称后直接进房
	let showNameModal = $state(false);
	let nameDraft = $state('');
	let nameInputEl = $state<HTMLInputElement | null>(null);
	$effect(() => {
		if (showNameModal) nameInputEl?.focus();
	});

	function confirmNickname() {
		const n = nameDraft.trim();
		if (!n || joining) return;
		setNickname(n);
		showNameModal = false;
		start(n);
	}

	// 隐藏文件选择器引用（背景音乐按钮触发它打开文件对话框）
	let bgmFileInput = $state<HTMLInputElement | null>(null);
	let showBgmPanel = $state(false); // 背景音乐播放器面板开关
	let bgmPanelEl = $state<HTMLDivElement | null>(null);
	let netPopoverId = $state<string | null>(null); // 当前展开"网络信息"弹窗的成员 identity

	// 面板交互：单击按钮开合；点面板外的任何位置关闭。
	// （弹窗外点击走 window 捕获，按钮与面板内部自行豁免）
	function onDocClick(e: MouseEvent) {
		const t = e.target as Node | null;
		if (!t) return;
		// 网络信息小弹窗：点击角标或弹窗以外的地方就收起
		if (netPopoverId) {
			const el = t instanceof Element ? t : null;
			if (!el?.closest('[data-net-popover]') && !el?.closest('[data-net-badge]')) netPopoverId = null;
		}
		if (!showBgmPanel) return;
		if (bgmPanelEl?.contains(t)) return;
		if (t instanceof Element && t.closest('button[aria-label="背景音乐面板"]')) return;
		showBgmPanel = false;
	}

	// 跑马灯 action：内容超宽时打开滚动动画（短歌名保持静止）
	function marquee(node: HTMLElement, dep: string) {
		const apply = () => node.classList.toggle('marquee-on', node.scrollWidth > node.clientWidth + 1);
		apply();
		return { update: apply };
	}

	let controller = $state<VoiceRoom | null>(null);
	let joining = $state(true);
	let joinError = $state('');
	let left = $state(false);

	// —— 访问码：链接 #code= 片段优先（分享链接带来的，fragment 不会进服务器日志），
	// 其次 sessionStorage（本会话记住的）——
	const codeKeyFor = (room: string) => `echo:code:${room}`;
	function readCode(): string {
		const m = location.hash.match(/code=([^&]+)/);
		if (m) {
			const fromHash = decodeURIComponent(m[1]);
			try {
				sessionStorage.setItem(codeKeyFor(roomName), fromHash);
			} catch {
				/* 忽略 */
			}
			return fromHash;
		}
		try {
			return sessionStorage.getItem(codeKeyFor(roomName)) ?? '';
		} catch {
			return '';
		}
	}

	// —— 进房票据：随令牌一起签发，WS 凭票接入（断线重连复用，30 分钟有效）——
	const ticketKeyFor = (room: string) => `echo:ticket:${room}`;
	function saveTicket(room: string, ticket: string) {
		try {
			sessionStorage.setItem(ticketKeyFor(room), ticket);
		} catch {
			/* 忽略 */
		}
	}
	function readTicket(room: string): string {
		try {
			return sessionStorage.getItem(ticketKeyFor(room)) ?? '';
		} catch {
			return '';
		}
	}

	// 需要访问码的状态与输入
	let needsCode = $state(false);
	let codeInput = $state('');
	let codeError = $state('');
	let codeSubmitting = $state(false);

	// —— 音频设置面板 ——
	let showAudioSettings = $state(false);
	let inputLevel = $state(0);
	let levelTimer: ReturnType<typeof setInterval> | null = null;
	$effect(() => {
		// 面板打开且已连接时，轮询输入电平（供调麦音量参考）
		if (showAudioSettings && controller?.status === 'connected' && controller) {
			const c = controller;
			levelTimer = setInterval(() => {
				inputLevel = c.readInputLevel();
			}, 200);
			return () => {
				if (levelTimer) clearInterval(levelTimer);
			};
		}
	});
	const audioToggles: {
		key: 'echoCancellation' | 'noiseSuppression' | 'autoGainControl' | 'voiceIsolation' | 'compressor' | 'lowCut' | 'hissCut';
		label: string;
		desc: string;
	}[] = [
		{ key: 'lowCut', label: '低切（低频杂音）', desc: '滤掉桌面震动、空调嗡嗡声、喷麦气流' },
		{ key: 'hissCut', label: '嘶声抑制（高频）', desc: '压低电流声、话筒底噪等嘶嘶声' },
		{ key: 'echoCancellation', label: '回声消除', desc: '外放扬声器必开，戴耳机可关' },
		{ key: 'noiseSuppression', label: '噪声抑制', desc: '压风扇/空调等低频嗡嗡声，与 AI 降噪可叠加' },
		{ key: 'autoGainControl', label: '自动增益', desc: '自动调音量；嫌忽大忽小可关' },
		{ key: 'compressor', label: '防炸压限', desc: '自动削掉瞬间峰值，声音太冲就开着' },
		{ key: 'voiceIsolation', label: '人声隔离（实验）', desc: '浏览器 ML 方案，与 AI 强降噪二选一' }
	];

	// —— 进出提示（toast）：来自后端 WS 的成员快照差分 ——
	let toast = $state('');
	let toastTimer: ReturnType<typeof setTimeout> | undefined;

	// 后端 WS 有两个作用：
	//   1. 房间内连接代表一名成员，连接断开后端自动把人移出房间 → 大厅人数实时更新
	//   2. 推送本房间成员进出 → 房间页显示“xx 加入了/离开了”
	// 房间页渲染的成员列表本身以 LiveKit 参会者为准（与媒体连接同源，最可靠）
	let ws: WebSocket | null = null;
	let wsReconnectTimer: ReturnType<typeof setTimeout> | undefined;
	let knownMembers = new Map<string, string>(); // memberId -> name
	let wsSeeded = false;

	onMount(() => {
		// 拉邮箱验证开关（决定注册模态框是否显示验证码输入）
		fetchMe().then((me) => (authCfg = { mailVerify: me.mailVerify, registerEnabled: me.registerEnabled ?? false, createRequireAccount: me.createRequireAccount ?? false })).catch(() => {});
		const nickname = getNickname();
		if (nickname) {
			start(nickname);
		} else {
			// 直接打开房间链接且没有昵称：就地弹框收集昵称（访问码 hash 原样保留）。
			// joining 复位：初始 true 只是"正在加入"占位，不复位会拦住模态框的提交
			showNameModal = true;
			joining = false;
		}
		// 清理函数无条件返回：补昵称后 start() 同样会建立连接，
		// 无论哪条路径，SPA 导航离开时都要断开 LiveKit 与成员同步 WS，
		// 否则人已回大厅、房间里的连接（可能还开着麦）仍挂在后台
		return () => {
			// 离开页面 = 离开房间：断开 LiveKit + 关闭 WS（后端据此移除成员）
			left = true;
			clearTimeout(wsReconnectTimer);
			clearTimeout(toastTimer);
			ws?.close();
			controller?.leave();
		};
	});

	async function start(nickname: string) {
		joining = true;
		joinError = '';
		try {
			// 1. 找 Go 后端拿 LiveKit 令牌（带访问码；后端同时校验门禁并登记房间）
			const t = await fetchToken(roomName, nickname, readCode());
			saveTicket(roomName, t.ticket);
			// 2. 用令牌连接 LiveKit 媒体服务器，媒体层全部由 SDK 接管
			controller = new VoiceRoom();
			await controller.connect(t.url, t.token);
			// 3. 连接 Go 后端的成员同步通道
			watchRoomWs(nickname);
		} catch (e) {
			if (e instanceof TokenError && e.needsCode) {
				// 房间有访问码：展示输码界面
				needsCode = true;
				codeError = e.message;
			} else if (e instanceof TokenError && e.needsAccount) {
				// 新建房间需要账号：弹注册/登录框，成功后自动重试
				retryNickname = nickname;
				showAuthModal = true;
			} else {
				joinError = e instanceof Error ? e.message : '加入房间失败';
			}
		} finally {
			joining = false;
		}
	}

	// 注册/登录成功：用账号昵称补齐并自动重试进房（这次会作为创建者）
	async function onAuthenticated(acc: Account) {
		showAuthModal = false;
		if (!getNickname()) {
			setNickname(acc.nickname);
		}
		showNameModal = false;
		start(retryNickname || acc.nickname);
	}

	// 输码重试：成功后与正常进入完全一致
	async function submitCode() {
		const nickname = getNickname();
		if (!nickname || !codeInput.trim() || codeSubmitting) return;
		codeSubmitting = true;
		codeError = '';
		try {
			const t = await fetchToken(roomName, nickname, codeInput.trim());
			saveTicket(roomName, t.ticket);
			try {
				sessionStorage.setItem(codeKeyFor(roomName), codeInput.trim());
			} catch {
				/* 忽略 */
			}
			needsCode = false;
			controller = new VoiceRoom();
			await controller.connect(t.url, t.token);
			watchRoomWs(nickname);
		} catch (e) {
			codeError = e instanceof TokenError ? e.message : e instanceof Error ? e.message : '验证失败';
			// 直接输码重试也可能撞上"新建需登录"：一并弹账号框
			if (e instanceof TokenError && e.needsAccount) {
				retryNickname = getNickname() ?? '';
				showAuthModal = true;
			}
		} finally {
			codeSubmitting = false;
		}
	}

	// 邀请链接：带房间名（和本会话的访问码，朋友点开免输码）。
	// 码放在 #fragment 里——fragment 不会被浏览器发给服务器，不进任何访问日志
	async function share() {
		const code = readCode();
		const link = `${location.origin}/room/${encodeURIComponent(roomName)}${code ? `#code=${encodeURIComponent(code)}` : ''}`;
		try {
			await navigator.clipboard.writeText(link);
			showToast('邀请链接已复制，发给朋友即可');
		} catch {
			showToast(link); // 剪贴板不可用就把链接直接展示出来
		}
	}

	function watchRoomWs(nickname: string) {
		let url = backendWsUrl(`?room=${encodeURIComponent(roomName)}&name=${encodeURIComponent(nickname)}`);
		const ticket = readTicket(roomName);
		if (ticket) url += `&ticket=${encodeURIComponent(ticket)}`;
		ws = new WebSocket(url);
		ws.onmessage = (e) => {
			const msg = JSON.parse(e.data);
			if (msg.room && msg.room !== roomName) return;
			if (msg.type === 'members') applyMembers(msg.members);
			else if (msg.type === 'init') applyMembers(msg.members ?? []);
		};
		ws.onclose = () => {
			// 断线重连：后端会把重连视为新成员（旧记录已随连接断开被清理）
			if (left) return;
			wsSeeded = false;
			wsReconnectTimer = setTimeout(() => watchRoomWs(getNickname() ?? ''), 3000);
		};
	}

	// 差分上一份/当前成员快照，生成进出提示
	function applyMembers(list: Member[]) {
		const incoming = new Map(list.map((m) => [m.id, m.name]));
		if (wsSeeded) {
			for (const [id, name] of incoming) {
				if (!knownMembers.has(id)) showToast(`${name} 加入了房间`);
			}
			for (const [id, name] of knownMembers) {
				if (!incoming.has(id)) showToast(`${name} 离开了房间`);
			}
		}
		knownMembers = incoming;
		wsSeeded = true;
	}

	function showToast(text: string) {
		toast = text;
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toast = ''), 4000);
	}

	async function leave() {
		left = true;
		ws?.close();
		await controller?.leave();
		await goto('/');
	}
</script>

<svelte:head>
	<title>{roomName} · 回声室</title>
</svelte:head>

<svelte:window onclick={onDocClick} />

{#if showNameModal}
	<!-- 链接进房缺昵称：就地输入昵称直接进房（访问码在 #hash 里原样保留） -->
	<div class="fixed inset-0 z-40 flex items-end justify-center p-4 sm:items-center">
		<button
			type="button"
			aria-label="取消加入"
			class="absolute inset-0 cursor-default bg-black/55 backdrop-blur-md"
			onclick={() => {
				showNameModal = false;
				goto('/');
			}}
		></button>
		<div
			role="dialog"
			aria-modal="true"
			aria-label="设置昵称"
			class="pop-in relative z-10 w-full max-w-sm rounded-2xl border bg-popover/90 p-6 shadow-2xl shadow-black/25 backdrop-blur-2xl dark:shadow-black/60"
		>
			<button
				type="button"
				aria-label="关闭"
				class="absolute right-3 top-3 rounded-full p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
				onclick={() => {
					showNameModal = false;
					goto('/');
				}}
			>
				<Icon name="x" class="size-4" />
			</button>
			<div class="flex flex-col items-center text-center">
				<div
					class="mb-3.5 flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-300 to-teal-400 text-zinc-950 shadow-lg shadow-primary/30"
				>
					<Icon name="mic" class="size-6" />
				</div>
				<h2 class="text-lg font-semibold tracking-tight">加入「{roomName}」</h2>
				<p class="mt-1 text-sm text-muted-foreground">先告诉大家怎么称呼你</p>
			</div>
			<form
				class="mt-5 flex flex-col gap-3"
				onsubmit={(e) => {
					e.preventDefault();
					confirmNickname();
				}}
			>
				<Input
					bind:el={nameInputEl}
					bind:value={nameDraft}
					placeholder="你的昵称"
					maxlength={32}
					aria-label="你的昵称"
					class="h-12 rounded-xl bg-muted/40 text-center text-base"
				/>
				<Button
					type="submit"
					size="lg"
					class="mt-1 h-12 rounded-xl font-semibold shadow-lg shadow-primary/25"
					disabled={!nameDraft.trim() || joining}
				>
					{#if joining}
						<Icon name="loader" class="size-4 animate-spin" />
					{:else}
						<Icon name="log-in" />
					{/if}
					进入房间
				</Button>
				<Button
					variant="ghost"
					size="sm"
					type="button"
					class="text-muted-foreground"
					onclick={() => {
						showNameModal = false;
						goto('/');
					}}
				>
					返回大厅
				</Button>
			</form>
		</div>
	</div>
{/if}

<main class="mx-auto w-full max-w-5xl px-3 pb-36 pt-4 sm:px-6 sm:pt-6">
	<!-- 玻璃顶栏 -->
	<header
		class="fade-up sticky top-4 z-20 flex items-center gap-3 rounded-xl border bg-popover/70 px-4 py-3 shadow-xl shadow-black/5 dark:shadow-black/30 backdrop-blur-xl"
	>
		<Button variant="ghost" size="icon" aria-label="返回大厅" onclick={leave}>
			<Icon name="arrow-left" />
		</Button>
		<div class="min-w-0 flex-1">
			<h1 class="truncate text-[15px] font-semibold tracking-tight">{roomName}</h1>
			<p class="flex items-center gap-1.5 text-xs text-muted-foreground">
				{#if controller?.status === 'connected'}
					<span class="breathe inline-block size-1.5 rounded-full bg-primary"></span>
					{controller.members.length} 人在线 · 语音已连接
				{:else if controller?.status === 'connecting' || joining}
					<span class="inline-block size-1.5 animate-pulse rounded-full bg-amber-500 dark:bg-amber-300"></span>
					正在连接…
				{:else if controller?.status === 'disconnected'}
					<span class="inline-block size-1.5 rounded-full bg-red-500 dark:bg-red-400"></span>
					连接已断开
				{:else if controller?.status === 'error'}
					<span class="inline-block size-1.5 rounded-full bg-red-500 dark:bg-red-400"></span>
					连接出错
				{/if}
			</p>
		</div>
		<ThemeToggle />
		{#if controller?.status === 'connected'}
			<!-- 手机上只留图标，桌面显示文字 -->
			<Button variant="outline" size="icon" class="sm:hidden" aria-label="邀请" title="邀请" onclick={share}>
				<Icon name="link" />
			</Button>
			<Button variant="outline" size="sm" class="hidden sm:inline-flex" onclick={share}>
				<Icon name="link" />
				邀请
			</Button>
		{/if}
		<Button variant="outline" size="icon" class="sm:hidden" aria-label="离开房间" onclick={leave}>
			<Icon name="log-out" />
		</Button>
		<Button variant="outline" size="sm" class="hidden sm:inline-flex" onclick={leave}>
			<Icon name="log-out" />
			离开房间
		</Button>
	</header>

	<!-- 成员进出 toast -->
	{#if toast}
		<div class="pointer-events-none fixed left-1/2 top-6 z-30 -translate-x-1/2">
			<div
				class="fade-up flex items-center gap-2 rounded-full border bg-popover/95 px-4 py-2 text-sm text-foreground/90 shadow-2xl shadow-black/10 dark:shadow-black/40 backdrop-blur-xl"
			>
				<Icon name="users" class="size-3.5 text-primary" />
				{toast}
			</div>
		</div>
	{/if}

	{#if needsCode}
		<!-- 访问码门禁：手动输入房间名（没带码的链接）进有密码房间时会走到这里 -->
		<Card class="mx-auto mt-16 max-w-md">
			<CardContent class="flex flex-col items-center gap-4 py-10 text-center">
				<div
					class="flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary ring-1 ring-primary/25"
				>
					<Icon name="mic" class="size-5" />
				</div>
				<div>
					<p class="font-semibold">此房间需要访问码</p>
					<p class="mt-1 text-sm text-muted-foreground">向房间里的朋友要一个，或点他发的邀请链接</p>
				</div>
				<form
					class="flex w-full flex-col gap-3"
					onsubmit={(e) => {
						e.preventDefault();
						submitCode();
					}}
				>
					<Input
						bind:value={codeInput}
						placeholder="访问码"
						maxlength={32}
						aria-label="访问码"
						class="h-11 text-center"
					/>
					{#if codeError}
						<p class="text-sm text-red-600 dark:text-red-300">{codeError}</p>
					{/if}
					<Button type="submit" size="lg" disabled={!codeInput.trim() || codeSubmitting}>
						{#if codeSubmitting}
							<Icon name="loader" class="size-4 animate-spin" />
						{:else}
							<Icon name="log-in" />
						{/if}
						验证并进入
					</Button>
				</form>
				<Button variant="ghost" size="sm" onclick={leave}>
					<Icon name="arrow-left" />
					返回大厅
				</Button>
			</CardContent>
		</Card>
	{:else if joining || !controller}
		<Card class="mt-10">
			<CardContent class="flex flex-col items-center gap-4 py-16 text-muted-foreground">
				<Icon name="loader" class="size-8 animate-spin text-primary" />
				<p class="text-sm">正在加入「{roomName}」…</p>
			</CardContent>
		</Card>
	{:else if controller.status === 'error' || controller.status === 'disconnected'}
		<Card class="mx-auto mt-16 max-w-md">
			<CardContent class="flex flex-col items-center gap-4 py-10 text-center">
				<div
					class="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive ring-1 ring-destructive/25"
				>
					<Icon name="volume-x" class="size-5" />
				</div>
				<div>
					<p class="font-semibold">
						{controller.status === 'error' ? '加入失败' : '已与房间断开'}
					</p>
					<p class="mt-1 text-sm text-muted-foreground">
						{controller.status === 'error'
							? controller.errorMsg || joinError
							: '可能是同名连接顶替或网络中断，请返回大厅重新进入'}
					</p>
				</div>
				<Button variant="outline" onclick={leave}>
					<Icon name="arrow-left" />
					返回大厅
				</Button>
			</CardContent>
		</Card>
	{:else}
		{#if !controller.canPlaybackAudio}
			<!-- 浏览器自动播放拦截的解锁入口：点击后带用户手势调 startAudio() -->
			<div
				class="fade-up mt-6 flex items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-400/10 px-5 py-3.5 backdrop-blur-xl dark:border-amber-300/25 dark:bg-amber-400/[0.08]"
			>
				<p class="flex items-center gap-2.5 text-sm text-amber-700 dark:text-amber-200">
					<Icon name="volume-x" class="size-4 shrink-0" />
					浏览器拦截了自动播放，需要你手动开启声音
				</p>
				<Button size="sm" onclick={() => controller?.unlockAudio()}>点击开启声音</Button>
			</div>
		{/if}

		{#if controller.errorMsg}
			<p class="mt-4 text-sm text-red-600 dark:text-red-300">{controller.errorMsg}</p>
		{/if}

		<!-- 成员网格 -->
		<section class="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
			{#each controller.members as m, i (m.identity)}
				<div
					class="fade-up relative flex flex-col items-center gap-3 rounded-xl border py-7 text-center backdrop-blur-xl transition-all duration-300 {m.speaking
						? 'border-primary/45 bg-primary/[0.07] shadow-[0_0_36px_-8px] shadow-primary/40'
						: 'bg-card shadow-xl shadow-black/5 dark:shadow-black/20'}"
					style="--delay: {i * 60}ms"
				>
					{#if m.rtt !== undefined}
						<!-- 右上角延迟：点击弹出该成员的网络信息（IP / 延迟） -->
						<button
							type="button"
							data-net-badge
							class="absolute right-2 top-2 flex cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-[11px] tabular-nums transition-colors hover:bg-muted/70 {m.rtt < 80
								? 'text-emerald-600 dark:text-emerald-400'
								: m.rtt < 200
									? 'text-amber-600 dark:text-amber-400'
									: 'text-red-600 dark:text-red-400'}"
							title="点击查看网络信息"
							onclick={() => (netPopoverId = netPopoverId === m.identity ? null : m.identity)}
						>
							<span
								class="size-1.5 rounded-full {m.rtt < 80
									? 'bg-emerald-500'
									: m.rtt < 200
										? 'bg-amber-500'
										: 'bg-red-500'}"
							></span>
							{m.rtt}ms
						</button>
						{#if netPopoverId === m.identity}
							<div
								data-net-popover
								class="pop-in absolute right-1 top-9 z-20 w-48 rounded-xl border bg-popover/95 p-3 text-left shadow-xl shadow-black/15 backdrop-blur-xl dark:shadow-black/50"
							>
								<p class="mb-2 truncate text-xs font-semibold">{m.name} · 网络信息</p>
								<div class="flex items-center justify-between gap-3 text-xs">
									<span class="text-muted-foreground">公网 IP</span>
									<span class="truncate font-mono text-foreground">{m.ip || '未知'}</span>
								</div>
								<div class="mt-1.5 flex items-center justify-between gap-3 text-xs">
									<span class="text-muted-foreground">延迟</span>
									<span class="font-mono {m.rtt < 80
										? 'text-emerald-600 dark:text-emerald-400'
										: m.rtt < 200
											? 'text-amber-600 dark:text-amber-400'
											: 'text-red-600 dark:text-red-400'}">{m.rtt} ms</span>
								</div>
								<p class="mt-2 border-t border-border/60 pt-1.5 text-[10px] leading-relaxed text-muted-foreground/60">
									延迟与公网 IP 由成员各自的浏览器经数据通道上报，仅房间内互相可见
								</p>
							</div>
						{/if}
					{/if}
					<Avatar name={m.name} speaking={m.speaking} class="size-14 text-lg" />
					<div class="px-3">
						<span class="font-medium">{m.name}</span>
						{#if m.isLocal}<span class="ml-1 text-xs text-muted-foreground">（我）</span>{/if}
					</div>
					{#if m.speaking}
						<!-- 说话中：声纹均衡器 + 文案 -->
						<span class="flex items-center gap-2 text-xs font-medium text-primary">
							<span class="eq"><i></i><i></i><i></i><i></i></span>
							正在说话
						</span>
					{:else if m.micMuted}
						<Badge variant="secondary">
							<Icon name="mic-off" class="size-3" />
							已闭麦
						</Badge>
					{:else}
						<Badge variant="success">
							<Icon name="mic" class="size-3" />
							麦克风开启
						</Badge>
					{/if}
					{#if m.bgm}
						{#if m.bgmName}
							<!-- 正在放歌：显示歌名，太长就在徽章里滚动（悬停可看全名） -->
							<Badge variant="secondary" class="max-w-full" title="{m.bgmName}{m.bgmPlaying ? '' : '（已暂停）'}">
								<Icon name="disc" class="size-3 shrink-0 {m.bgmPlaying ? 'spin-slow' : ''}" />
								<span class="marquee min-w-0 flex-1" use:marquee={m.bgmName}>
									<span class="marquee-track">
										<span>{m.bgmName}</span>
										<span aria-hidden="true">{m.bgmName}</span>
									</span>
								</span>
							</Badge>
						{:else}
							<Badge variant="secondary">
								<Icon name="disc" class="size-3" />
								背景音乐
							</Badge>
						{/if}
					{/if}
					{#if !m.isLocal}
						<!-- 按人独立调音量：0-100%，步进 1（对方声音太大/太小时用） -->
						<div class="flex w-full items-center gap-2 px-4">
							<Icon name="volume" class="size-3.5 shrink-0 text-muted-foreground" />
							<input
								type="range"
								min="0"
								max="100"
								step="1"
								value={m.volume}
								aria-label="{m.name} 的音量"
								class="h-6 w-full cursor-pointer accent-primary sm:h-1"
								oninput={(e) => controller?.setVolume(m.identity, +e.currentTarget.value, true)}
							/>
							<span class="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
								{m.volume}%
							</span>
						</div>
					{/if}
				</div>
			{/each}
		</section>

		<!-- 底部悬浮操作条：背景音乐 + 麦克风（主操作）+ 音频设置 -->
		<input
			bind:this={bgmFileInput}
			type="file"
			accept="audio/*"
			multiple
			class="hidden"
			onchange={(e) => {
				const files = Array.from(e.currentTarget.files ?? []);
				if (files.length) controller?.addBgmFiles(files);
				e.currentTarget.value = ''; // 允许再次选择同一批文件
			}}
		/>


		<footer class="fixed inset-x-0 bottom-7 z-20 flex justify-center">
			<!-- 面板挂在 footer（fixed，全宽）上居中：手机上不会溢出屏幕；
			     内层 div 才放 fade-up 动画，避免动画 transform 冲掉居中偏移 -->
			<div class="flex items-center gap-2.5">
				<!-- 背景音乐：上传音乐文件，作为独立音轨播放给全房间。单击开合面板 -->
				<Button
					variant="outline"
					aria-label="背景音乐面板"
					aria-expanded={showBgmPanel}
					title="背景音乐播放列表"
					class={cn(
						'h-9 w-9 overflow-hidden p-0 sm:h-9 sm:w-auto sm:px-4',
						controller.bgmActive
							? 'border-primary/50 bg-primary/10 text-primary'
							: 'text-muted-foreground sm:text-foreground'
					)}
					onclick={() => (showBgmPanel = !showBgmPanel)}
				>
					<Icon name="music" class="size-4 shrink-0" />
					<span class="hidden text-sm sm:inline">背景音乐</span>
				</Button>

				<div class="relative">
					{#if controller.micEnabled}
						<div class="absolute inset-0 rounded-full bg-destructive/30 blur-xl"></div>
					{/if}
					<Button
						size="lg"
						variant={controller.micEnabled ? 'destructive' : 'success'}
						onclick={() => controller?.toggleMic()}
						class="relative min-w-48 {controller.micEnabled ? '' : 'glow-pulse'}"
					>
						<Icon name={controller.micEnabled ? 'mic' : 'mic-off'} />
						{controller.micEnabled ? '关闭麦克风' : '打开麦克风'}
					</Button>
				</div>

				<!-- 音频设置 -->
				<Button
					variant="outline"
					size="icon"
					aria-label="音频设置"
					title="音频设置"
					class={showAudioSettings ? 'border-primary/50 bg-primary/10 text-primary' : ''}
					onclick={() => (showAudioSettings = !showAudioSettings)}
				>
					<Icon name="settings" />
				</Button>

				{#if showBgmPanel}
					<div class="absolute bottom-16 left-1/2 z-30 w-[min(21rem,calc(100vw-2rem))] -translate-x-1/2">
					<div
						bind:this={bgmPanelEl}
						role="group"
						aria-label="背景音乐播放器"
						class="fade-up rounded-xl border bg-popover/95 p-4 shadow-2xl shadow-black/10 dark:shadow-black/40 backdrop-blur-xl"
					>
						<div class="mb-3 flex items-center justify-between">
							<span class="text-sm font-semibold">背景音乐</span>
							<Badge variant={controller.bgmActive ? 'success' : 'secondary'}>
								{controller.bgmActive ? (controller.bgmPlaying ? '播放中' : '已暂停') : '未播放'}
							</Badge>
						</div>

						<!-- 当前进度 -->
						{#if controller.bgmActive}
							<div class="mb-3 h-1 overflow-hidden rounded bg-muted">
								<div
									class="h-full rounded bg-primary/70 transition-all duration-300"
									style="width: {controller.bgmProgress}%"
								></div>
							</div>
						{/if}

						<!-- 添加入口 -->
						<Button
							variant="outline"
							size="sm"
							class="mb-3 w-full"
							onclick={() => bgmFileInput?.click()}
						>
							<Icon name="plus" />
							添加音乐文件（可多选）
						</Button>

						<!-- 播放列表 -->
						<div class="mb-3 flex max-h-44 flex-col gap-1 overflow-y-auto">
							{#each controller.bgmTracks as t, i (t.url)}
								<div
									class="group flex items-center gap-2 rounded-md px-2 py-1.5 {i === controller.bgmIndex &&
									controller.bgmActive
										? 'bg-primary/10'
										: 'hover:bg-muted/60'}"
								>
									<button
										type="button"
										class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
										onclick={() => controller?.playBgmIndex(i)}
									>
										<Icon
											name={i === controller.bgmIndex && controller.bgmActive
												? 'audio-lines'
												: 'music'}
											class="size-3.5 shrink-0 {i === controller.bgmIndex && controller.bgmActive
												? 'text-primary'
												: 'text-muted-foreground'}"
										/>
										<span class="truncate text-sm {i === controller.bgmIndex && controller.bgmActive
											? 'text-foreground'
											: 'text-muted-foreground'}">
											{t.name}
										</span>
									</button>
									<button
										type="button"
										class="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
										aria-label="移除 {t.name}"
										onclick={() => controller?.removeBgmTrack(i)}
									>
										<Icon name="x" class="size-3.5" />
									</button>
								</div>
							{/each}
						</div>

						<!-- 控制条 -->
						<div class="flex items-center justify-between gap-2 border-t pt-3">
							<div class="flex items-center gap-1">
								<Button
									variant="ghost"
									size="icon"
									class="size-8"
									aria-label="上一首"
									disabled={controller.bgmTracks.length === 0}
									onclick={() => controller?.bgmPrev()}
								>
									<Icon name="skip-back" />
								</Button>
								<Button
									size="icon"
									class="size-9"
									aria-label={controller.bgmPlaying ? '暂停' : '播放'}
									disabled={controller.bgmTracks.length === 0}
									onclick={() => controller?.toggleBgmPlay()}
								>
									<Icon name={controller.bgmPlaying ? 'pause' : 'play'} />
								</Button>
								<Button
									variant="ghost"
									size="icon"
									class="size-8"
									aria-label="下一首"
									disabled={controller.bgmTracks.length === 0}
									onclick={() => controller?.bgmNext()}
								>
									<Icon name="skip-forward" />
								</Button>
							</div>
							<div class="flex items-center gap-1.5">
								<button
									type="button"
									class="rounded px-1.5 py-1 text-xs transition-colors {controller.bgmLoopSingle
										? 'bg-primary/15 text-primary'
										: 'text-muted-foreground hover:text-foreground'}"
									aria-label={controller.bgmLoopSingle ? '单曲循环：开' : '单曲循环：关'}
									onclick={() => controller?.toggleBgmLoop()}
								>
									单曲
								</button>
								<Icon name="volume" class="size-3.5 text-muted-foreground" />
								<input
									type="range"
									min="0"
									max="100"
									step="1"
									value={controller.bgmVolume}
									aria-label="背景音乐音量"
									class="h-6 w-16 cursor-pointer accent-primary sm:h-1"
									oninput={(e) => controller?.setBgmVolume(+e.currentTarget.value)}
								/>
							</div>
						</div>

						{#if controller.bgmActive}
							<Button
								variant="destructive"
								size="sm"
								class="mt-3 w-full"
								onclick={() => controller?.stopBgm()}
							>
								停止并清空列表
							</Button>
						{/if}
					</div>
					</div>
				{/if}

				{#if showAudioSettings}
					<div class="absolute bottom-16 left-1/2 z-30 w-[min(20rem,calc(100vw-2rem))] -translate-x-1/2">
					<div
						class="fade-up rounded-xl border bg-popover/95 p-4 shadow-2xl shadow-black/10 dark:shadow-black/40 backdrop-blur-xl"
					>
						<div class="mb-3 flex items-center justify-between">
							<span class="text-sm font-semibold">音频设置</span>
							<Badge variant={controller.tuning.musicMode ? 'success' : 'secondary'}>
								{controller.tuning.musicMode ? '音乐模式' : '语音模式'}
							</Badge>
						</div>

						<!-- 麦克风：你的声音 -->
						<div class="mb-1.5 flex items-center gap-1.5">
							<Icon name="mic" class="size-3.5 text-primary" />
							<span class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
								麦克风 · 你的声音
							</span>
						</div>
							<div class="flex flex-col gap-3 border-b pb-3">
								<!-- 人声提取 -->
								<div class="flex items-center justify-between gap-3">
									<div class="min-w-0">
										<div class="flex items-center gap-1.5 text-sm font-medium">
											<Icon name="audio-lines" class="size-3.5 text-primary" />
											人声提取（AI 强降噪）
										</div>
										<div class="text-xs text-muted-foreground">RNNoise 模型，滤掉键盘声等突发噪声</div>
									</div>
									<button
										type="button"
										role="switch"
										aria-checked={controller.tuning.aiDenoise}
										aria-label="人声提取"
										class="relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors {controller.tuning
											.aiDenoise
											? 'bg-primary'
											: 'bg-muted-foreground/30'}"
										onclick={() =>
											controller?.applyTuning({
												...controller.tuning,
												aiDenoise: !controller.tuning.aiDenoise
											})}
									>
										<span
											class="absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform {controller
												.tuning.aiDenoise
												? 'translate-x-4'
												: ''}"
										></span>
									</button>
								</div>
								<!-- 麦克风音量 + 电平条 -->
								<div class="flex flex-col gap-1.5">
									<div class="flex items-center justify-between gap-3">
										<div class="text-sm font-medium">麦克风音量</div>
										<span class="text-xs tabular-nums text-muted-foreground">
											{controller.tuning.micGain}%
										</span>
									</div>
									<input
										type="range"
										min="0"
										max="200"
										step="5"
										value={controller.tuning.micGain}
										aria-label="麦克风音量"
										class="h-6 w-full cursor-pointer accent-primary sm:h-1"
										oninput={(e) => controller?.setMicGain(+e.currentTarget.value)}
									/>
									<div class="h-1.5 overflow-hidden rounded bg-muted">
										<div
											class="h-full rounded bg-emerald-500/70 transition-all duration-150"
											style="width: {Math.min(100, inputLevel * 300)}%"
										></div>
									</div>
									<p class="text-xs text-muted-foreground">
										说话看电平条：偶尔接近满格说明合适；一直顶满就调低，几乎不动就调高
									</p>
								</div>
								{#each audioToggles as t (t.key)}
									<div class="flex items-center justify-between gap-3">
										<div class="min-w-0">
											<div class="text-sm">{t.label}</div>
											<div class="text-xs text-muted-foreground">{t.desc}</div>
											{#if t.key === 'echoCancellation' && controller.echoLevelDb !== null}
												<!-- Chrome 发布端统计的回声抑制量：对方出声时应明显高于 0 -->
												<div
													class="mt-0.5 text-xs tabular-nums {controller.echoLevelDb > 3
														? 'text-emerald-600 dark:text-emerald-400'
														: 'text-amber-600 dark:text-amber-400'}"
												>
													回声抑制 {controller.echoLevelDb.toFixed(1)} dB{controller.echoLevelDb > 3
														? '（工作正常）'
														: '（对方出声时才明显）'}
												</div>
											{/if}
										</div>
										<button
											type="button"
											role="switch"
											aria-checked={controller.tuning[t.key]}
											aria-label={t.label}
											class="relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors {controller.tuning[t.key]
												? 'bg-primary'
												: 'bg-muted-foreground/30'}"
											onclick={() =>
												controller?.applyTuning({
													...controller.tuning,
													[t.key]: !controller.tuning[t.key]
												})}
										>
											<span
												class="absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform {controller
													.tuning[t.key]
													? 'translate-x-4'
													: ''}"
											></span>
										</button>
									</div>
								{/each}
								<!-- 音乐模式：唱歌/乐器时保真收音（默认关闭） -->
								<div class="flex items-center justify-between gap-3">
									<div class="min-w-0">
										<div class="text-sm font-medium">音乐模式（唱歌/乐器）</div>
										<div class="text-xs text-muted-foreground">
											关闭所有降噪/增益，高音质立体声收音；放文件请用背景音乐
										</div>
									</div>
									<button
										type="button"
										role="switch"
										aria-checked={controller.tuning.musicMode}
										aria-label="音乐模式"
										class="relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors {controller.tuning
											.musicMode
											? 'bg-primary'
											: 'bg-muted-foreground/30'}"
										onclick={() =>
											controller?.applyTuning({
												...controller.tuning,
												musicMode: !controller.tuning.musicMode
											})}
									>
										<span
											class="absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform {controller
												.tuning.musicMode
												? 'translate-x-4'
												: ''}"
										></span>
									</button>
								</div>
							</div>
							{#if controller.tuning.musicMode}
								<p class="mb-3 text-xs leading-relaxed text-amber-700 dark:text-amber-200">
									音乐模式已开启：麦克风关闭所有降噪/增益，高音质立体声收音。日常说话建议关闭。
								</p>
							{/if}
							<!-- 播放：朋友的声音 -->
							<div class="mb-1.5 mt-4 flex items-center gap-1.5">
								<Icon name="volume" class="size-3.5 text-primary" />
								<span class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
									播放 · 朋友的声音
								</span>
							</div>
							<div class="flex flex-col gap-3">
								<!-- 自动舒适音量 -->
								<div class="flex items-center justify-between gap-3">
									<div class="min-w-0">
										<div class="text-sm font-medium">自动舒适音量</div>
										<div class="text-xs text-muted-foreground">
											按说话音量自动微调每人的播放音量；手动拖过滑杆的成员不参与
										</div>
									</div>
									<button
										type="button"
										role="switch"
										aria-checked={controller.autoComfort}
										aria-label="自动舒适音量"
										class="relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors {controller
											.autoComfort
											? 'bg-primary'
											: 'bg-muted-foreground/30'}"
										onclick={() => controller?.setAutoComfort(!controller.autoComfort)}
									>
										<span
											class="absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow transition-transform {controller
												.autoComfort
												? 'translate-x-4'
												: ''}"
										></span>
									</button>
								</div>
							</div>
						<p class="mt-3 border-t pt-2.5 text-xs text-muted-foreground">
							除音量外的开关切换都会让麦克风短暂重启；人声提取失效时会自动退回浏览器降噪
						</p>
					</div>
					</div>
				{/if}
			</div>
		</footer>
	{/if}

	<!-- 注册/登录：创建房间被拦时弹出，成功后自动重试进房 -->
	<AccountModal
		open={showAuthModal}
		config={authCfg}
		title={`创建「${roomName}」`}
		desc="创建房间需要账号，完成注册后自动继续"
		callback={onAuthenticated}
	/>
</main>