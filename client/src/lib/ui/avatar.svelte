<script lang="ts">
	import { cn } from '#lib/utils';

	let {
		name,
		speaking = false,
		class: className = ''
	}: { name?: string; speaking?: boolean; class?: string } = $props();

	// 原型不做头像上传：用昵称哈希挑一组固定的双色调渐变，显示首字符
	const palette = [
		'from-rose-400 to-orange-400',
		'from-amber-300 to-lime-400',
		'from-emerald-300 to-teal-400',
		'from-sky-300 to-indigo-400',
		'from-violet-400 to-fuchsia-400',
		'from-pink-400 to-rose-400',
		'from-cyan-300 to-sky-500',
		'from-lime-300 to-emerald-500'
	];

	function gradientOf(n: string) {
		let h = 0;
		for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
		return palette[h % palette.length];
	}
</script>

<!--
	外层负责占位（尺寸类由调用方传入：size-6/7/11/14…）与字号（内层文字继承）；
	内层 absolute inset-0 铺满外层绘制圆形——避免内外尺寸不一致造成的错位/遮挡
-->
<div class={cn('relative shrink-0 rounded-full font-semibold text-zinc-950', className)}>
	{#if speaking}
		<!-- 说话时的呼吸光环（外圈） -->
		<div
			class="pulse-ring absolute -inset-1 rounded-full bg-gradient-to-br from-emerald-300/25 to-teal-400/25"
		></div>
	{/if}
	<div
		class={cn(
			'inner absolute inset-0 flex select-none items-center justify-center rounded-full bg-gradient-to-br ring-1 transition-all duration-300',
			name?.trim() ? gradientOf(name) : 'from-zinc-400 to-zinc-600 text-white',
			speaking
				? 'ring-2 ring-primary ring-offset-2 ring-offset-background'
				: 'ring-foreground/10'
		)}
	>
		{(name?.trim()?.[0] ?? '?').toUpperCase()}
	</div>
</div>

<style>
	/* 首字符压一层轻微内阴影，让渐变上的文字更稳 */
	.inner::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: inherit;
		box-shadow: inset 0 -6px 12px -6px rgb(0 0 0 / 0.35);
		pointer-events: none;
	}
</style>
