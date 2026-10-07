<script lang="ts">
	import { registerAccount, loginAccount, sendEmailCode, type Account, type AuthConfig } from '#lib/api';
	import { Button, Icon, Input } from '#lib/ui';
	import { cn } from '#lib/utils';

	let {
		open,
		config,
		title = '登录或注册',
		desc = '创建房间需要账号；加入房间无需注册',
		callback
	}: {
		open: boolean;
		config: AuthConfig;
		title?: string;
		desc?: string;
		callback: (account: Account) => void;
	} = $props();

	let mode = $state<'login' | 'register'>('register');
	let email = $state('');
	let nickname = $state('');
	let password = $state('');
	let code = $state('');
	let busy = $state(false);
	let error = $state('');
	let emailEl = $state<HTMLInputElement | null>(null);

	// 验证码倒计时（仅在站点开启邮箱验证时有意义）
	let cooldown = $state(0);
	let cooldownTimer: ReturnType<typeof setInterval> | undefined;
	$effect(() => {
		if (open) {
			error = '';
			setTimeout(() => emailEl?.focus(), 60);
		} else {
			clearInterval(cooldownTimer);
			cooldown = 0;
		}
		return () => clearInterval(cooldownTimer);
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (busy) return;
		busy = true;
		error = '';
		try {
			const account =
				mode === 'register'
					? await registerAccount(email, password, nickname, code)
					: await loginAccount(email, password);
			callback(account);
		} catch (e) {
			error = e instanceof Error ? e.message : '操作失败';
		} finally {
			busy = false;
		}
	}

	async function sendCode() {
		if (cooldown > 0 || !email.includes('@')) return;
		try {
			await sendEmailCode(email);
			cooldown = 60;
			cooldownTimer = setInterval(() => {
				cooldown--;
				if (cooldown <= 0) clearInterval(cooldownTimer);
			}, 1000);
			error = '';
		} catch (e) {
			error = e instanceof Error ? e.message : '发送失败';
		}
	}
</script>

{#if open}
	<div class="fixed inset-0 z-40 flex items-end justify-center p-4 sm:items-center">
		<button
			type="button"
			aria-label="关闭"
			class="absolute inset-0 cursor-default bg-black/55 backdrop-blur-md"
			onclick={() => (open = false)}
		></button>
		<div
			role="dialog"
			aria-modal="true"
			aria-label={title}
			class="pop-in relative z-10 w-full max-w-sm rounded-2xl border bg-popover/90 p-6 shadow-2xl shadow-black/25 backdrop-blur-2xl dark:shadow-black/60"
		>
			<button
				type="button"
				aria-label="关闭"
				class="absolute right-3 top-3 rounded-full p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
				onclick={() => (open = false)}
			>
				<Icon name="x" class="size-4" />
			</button>
			<div class="flex flex-col items-center text-center">
				<div
					class="mb-3.5 flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-300 to-teal-400 text-zinc-950 shadow-lg shadow-primary/30"
				>
					<Icon name="users" class="size-6" />
				</div>
				<h2 class="text-lg font-semibold tracking-tight">{title}</h2>
				<p class="mt-1 text-sm text-muted-foreground">{desc}</p>
			</div>

			<!-- 登录/注册切换（站点关闭注册时只显示登录） -->
			{#if config.registerEnabled}
			<div class="mt-4 grid grid-cols-2 rounded-xl bg-muted/60 p-1 text-sm">
				<button
					type="button"
					class={cn('cursor-pointer rounded-lg py-1.5 font-medium transition-colors', mode === 'register' ? 'bg-background shadow' : 'text-muted-foreground')}
					onclick={() => { mode = 'register'; error = ''; }}
				>
					注册
				</button>
				<button
					type="button"
					class={cn('cursor-pointer rounded-lg py-1.5 font-medium transition-colors', mode === 'login' ? 'bg-background shadow' : 'text-muted-foreground')}
					onclick={() => { mode = 'login'; error = ''; }}
				>
					登录
				</button>
			</div>
			{/if}

			<form class="mt-4 flex flex-col gap-3" onsubmit={submit}>
				<Input
					bind:el={emailEl}
					bind:value={email}
					type="email"
					placeholder="邮箱地址"
					maxlength={64}
					aria-label="邮箱地址"
					class="h-11 rounded-xl bg-muted/40 text-[15px]"
				/>
				{#if mode === 'register'}
					<Input
						bind:value={nickname}
						placeholder="昵称（大家怎么称呼你）"
						maxlength={32}
						aria-label="昵称"
						class="h-11 rounded-xl bg-muted/40 text-[15px]"
					/>
				{/if}
				<Input
					bind:value={password}
					type="password"
					placeholder={mode === 'register' ? '设置密码（至少 8 位）' : '密码'}
					maxlength={64}
					aria-label="密码"
					class="h-11 rounded-xl bg-muted/40 text-[15px]"
				/>
				{#if mode === 'register' && config.mailVerify}
					<!-- 邮箱验证码：站点开启 MAIL_VERIFY_ENABLED 后出现 -->
					<div class="flex items-center gap-2">
						<Input
							bind:value={code}
							placeholder="邮箱验证码"
							maxlength={6}
							aria-label="邮箱验证码"
							class="h-11 min-w-0 flex-1 rounded-xl bg-muted/40 font-mono tracking-widest text-[15px]"
						/>
						<Button
							type="button"
							variant="outline"
							class="h-11 shrink-0 rounded-xl text-sm"
							disabled={cooldown > 0 || !email.includes('@')}
							onclick={sendCode}
						>
							{cooldown > 0 ? `${cooldown}s` : '发送验证码'}
						</Button>
					</div>
				{/if}
				{#if error}
					<p class="text-sm text-red-600 dark:text-red-300">{error}</p>
				{/if}
				<Button type="submit" size="lg" class="mt-1 h-12 rounded-xl font-semibold shadow-lg shadow-primary/25" disabled={busy}>
					{#if busy}
						<Icon name="loader" class="size-4 animate-spin" />
					{:else}
						<Icon name="log-in" />
					{/if}
					{mode === 'register' ? '注册并登录' : '登录'}
				</Button>
				<p class="text-center text-xs text-muted-foreground/70">
					{mode === 'register' ? '注册即表示同意仅将邮箱用于账号识别' : '还没有账号？点上方「注册」创建一个'}
				</p>
			</form>
		</div>
	</div>
{/if}
