<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn } from '#lib/utils';

	let { class: className = '', children, ...rest }: HTMLAttributes<HTMLDivElement> = $props();
</script>

<div
	class={cn(
		'flex flex-col gap-6 rounded-xl border bg-card py-6 text-card-foreground shadow-xl shadow-black/5 dark:shadow-black/20 backdrop-blur-xl',
		className
	)}
	{...rest}
>
	{@render children?.()}
</div>
