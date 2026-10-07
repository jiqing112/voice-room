<script lang="ts" module>
	import { cn } from '#lib/utils';

	const variants = {
		default: 'bg-muted text-foreground ring-1 ring-border',
		secondary: 'bg-muted/70 text-muted-foreground ring-1 ring-border',
		destructive: 'bg-destructive/12 text-destructive ring-1 ring-destructive/30',
		outline: 'border border-input text-foreground',
		success: 'bg-primary/12 text-primary ring-1 ring-primary/30',
		muted: 'bg-muted/60 text-muted-foreground ring-1 ring-border'
	} as const;

	export type BadgeVariant = keyof typeof variants;
</script>

<script lang="ts">
	import type { HTMLAttributes } from 'svelte/elements';
	import type { Snippet } from 'svelte';

	let {
		class: className = '',
		variant = 'default',
		children,
		...rest
	}: HTMLAttributes<HTMLSpanElement> & { variant?: BadgeVariant; children?: Snippet } = $props();
</script>

<span
	class={cn(
		'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium tracking-wide',
		variants[variant],
		className
	)}
	{...rest}
>
	{@render children?.()}
</span>
