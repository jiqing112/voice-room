// 页面 BGM UI 替换：播放条 → 向上弹出播放器面板（播放列表/循环/音量/进度）
import fs from 'node:fs'
const p = 'src/routes/room/[name]/+page.svelte'
let s = fs.readFileSync(p, 'utf8')
let fail = (msg) => { console.error('PATCH FAIL: ' + msg); process.exit(1) }

// 1. 文件输入：multiple + addBgmFiles
const oldInput = `		<input
			bind:this={bgmFileInput}
			type="file"
			accept="audio/*"
			class="hidden"
			onchange={(e) => {
				const f = e.currentTarget.files?.[0];
				if (f) controller?.startBgm(f);
				e.currentTarget.value = ''; // 允许再次选择同一文件
			}}
		/>`
const newInput = `		<input
			bind:this={bgmFileInput}
			type="file"
			accept="audio/*"
			multiple
			class="hidden"
			onchange={(e) => {
				const files = Array.from(e.currentTarget.files ?? []);
				if (files.length) controller?.addBgmFiles(files);
				e.currentTarget.value = ''; // 允许再次选择同一批文件
			}}
		/>`
if (!s.includes(oldInput)) fail('input')
s = s.replace(oldInput, newInput)

// 2. 旧播放条整块删除（从注释到 {/if}）
const barStart = s.indexOf('		<!-- 背景音乐播放条：上传文件后显示 -->')
const barEndMarker = '		{/if}\n\n		<footer'
const barEnd = s.indexOf(barEndMarker, barStart)
if (barStart < 0 || barEnd < 0) fail(`player bar anchors (${barStart},${barEnd})`)
s = s.slice(0, barStart) + s.slice(barEnd + '		{/if}\n'.length)

// 3. 唱片按钮：改为开关面板
const oldBtnOnclick = `onclick={() => bgmFileInput?.click()}`
if (!s.includes(oldBtnOnclick)) fail('disc button onclick')
s = s.replace(oldBtnOnclick, `onclick={() => (showBgmPanel = !showBgmPanel)}`)
s = s.replace(`aria-label={controller.bgmActive ? '停止背景音乐' : '播放背景音乐'}`, `aria-label="背景音乐面板"`)
s = s.replace(`title="上传音乐文件，播放给房间听"`, `title="背景音乐播放列表"`)

// 4. 面板状态声明
s = s.replace(
  '	let bgmFileInput = $state<HTMLInputElement | null>(null);',
  '	let bgmFileInput = $state<HTMLInputElement | null>(null);\n	let showBgmPanel = $state(false); // 背景音乐播放器面板开关'
)

// 5. 在 footer 内（settings 面板之前）插入 BGM 面板
const settingsAnchor = '				{#if showAudioSettings}'
const bgmPanel = `				{#if showBgmPanel}
					<div
						class="fade-up absolute bottom-16 left-0 z-30 w-[min(21rem,calc(100vw-2rem))] rounded-xl border bg-popover/95 p-4 shadow-2xl shadow-black/10 dark:shadow-black/40 backdrop-blur-xl"
					>
						<div class="mb-3 flex items-center justify-between">
							<span class="text-sm font-semibold">背景音乐</span>
							<Badge variant={controller.bgmActive ? 'success' : 'secondary'}>
								{controller.bgmActive ? (controller.bgmPlaying ? '播放中' : '已暂停') : '未播放'}
							</Badge>
						</div>

						<!-- 当前进度 -->
						{#if controller.bgmActive}
							<div class="mb-3 h-1 overflow-hidden rounded bg-muted">
								<div
									class="h-full rounded bg-primary/70 transition-all duration-300"
									style="width: {controller.bgmProgress}%"
								></div>
							</div>
						{/if}

						<!-- 添加入口 -->
						<Button
							variant="outline"
							size="sm"
							class="mb-3 w-full"
							onclick={() => bgmFileInput?.click()}
						>
							<Icon name="plus" />
							添加音乐文件（可多选）
						</Button>

						<!-- 播放列表 -->
						<div class="mb-3 flex max-h-44 flex-col gap-1 overflow-y-auto">
							{#each controller.bgmTracks as t, i (t.url)}
								<div
									class="group flex items-center gap-2 rounded-md px-2 py-1.5 {i === controller.bgmIndex &&
									controller.bgmActive
										? 'bg-primary/10'
										: 'hover:bg-muted/60'}"
								>
									<button
										type="button"
										class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
										onclick={() => controller?.playBgmIndex(i)}
									>
										<Icon
											name={i === controller.bgmIndex && controller.bgmActive
												? 'audio-lines'
												: 'music'}
											class="size-3.5 shrink-0 {i === controller.bgmIndex && controller.bgmActive
												? 'text-primary'
												: 'text-muted-foreground'}"
										/>
										<span class="truncate text-sm {i === controller.bgmIndex && controller.bgmActive
											? 'text-foreground'
											: 'text-muted-foreground'}">
											{t.name}
										</span>
									</button>
									<button
										type="button"
										class="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
										aria-label="移除 {t.name}"
										onclick={() => controller?.removeBgmTrack(i)}
									>
										<Icon name="x" class="size-3.5" />
									</button>
								</div>
							{/each}
						</div>

						<!-- 控制条 -->
						<div class="flex items-center justify-between gap-2 border-t pt-3">
							<div class="flex items-center gap-1">
								<Button
									variant="ghost"
									size="icon"
									class="size-8"
									aria-label="上一首"
									disabled={controller.bgmTracks.length === 0}
									onclick={() => controller?.bgmPrev()}
								>
									<Icon name="skip-back" />
								</Button>
								<Button
									size="icon"
									class="size-9"
									aria-label={controller.bgmPlaying ? '暂停' : '播放'}
									disabled={controller.bgmTracks.length === 0}
									onclick={() => controller?.toggleBgmPlay()}
								>
									<Icon name={controller.bgmPlaying ? 'pause' : 'play'} />
								</Button>
								<Button
									variant="ghost"
									size="icon"
									class="size-8"
									aria-label="下一首"
									disabled={controller.bgmTracks.length === 0}
									onclick={() => controller?.bgmNext()}
								>
									<Icon name="skip-forward" />
								</Button>
							</div>
							<div class="flex items-center gap-1.5">
								<button
									type="button"
									class="rounded px-1.5 py-1 text-xs transition-colors {controller.bgmLoopSingle
										? 'bg-primary/15 text-primary'
										: 'text-muted-foreground hover:text-foreground'}"
									aria-label={controller.bgmLoopSingle ? '单曲循环：开' : '单曲循环：关'}
									onclick={() => controller?.toggleBgmLoop()}
								>
									单曲
								</button>
								<Icon name="volume" class="size-3.5 text-muted-foreground" />
								<input
									type="range"
									min="0"
									max="100"
									step="1"
									value={controller.bgmVolume}
									aria-label="背景音乐音量"
									class="h-6 w-16 cursor-pointer accent-primary sm:h-1"
									oninput={(e) => controller?.setBgmVolume(+e.currentTarget.value)}
								/>
							</div>
						</div>

						{#if controller.bgmActive}
							<Button
								variant="destructive"
								size="sm"
								class="mt-3 w-full"
								onclick={() => controller?.stopBgm()}
							>
								停止并清空列表
							</Button>
						{/if}
					</div>
				{/if}

`
if (!s.includes(settingsAnchor)) fail('settings anchor')
s = s.replace(settingsAnchor, bgmPanel + settingsAnchor)

fs.writeFileSync(p, s)
console.log('BGM panel UI installed')
