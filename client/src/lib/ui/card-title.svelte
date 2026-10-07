<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import { cn } from '#lib/utils';

	let { class: className = '', children, ...rest }: HTMLAttributes<HTMLDivElement> = $props();
</script>

<div class={cn('font-semibold leading-none', className)} {...rest}>
	{@render children?.()}
</div>
