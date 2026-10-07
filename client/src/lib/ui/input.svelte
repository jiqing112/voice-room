<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';
	import { cn } from '#lib/utils';

	let {
		class: className = '',
		value = $bindable(''),
		el = $bindable<HTMLInputElement | null>(null),
		...rest
	}: HTMLInputAttributes & { el?: HTMLInputElement | null } = $props();
</script>

<input
	bind:this={el}
	bind:value
	class={cn(
		'flex h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
		className
	)}
	{...rest}
/>
