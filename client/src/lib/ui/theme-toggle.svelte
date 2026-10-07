<script lang="ts">
	import { theme, toggleTheme } from '#lib/theme.svelte';
	import Button from './button.svelte';
	import Icon from './icon.svelte';
</script>

<Button
	variant="ghost"
	size="icon"
	aria-label={theme.current === 'dark' ? '切换到亮色主题' : '切换到暗色主题'}
	title="切换主题"
	onclick={toggleTheme}
>
	{#if theme.current === 'dark'}
		<Icon name="sun" />
	{:else}
		<Icon name="moon" />
	{/if}
</Button>
