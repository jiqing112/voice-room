<script lang="ts">
	import { goto } from '$app/navigation';
	import { fetchMe, fetchMyRooms, logoutAccount, updatePassword, updateNickname, type Account } from '#lib/api';
	import { setNickname } from '#lib/identity';
	import { Avatar, Button, Card, CardContent, Icon, Input } from '#lib/ui';

	let {
		open = $bindable(false),
		onLogout
	}: {
		open?: boolean;
		onLogout: () => void;
	} = $props();

	let user = $state<Account | null>(null);
	let loaded = $state(false);
	let nickname = $state('');
	let nicknameSaved = $state(false);
	let savingName = $state(false);
	let nameError = $state('');

	let oldPassword = $state('');
	let newPassword = $state('');
	let confirmNew = $state('');
	let pwBusy = $state(false);
	let pwError = $state('');

	let myRooms = $state<{ name: string; memberCount: number; hasPassword: boolean }[]>([]);
	let roomsLoading = $state(true);

	const createdDate = $derived(
		user?.createdAt ? new Date(user.createdAt * 1000).toLocaleDateString('zh-CN') : ''
	);

	function close() {
		open = false;
	}

	function doLogout() {
		open = false;
		onLogout();
	}

	// 每次打开时拉取最新数据
	$effect(() => {
		if (!open) return;
		loaded = false;
		myRooms = [];
		roomsLoading = true;
		nickname = '';
		oldPassword = newPassword = confirmNew = '';
		pwError = '';
		nameError = '';
		nicknameSaved = false;
		(async () => {
			try {
				const me = await fetchMe();
				if (!me.user) {
					close();
					onLogout();
					return;
				}
				user = me.user;
				nickname = me.user.nickname;
				try {
					// 服务端按会话过滤"我创建的房间"（房间列表接口已不再公开创建者邮箱）
					myRooms = await fetchMyRooms();
				} catch {
					/* 房间列表拉不到就不展示 */
				}
				loaded = true;
			} catch {
				close();
			}
		})();
	});

	async function saveNickname() {
		if (savingName || !nickname.trim()) return;
		savingName = true;
		nameError = '';
		try {
			const acc = await updateNickname(nickname.trim());
			if (user) user = { ...user, nickname: acc.nickname };
			setNickname(acc.nickname);
			nicknameSaved = true;
			setTimeout(() => (nicknameSaved = false), 2500);
		} catch (e) {
			nameError = e instanceof Error ? e.message : '保存失败';
		} finally {
			savingName = false;
		}
	}

	async function savePassword() {
		if (pwBusy) return;
		if (newPassword.length < 8) {
			pwError = '新密码至少 8 位';
			return;
		}
		if (newPassword !== confirmNew) {
			pwError = '两次输入的新密码不一致';
			return;
		}
		pwBusy = true;
		pwError = '';
		try {
			await updatePassword(oldPassword, newPassword);
			// 密码变更后全部会话失效，回大厅重新登录
			close();
			onLogout();
		} catch (e) {
			pwError = e instanceof Error ? e.message : '修改失败';
		} finally {
			pwBusy = false;
		}
	}
</script>

