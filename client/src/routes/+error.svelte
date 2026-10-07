<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import { Button, Icon } from '#lib/ui';

	// 各状态码的文案；/room（缺房间名）单独给一条更贴切的提示
	const copy: Record<number, { title: string; desc: string }> = {
		404: { title: '这里没有房间', desc: '页面不存在，或者链接已失效。' },
		403: { title: '进不去这里', desc: '没有权限访问这个页面。' },
		500: { title: '服务器打了个盹', desc: '后端出了点问题，稍后再试试。' }
	};
	const msg = $derived.by(() => {
		if (page.status === 404 && page.url.pathname === '/room') {
			return { title: '房间链接不完整', desc: '还没带房间名——回大厅输入房间名，或点朋友发的完整邀请链接。' };
		}
		return copy[page.status] ?? { title: '出了一点意外', desc: page.error?.message || '稍后再试试。' };
	});

	function goBack() {
		if (history.length > 1) history.back();
		else goto('/');
	}
</script>

<svelte:head>
	<title>{page.status} · 回声室</title>
</svelte:head>

<main class="mx-auto flex min-h-[80vh] w-full max-w-2xl flex-col items-center justify-center px-4 py-16 text-center">
	<!-- 装饰：品牌渐变徽章 + 静默的声纹 -->
	<div class="fade-up relative" style="--delay: 0ms">
		<div
			class="flex size-20 items-center justify-center rounded-3xl bg-gradient-to-br from-emerald-300 to-teal-400 text-zinc-950 shadow-xl shadow-primary/30"
		>
			<Icon name="audio-lines" class="size-9" />
		</div>
		<span class="eq absolute -right-3 -top-2 text-primary/70"><i></i><i></i><i></i><i></i></span>
	</div>

	<p class="fade-up mt-8 bg-gradient-to-b from-foreground via-foreground to-foreground/40 bg-clip-text text-7xl font-bold tracking-tight text-transparent sm:text-8xl" style="--delay: 60ms">
		{page.status}
	</p>
	<h1 class="fade-up mt-4 text-xl font-semibold tracking-tight sm:text-2xl" style="--delay: 120ms">
		{msg.title}
	</h1>
	<p class="fade-up mt-2 max-w-sm text-[15px] leading-relaxed text-muted-foreground" style="--delay: 180ms">
		{msg.desc}
	</p>

	<div class="fade-up mt-8 flex flex-col items-center gap-3 sm:flex-row" style="--delay: 240ms">
		<Button size="lg" class="h-12 min-w-40 rounded-xl font-semibold shadow-lg shadow-primary/25" onclick={() => goto('/')}>
			<Icon name="arrow-left" />
			回大厅
		</Button>
		<Button variant="outline" size="lg" class="h-12 min-w-40 rounded-xl" onclick={goBack}>
			返回上一页
		</Button>
	</div>

	<p class="fade-up mt-12 flex items-center gap-2 text-xs text-muted-foreground/50" style="--delay: 300ms">
		<span class="breathe inline-block size-1.5 rounded-full bg-primary"></span>
		回声室 Echo Room
	</p>
</main>
