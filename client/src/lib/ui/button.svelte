<script lang="ts" module>
	import { cn } from '#lib/utils';

	// shadcn/ui 的按钮变体（原型直接手写映射表，不引 cva 依赖）
	const variants = {
		default: 'bg-primary text-primary-foreground shadow-lg shadow-primary/20 hover:bg-primary/90',
		secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/70',
		outline: 'border border-input bg-transparent hover:bg-muted/60 hover:border-border',
		ghost: 'hover:bg-muted/60 text-muted-foreground hover:text-foreground',
		destructive: 'bg-destructive text-white shadow-lg shadow-destructive/25 hover:bg-destructive/90',
		success: 'bg-primary text-primary-foreground shadow-lg shadow-primary/25 hover:bg-primary/90'
	} as const;
	const sizes = {
		default: 'h-9 px-4 py-2 has-[>svg]:px-3',
		sm: 'h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5',
		lg: 'h-11 rounded-lg px-7 has-[>svg]:px-4 text-[0.95rem]',
		icon: 'size-9'
	} as const;

	export type ButtonVariant = keyof typeof variants;
	export type ButtonSize = keyof typeof sizes;
</script>

<script lang="ts">
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import type { Snippet } from 'svelte';

	let {
		class: className = '',
		variant = 'default',
		size = 'default',
		type = 'button',
		children,
		...rest
	}: HTMLButtonAttributes & {
		variant?: ButtonVariant;
		size?: ButtonSize;
		children?: Snippet;
	} = $props();
</script>

<button
	{type}
	class={cn(
		'inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium outline-none transition-all duration-200 focus-visible:ring-[3px] focus-visible:ring-ring/50 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*="size-"])]:size-4',
		variants[variant],
		sizes[size],
		className
	)}
	{...rest}
>
	{@render children?.()}
</button>