{#if open}
	<div class="fixed inset-0 z-40 flex items-end justify-center p-4 sm:items-center">
		<button
			type="button"
			aria-label="关闭个人资料"
			class="absolute inset-0 cursor-default bg-black/55 backdrop-blur-md"
			onclick={close}
		></button>
		<div
			role="dialog"
			aria-modal="true"
			aria-label="个人资料"
			class="pop-in relative z-10 max-h-[88vh] w-full max-w-md overflow-y-auto rounded-2xl border bg-popover/90 p-6 shadow-2xl shadow-black/25 backdrop-blur-2xl dark:shadow-black/60"
		>
			<button
				type="button"
				aria-label="关闭"
				class="absolute right-3 top-3 rounded-full p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
				onclick={close}
			>
				<Icon name="x" class="size-4" />
			</button>

			{#if !loaded}
				<div class="flex justify-center py-16">
					<Icon name="loader" class="size-6 animate-spin text-muted-foreground" />
				</div>
			{:else if user}
				<!-- 头部 -->
				<div class="flex flex-col items-center text-center">
					<Avatar name={user.nickname} class="size-16 text-2xl" />
					<h2 class="mt-3 text-lg font-semibold tracking-tight">{user.nickname}</h2>
					<div class="mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground">
						{user.email}
						<button
							type="button"
							class="cursor-pointer text-muted-foreground/60 transition-colors hover:text-foreground"
							title="复制邮箱"
							onclick={() => navigator.clipboard?.writeText(user?.email ?? '')}
						>
							<Icon name="link" class="size-3.5" />
						</button>
					</div>
					{#if createdDate}
						<p class="mt-0.5 text-xs text-muted-foreground/60">注册于 {createdDate}</p>
					{/if}
				</div>

				<!-- 昵称 -->
				<Card class="mt-5 gap-0 py-4">
					<CardContent class="flex flex-col gap-3 px-4 py-0">
						<div class="flex items-center gap-2">
							<Icon name="users" class="size-4 text-primary" />
							<span class="text-sm font-semibold">昵称</span>
							<span class="text-xs text-muted-foreground">加入房间时的默认称呼</span>
						</div>
						<Input
							bind:value={nickname}
							maxlength={32}
							aria-label="昵称"
							class="h-11 rounded-xl bg-muted/40 text-[15px]"
						/>
						{#if nameError}
							<p class="text-sm text-red-600 dark:text-red-300">{nameError}</p>
						{/if}
						<Button
							class="h-11 rounded-xl font-semibold shadow-lg shadow-primary/25"
							disabled={savingName || !nickname.trim()}
							onclick={saveNickname}
						>
							{#if savingName}
								<Icon name="loader" class="size-4 animate-spin" />
							{:else if nicknameSaved}
								<Icon name="repeat" class="size-4" />
								已保存
							{:else}
								保存昵称
							{/if}
						</Button>
					</CardContent>
				</Card>

				<!-- 修改密码 -->
				<Card class="mt-3 gap-0 py-4">
					<CardContent class="flex flex-col gap-3 px-4 py-0">
						<div class="flex items-center gap-2">
							<Icon name="lock" class="size-4 text-primary" />
							<span class="text-sm font-semibold">修改密码</span>
							<span class="text-xs text-muted-foreground">修改后需重新登录</span>
						</div>
						{#if pwError}
							<p class="text-sm text-red-600 dark:text-red-300">{pwError}</p>
						{/if}
						<label class="flex flex-col gap-1.5">
							<span class="text-xs font-medium text-muted-foreground">当前密码</span>
							<Input bind:value={oldPassword} type="password" maxlength={64} aria-label="当前密码" class="h-11 rounded-xl bg-muted/40 text-[15px]" />
						</label>
						<div class="flex flex-col gap-3 sm:flex-row">
							<label class="flex min-w-0 flex-1 flex-col gap-1.5">
								<span class="text-xs font-medium text-muted-foreground">新密码（至少 8 位）</span>
								<Input bind:value={newPassword} type="password" maxlength={64} aria-label="新密码" class="h-11 rounded-xl bg-muted/40 text-[15px]" />
							</label>
							<label class="flex min-w-0 flex-1 flex-col gap-1.5">
								<span class="text-xs font-medium text-muted-foreground">确认新密码</span>
								<Input bind:value={confirmNew} type="password" maxlength={64} aria-label="确认新密码" class="h-11 rounded-xl bg-muted/40 text-[15px]" />
							</label>
						</div>
						<Button
							variant="outline"
							class="h-11 rounded-xl font-semibold"
							disabled={pwBusy || !oldPassword || !newPassword || !confirmNew}
							onclick={savePassword}
						>
							{#if pwBusy}
								<Icon name="loader" class="size-4 animate-spin" />
							{:else}
								更新密码
							{/if}
						</Button>
					</CardContent>
				</Card>

				<!-- 我创建的房间 -->
				<Card class="mt-3 gap-0 py-4">
					<CardContent class="flex flex-col gap-3 px-4 py-0">
						<div class="flex items-center gap-2">
							<Icon name="disc" class="size-4 text-primary" />
							<span class="text-sm font-semibold">我创建的房间</span>
							<span class="text-xs text-muted-foreground">服务重启后清空</span>
						</div>
						{#if roomsLoading}
							<div class="h-10 animate-pulse rounded-lg bg-muted/50"></div>
						{:else if myRooms.length === 0}
							<p class="py-2 text-center text-xs text-muted-foreground/70">
								还没有创建过房间——回大厅输入一个新房间名就创建好了
							</p>
						{:else}
							{#each myRooms as room (room.name)}
								<button
									type="button"
									class="flex w-full cursor-pointer items-center justify-between gap-3 rounded-xl border bg-muted/30 px-4 py-3 text-left transition-colors hover:border-primary/40"
									onclick={() => { close(); goto(`/room/${encodeURIComponent(room.name)}`); }}
								>
									<div class="flex min-w-0 items-center gap-2">
										<span class="truncate text-sm font-medium">{room.name}</span>
										{#if room.hasPassword}
											<Icon name="lock" class="size-3.5 shrink-0 text-muted-foreground" />
										{/if}
									</div>
									<span class="shrink-0 text-xs {room.memberCount > 0 ? 'text-primary' : 'text-muted-foreground'}">
										{room.memberCount} 人在线
									</span>
								</button>
							{/each}
							<p class="text-center text-xs text-muted-foreground/60">点击房间名直接进入</p>
						{/if}
					</CardContent>
				</Card>

				<!-- 退出登录 -->
				<Button variant="outline" class="mt-3 h-11 w-full rounded-xl text-muted-foreground" onclick={doLogout}>
					<Icon name="x" class="size-4" />
					退出登录
				</Button>
			{/if}
		</div>
	</div>
{/if}
