<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { backendWsUrl, fetchRooms, type RoomInfo } from '#lib/api';
	import { getNickname, setNickname } from '#lib/identity';
	import {
		AccountModal,
		Avatar,
		Button,
		Card,
		CardContent,
		Icon,
		Input,
		ProfileModal,
		ThemeToggle
	} from '#lib/ui';
	import { fetchMe, logoutAccount, type Account, type AuthConfig } from '#lib/api';

	let nickname = $state('');
	let roomName = $state('');
	let accessCode = $state('');
	let rooms = $state<RoomInfo[]>([]);
	let joining = $state(false);
	let loading = $state(true);
	let errorMsg = $state('');
	let nicknameInputEl = $state<HTMLInputElement | null>(null);

	// —— 账号状态 ——
	let user = $state<Account | null>(null);
	let authCfg = $state<AuthConfig>({ mailVerify: false, registerEnabled: false, createRequireAccount: false });
	let showAuthModal = $state(false);
	// 未登录点了"创建房间"时暂存意图，登录成功后自动继续
	let pendingCreate = $state<{ name: string; code: string } | null>(null);
	let userMenuOpen = $state(false); // 顶栏账号下拉菜单
	let profileOpen = $state(false); // 个人资料模态框

	function onDocClick(e: MouseEvent) {
		if (!userMenuOpen) return;
		const el = e.target instanceof Element ? e.target : null;
		if (!el?.closest('[data-user-menu]')) userMenuOpen = false;
	}

	// 上下文感知的访问码：随输入的房间名实时比对在线房间列表——
	// 新房间 → 显示"设置访问码（选填）"（进入即创建，码成为门禁）；
	// 已存在的带码房间 → 显示"访问码"（进入必须）；已存在的无码房间 → 不显示
	const matchedRoom = $derived(rooms.find((r) => r.name === roomName.trim()));
	const isCreating = $derived(roomName.trim() !== '' && !matchedRoom);
	const needsCode = $derived(matchedRoom?.hasPassword === true);

	// 游客点房间卡片：虚化背景的模态框，输入昵称（有码房间还要输码）才能加入
	let joinModal = $state<{ name: string; needsCode: boolean } | null>(null);
	let modalName = $state('');
	let modalCode = $state('');
	let modalNameEl = $state<HTMLInputElement | null>(null);
	let modalCodeEl = $state<HTMLInputElement | null>(null);

	$effect(() => {
		if (joinModal) {
			// 等输入框挂载：没昵称聚焦昵称框；已有昵称的带码房间聚焦码框
			setTimeout(() => (joinModal?.needsCode && modalName.trim() ? modalCodeEl : modalNameEl)?.focus(), 60);
		}
	});

	function openJoinModal(room: RoomInfo) {
		modalName = nickname.trim();
		modalCode = '';
		joinModal = { name: room.name, needsCode: room.hasPassword };
	}

	function confirmJoinModal(e: SubmitEvent) {
		e.preventDefault();
		const room = joinModal;
		const n = modalName.trim();
		const code = modalCode.trim();
		if (!room || !n || joining) return;
		if (room.needsCode && !code) {
			modalCodeEl?.focus();
			return;
		}
		setNickname(n);
		nickname = n;
		joinModal = null;
		joining = true;
		goto(`/room/${encodeURIComponent(room.name)}${code ? `#code=${encodeURIComponent(code)}` : ''}`);
	}

	let ws: WebSocket | null = null;
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

	// 处理 /?join=房间名：旧版房间页回跳带来的待加入目标（新版房间页就地弹框，此路径仅剩历史链接）
	const pendingJoin = $derived(page.url.searchParams.get('join'));

	onMount(() => {
		nickname = getNickname() ?? '';
		// 链接带来的房间名预填，减少一次输入
		if (pendingJoin) roomName = pendingJoin;
		// 登录态：拉当前账号；登录账号且没设过昵称时默认用账号昵称
		fetchMe()
			.then((me) => {
				user = me.user;
				authCfg = { mailVerify: me.mailVerify, registerEnabled: me.registerEnabled ?? false, createRequireAccount: me.createRequireAccount ?? false };
				if (me.user && !nickname) {
					nickname = me.user.nickname;
					setNickname(nickname);
				}
			})
			.catch(() => {
				/* me 接口失败按未登录处理 */
			});
		// 昵称已存在时直接送进目标房间（hash 里的访问码原样带回）
		if (pendingJoin && nickname) {
			goto(`/room/${encodeURIComponent(pendingJoin)}${location.hash}`);
			return;
		}
		loadRooms();
		connectLobbyWs();
		return () => {
			clearTimeout(reconnectTimer);
			ws?.close();
		};
	});

	function onAuthenticated(acc: Account) {
		user = acc;
		showAuthModal = false;
		// 用账号昵称补默认昵称
		if (!nickname.trim()) {
			nickname = acc.nickname;
			setNickname(nickname);
		}
		// 登录前点了"创建房间"：自动继续创建
		if (pendingCreate) {
			const { name, code } = pendingCreate;
			pendingCreate = null;
			join(name, code);
		}
	}

	async function doLogout() {
		await logoutAccount();
		user = null;
	}

	async function loadRooms() {
		try {
			rooms = (await fetchRooms()).rooms;
		} catch {
			/* 首屏拉取失败不打断，WebSocket 连上后会再推一份 */
		} finally {
			loading = false;
		}
	}

	// 大厅订阅后端广播：房间创建/人数变化/空闲注销都会实时推过来
	function connectLobbyWs() {
		ws = new WebSocket(backendWsUrl());
		ws.onmessage = (e) => {
			const msg = JSON.parse(e.data);
			if (msg.type === 'init' || msg.type === 'rooms') rooms = msg.rooms;
		};
		ws.onclose = () => {
			// 断线 3 秒后重连（原型不做指数退避）
			reconnectTimer = setTimeout(connectLobbyWs, 3000);
		};
	}

	// 进房统一入口。code 缺省为空：点房间卡片绝不带上输入框里残留的访问码
	// （那是给"要设/要输码的那一次"用的，带到别的房间只会误事）
	function join(name: string, code = '') {
		const n = nickname.trim();
		const r = name.trim();
		if (!r) return;
		if (!n) {
			errorMsg = '先填昵称，再进入房间';
			nicknameInputEl?.focus();
			return;
		}
		// 创建新房间需要账号：未登录先弹注册/登录模态框，成功后自动继续
		const creating = isCreating;
		if (creating && authCfg.createRequireAccount && !user) {
			pendingCreate = { name: r, code: code.trim() };
			showAuthModal = true;
			return;
		}
		setNickname(n);
		errorMsg = '';
		joining = true;
		// 房间不存在会自动创建（带上访问码即为新房间的门禁）；
		// 码放在 #fragment 里——不会进服务器访问日志。房间页里如果码不对，会展示输码界面。
		// 从带码链接进大厅再进同一房间时，未另填码则原样保留 hash 里的码
		const keepHash = !code.trim() && /code=/.test(location.hash) && r === pendingJoin;
		const suffix = code.trim()
			? `#code=${encodeURIComponent(code.trim())}`
			: keepHash
				? location.hash
				: '';
		goto(`/room/${encodeURIComponent(r)}${suffix}`);
	}

	function submit() {
		join(roomName, accessCode);
	}
</script>

<svelte:head>
	<title>回声室 · 语音聊天大厅</title>
</svelte:head>

<svelte:window onclick={onDocClick} />

<main class="mx-auto w-full max-w-5xl px-4 pb-24 pt-6 sm:px-6 sm:pt-8">
	<!-- 顶栏：品牌 + 主题切换 + 当前身份 -->
	<header class="fade-up flex items-center justify-between" style="--delay: 0ms">
		<div class="flex items-center gap-2.5">
			<div
				class="flex size-8 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-300 to-teal-400 text-zinc-950 shadow-lg shadow-primary/25"
			>
				<Icon name="audio-lines" class="size-4.5" />
			</div>
			<span class="text-[15px] font-semibold tracking-wide">回声室</span>
		</div>
		<div class="flex items-center gap-3">
			<ThemeToggle />
			{#if user}
				<!-- 已登录：头像+昵称下拉菜单（个人资料/退出藏在里面） -->
				<div class="relative" data-user-menu>
					<button
						type="button"
						class="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors hover:bg-muted/60 {userMenuOpen ? 'bg-muted/60' : ''}"
						aria-haspopup="menu"
						aria-expanded={userMenuOpen}
						onclick={() => (userMenuOpen = !userMenuOpen)}
					>
						<Avatar name={user.nickname} class="size-6 text-[10px]" />
						<span class="max-w-24 truncate font-medium text-foreground/85">{user.nickname}</span>
						<span
							class="inline-block size-1.5 border-r-[1.5px] border-b-[1.5px] border-current text-muted-foreground transition-transform duration-200 {userMenuOpen
								? '-rotate-45'
								: 'rotate-45 -translate-y-0.5'}"
						></span>
					</button>
					{#if userMenuOpen}
						<div
							role="menu"
							class="pop-in absolute right-0 top-full z-30 mt-2 w-56 rounded-xl border bg-popover/95 p-1.5 shadow-xl shadow-black/15 backdrop-blur-xl dark:shadow-black/50"
						>
							<!-- 账号头 -->
							<div class="flex items-center gap-3 rounded-lg px-2.5 py-2">
								<Avatar name={user.nickname} class="size-9 shrink-0 text-sm" />
								<div class="min-w-0">
									<p class="truncate text-sm font-semibold">{user.nickname}</p>
									<p class="truncate text-xs text-muted-foreground">{user.email}</p>
								</div>
							</div>
							<div class="my-1 h-px bg-border"></div>
							<button
								type="button"
								role="menuitem"
								class="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors hover:bg-muted"
								onclick={() => { userMenuOpen = false; profileOpen = true; }}
							>
								<Icon name="settings" class="size-4 text-muted-foreground" />
								个人资料
							</button>
							<button
								type="button"
								role="menuitem"
								class="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors hover:bg-muted"
								onclick={async () => { userMenuOpen = false; await doLogout(); }}
							>
								<Icon name="x" class="size-4 text-muted-foreground" />
								退出登录
							</button>
						</div>
					{/if}
				</div>
			{:else if authCfg.registerEnabled || authCfg.createRequireAccount}
				<!-- 未登录：登录入口（账号系统关闭时不显示） -->
				<Button variant="outline" size="sm" class="h-8 rounded-lg" onclick={() => (showAuthModal = true)}>
					<Icon name="users" class="size-3.5" />
					登录 / 注册
				</Button>
			{/if}
		</div>
	</header>

		<!-- Hero -->
		<section class="fade-up mt-10 mb-8 text-center sm:mt-16 sm:mb-12" style="--delay: 60ms">
			<h1
				class="bg-gradient-to-b from-foreground via-foreground to-foreground/45 bg-clip-text text-[2.1rem] leading-tight font-bold tracking-tight text-transparent sm:text-5xl"
			>
				今晚，用声音见面
			</h1>
			<p class="mx-auto mt-3 max-w-md text-[15px] leading-relaxed text-muted-foreground sm:mt-4">
				输入房间名直接进，<span class="text-foreground/80">朋友报房间名就能找到你</span>。
			</p>
		</section>

	<!-- 唯一动作：房间名 + 昵称 + 访问码 → 进入（不存在自动创建）。
	     桌面一行排布；手机纵向堆叠 -->
	<Card class="fade-up mx-auto max-w-2xl gap-0 py-4 sm:py-5" style="--delay: 120ms">
		<CardContent class="px-4 py-0 sm:px-5">
			<form
				class="flex flex-col gap-3 sm:flex-row sm:items-center"
				onsubmit={(e) => {
					e.preventDefault();
					submit();
				}}
			>
				<Input
					bind:value={roomName}
					placeholder="房间名，如：今晚开黑"
					maxlength={64}
					aria-label="房间名"
					class="h-12 w-full bg-muted/40 text-base sm:h-11 sm:flex-1 sm:text-[15px]"
					oninput={() => (accessCode = '')}
				/>
				<div class="flex items-center gap-2.5 sm:gap-3">
					<Avatar name={nickname} class="size-10 shrink-0 text-sm sm:size-11 sm:text-base" />
					<Input
						bind:el={nicknameInputEl}
						bind:value={nickname}
						placeholder="你的昵称"
						maxlength={32}
						aria-label="昵称"
						class="h-12 min-w-0 flex-1 bg-muted/40 text-base sm:h-11 sm:text-[15px]"
					/>
				</div>
				{#if isCreating || needsCode}
					<Input
						bind:value={accessCode}
						placeholder={isCreating ? '设置访问码（选填）' : '输入访问码'}
						maxlength={32}
						aria-label="访问码"
						class="h-12 w-full bg-muted/40 text-base sm:h-11 sm:w-32 sm:flex-none sm:text-[15px]"
					/>
				{/if}
				<Button
					type="submit"
					size="lg"
					class="h-12 w-full sm:h-11 sm:w-auto"
					disabled={joining || !roomName.trim() || !nickname.trim()}
				>
					{#if joining}
						<Icon name="loader" class="size-4 animate-spin" />
					{:else if isCreating}
						<Icon name="plus" class="size-4" />
						创建房间
					{:else}
						<Icon name="log-in" />
						进入房间
					{/if}
				</Button>
			</form>
		</CardContent>
	</Card>

	{#if errorMsg}
		<p class="fade-up mx-auto mt-3 max-w-2xl text-center text-sm text-red-600 dark:text-red-300">{errorMsg}</p>
	{:else if roomName.trim() && !loading}
		<p class="fade-up mx-auto mt-3 max-w-2xl text-center text-xs text-muted-foreground/70">
			{#if isCreating}
				「{roomName.trim()}」是新房间，进入即创建{accessCode.trim() ? '，访问码将作为房间门禁' : '，可不设访问码'}
				{#if !user && authCfg.createRequireAccount}
					·
					<button
						type="button"
						class="cursor-pointer underline underline-offset-2 transition-colors hover:text-foreground"
						onclick={() => {
							pendingCreate = { name: roomName.trim(), code: accessCode.trim() };
							showAuthModal = true;
						}}
					>
						创建需要登录
					</button>
				{/if}
			{:else if needsCode}
				「{roomName.trim()}」已存在且设置了访问码，需填码进入
			{:else}
				「{roomName.trim()}」已存在，直接进入
			{/if}
		</p>
	{/if}

	{#if pendingJoin && !getNickname()}
		<Card class="fade-up mx-auto mt-4 max-w-2xl border-primary/25 bg-primary/[0.06] py-4" style="--delay: 150ms">
			<CardContent class="flex items-center justify-between gap-3 px-5 py-0 text-sm">
				<span class="text-foreground/85">
					你打开的是房间「{pendingJoin}」的链接，填好昵称后即可加入。
				</span>
				{#if nickname.trim()}
					<Button
						size="sm"
						onclick={() => {
							setNickname(nickname.trim());
							goto(`/room/${encodeURIComponent(pendingJoin)}${location.hash}`);
						}}
					>
						<Icon name="log-in" />
						继续加入
					</Button>
				{/if}
			</CardContent>
		</Card>
	{/if}

	<!-- 在线的房间 -->
	<section class="mt-14">
		<div class="fade-up mb-5 flex items-baseline justify-between" style="--delay: 180ms">
			<h2 class="text-lg font-semibold tracking-tight">在线的房间</h2>
			<span class="text-sm text-muted-foreground">{rooms.filter((r) => r.memberCount > 0).length} 间</span>
		</div>

		{#if loading}
			<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
				{#each [0, 1] as i (i)}
					<div class="h-28 animate-pulse rounded-xl border bg-muted/50"></div>
				{/each}
			</div>
		{:else if rooms.filter((r) => r.memberCount > 0).length === 0}
			<Card class="fade-up border-dashed py-14">
				<CardContent class="flex flex-col items-center gap-3 py-4 text-center">
					<div class="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
						<Icon name="users" class="size-5" />
					</div>
					<p class="text-sm text-muted-foreground">
						现在没人在线 —— 在上面输入房间名，<span class="text-foreground/85">开第一间</span>
					</p>
				</CardContent>
			</Card>
		{:else}
			<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
				{#each rooms.filter((r) => r.memberCount > 0) as room, i (room.name)}
					<button
						type="button"
						class="fade-up group relative flex cursor-pointer flex-col gap-4 rounded-xl border bg-card p-5 text-left shadow-xl shadow-black/5 dark:shadow-black/20 backdrop-blur-xl transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-primary/10"
						style="--delay: {180 + i * 55}ms"
						onclick={() => (nickname.trim() && !room.hasPassword ? join(room.name) : openJoinModal(room))}
					>
						<div class="flex items-start justify-between gap-2">
							<div class="min-w-0">
								<div class="flex items-center gap-1.5">
									<span class="truncate text-[15px] font-semibold tracking-tight">{room.name}</span>
									{#if room.hasPassword}
										<span
											class="flex size-5 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground"
											title="需要访问码"
										>
											<Icon name="lock" class="size-3" />
										</span>
									{/if}
								</div>
								<div class="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
									<span class="breathe inline-block size-1.5 rounded-full bg-primary"></span>
									<span class="text-primary">{room.memberCount} 人在线</span>
								</div>
							</div>
							<div
								class="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground transition-all duration-200 group-hover:bg-primary group-hover:text-primary-foreground"
							>
								<Icon name="log-in" class="size-4" />
							</div>
						</div>

						{#if room.members.length > 0}
							<div class="flex items-center gap-2">
								<div class="flex -space-x-2">
									{#each room.members.slice(0, 4) as m (m.id)}
										<Avatar name={m.name} class="size-7 text-[10px] ring-2 ring-background" />
									{/each}
								</div>
								<span class="truncate text-xs text-muted-foreground">
									{room.members.slice(0, 4).map((m) => m.name).join('、')}{room.members.length > 4
										? ` 等 ${room.members.length} 人`
										: ''}
								</span>
							</div>
						{/if}
					</button>
				{/each}
			</div>
		{/if}
	</section>

	<footer
		class="fade-up mt-20 flex items-center justify-center gap-3 text-xs text-muted-foreground/50"
		style="--delay: 400ms"
	>
		<span>回声室 Echo Room</span>
		<span class="inline-block size-0.5 rounded-full bg-muted-foreground/40"></span>
		<span>SvelteKit · Go · LiveKit</span>
	</footer>

	{#if joinModal}
		<!-- 游客/带码房间：虚化背景的加入模态框（手机底部弹层，桌面居中） -->
		<div class="fixed inset-0 z-40 flex items-end justify-center p-4 sm:items-center">
			<button
				type="button"
				aria-label="取消加入"
				class="absolute inset-0 cursor-default bg-black/55 backdrop-blur-md"
				onclick={() => (joinModal = null)}
			></button>
			<div
				role="dialog"
				aria-modal="true"
				aria-label="加入房间"
				class="pop-in relative z-10 w-full max-w-sm rounded-2xl border bg-popover/90 p-6 shadow-2xl shadow-black/25 backdrop-blur-2xl dark:shadow-black/60"
			>
				<button
					type="button"
					aria-label="关闭"
					class="absolute right-3 top-3 rounded-full p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
					onclick={() => (joinModal = null)}
				>
					<Icon name="x" class="size-4" />
				</button>
				<div class="flex flex-col items-center text-center">
					<div
						class="mb-3.5 flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-300 to-teal-400 text-zinc-950 shadow-lg shadow-primary/30"
					>
						<Icon name={joinModal.needsCode ? 'lock' : 'users'} class="size-6" />
					</div>
					<h2 class="text-lg font-semibold tracking-tight">加入「{joinModal.name}」</h2>
					<p class="mt-1 text-sm text-muted-foreground">
						{joinModal.needsCode ? '此房间需要访问码，填好昵称和访问码进入' : '先告诉大家怎么称呼你'}
					</p>
				</div>
				<form class="mt-5 flex flex-col gap-4" onsubmit={confirmJoinModal}>
					<label class="flex flex-col items-stretch gap-1.5 text-left">
						<span class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
							<Icon name="users" class="size-3.5" />
							昵称
						</span>
						<Input
							bind:el={modalNameEl}
							bind:value={modalName}
							placeholder="输入你的昵称"
							maxlength={32}
							aria-label="你的昵称"
							class="h-11 rounded-xl bg-muted/40 px-3.5 text-[15px]"
						/>
					</label>
					{#if joinModal.needsCode}
						<label class="flex flex-col items-stretch gap-1.5 text-left">
							<span class="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
								<Icon name="lock" class="size-3.5" />
								访问码<span class="text-muted-foreground/60">· 问房主要</span>
							</span>
							<Input
								bind:el={modalCodeEl}
								bind:value={modalCode}
								placeholder="请输入验证码"
								maxlength={32}
								aria-label="访问码"
								class="h-11 rounded-xl border-primary/30 bg-primary/[0.06] px-3.5 font-mono text-[15px] tracking-widest placeholder:font-sans placeholder:tracking-normal"
							/>
						</label>
					{/if}
					<Button
						type="submit"
						size="lg"
						class="mt-1 h-12 rounded-xl font-semibold shadow-lg shadow-primary/25"
						disabled={!modalName.trim() || (joinModal.needsCode && !modalCode.trim())}
					>
						{#if joining}
							<Icon name="loader" class="size-4 animate-spin" />
						{:else}
							<Icon name="log-in" />
						{/if}
						进入房间
					</Button>
					<Button variant="ghost" size="sm" type="button" class="text-muted-foreground" onclick={() => (joinModal = null)}>
						取消
					</Button>
				</form>
			</div>
		</div>
	{/if}

	<!-- 注册/登录模态框：未登录点"创建房间"或顶栏入口时弹出 -->
	<AccountModal
		open={showAuthModal}
		config={authCfg}
		title={pendingCreate ? `创建「${pendingCreate.name}」` : '登录或注册'}
		desc={pendingCreate ? '创建房间需要账号，完成注册后自动继续' : '创建房间需要账号；加入房间无需注册'}
		callback={onAuthenticated}
	/>

	<!-- 个人资料模态框 -->
	<ProfileModal bind:open={profileOpen} onLogout={doLogout} />
</main>
