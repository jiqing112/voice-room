// BGM 播放器重构补丁：单文件 → 多文件播放列表 + 循环模式 + 进度
import fs from 'node:fs'
const p = 'src/lib/voice-room.svelte.ts'
let s = fs.readFileSync(p, 'utf8')
let fail = (msg) => { console.error('PATCH FAIL: ' + msg); process.exit(1) }

// 1. 字段区
const oldFields = `	bgmActive = $state(false);
	bgmName = $state('');
	bgmPlaying = $state(true);
	bgmVolume = $state(60);
	private bgmTrackPublished = false;
	private bgmAudioEl: HTMLAudioElement | null = null;
	private bgmCtx: AudioContext | null = null;
	private bgmGain: GainNode | null = null;
	private bgmUrl: string | null = null;`
const newFields = `	// —— 背景音乐：上传多个音乐文件，在房间里循环播放 ——
	// 独立音乐轨（ScreenShareAudio 源）只在首次播放时发布一次，
	// 之后切歌仅切换本地 <audio> 的源，无需重新协商；本地经 WebAudio 同时回放给分享者。
	bgmTracks = $state<{ name: string; url: string }[]>([]);
	bgmIndex = $state(-1);
	bgmActive = $state(false);
	bgmName = $state('');
	bgmPlaying = $state(true);
	bgmLoopSingle = $state(false); // 单曲循环；默认列表循环
	bgmVolume = $state(60);
	bgmProgress = $state(0); // 当前曲目播放进度（0-100）
	private bgmTrackPublished = false;
	private bgmAudioEl: HTMLAudioElement | null = null;
	private bgmCtx: AudioContext | null = null;
	private bgmGain: GainNode | null = null;
	private bgmDest: MediaStreamAudioDestinationNode | null = null;
	private bgmProgressTimer: ReturnType<typeof setInterval> | null = null;`
if (!s.includes(oldFields)) fail('fields')
s = s.replace(oldFields, newFields)

// 2. 方法区替换（startBgm/toggleBgmPlay/setBgmVolume/stopBgm → 播放器全家桶）
const methodStart = s.indexOf('	async startBgm(file: File) {')
const stopAnchor = '	this.refresh();\n	}\n\n	// 自动舒适音量'
const stopIdx = s.indexOf(stopAnchor, methodStart)
if (methodStart < 0 || stopIdx < 0 || stopIdx <= methodStart) fail(`method block anchors (${methodStart},${stopIdx})`)
const newMethods = `	// 批量添加音乐文件；首次添加会初始化播放链并发布音乐轨，从新歌开始播
	async addBgmFiles(files: File[]) {
		if (!files.length || !this.room || this.status !== 'connected') return;
		try {
			this.errorMsg = '';
			const first = this.bgmTracks.length;
			for (const f of files) {
				this.bgmTracks.push({ name: f.name, url: URL.createObjectURL(f) });
			}
			if (!this.bgmActive) {
				await this.playBgmIndex(first);
			} else if (!this.bgmPlaying) {
				this.toggleBgmPlay(); // 歌单在暂停中：加歌后自动继续
			}
			this.refresh();
		} catch (e) {
			this.errorMsg = '背景音乐添加失败：' + (e instanceof Error ? e.message : String(e));
		}
	}

	// 初始化/确保播放链：<audio> + WebAudio 增益 → 独立音乐轨（只在首次发布）
	private async ensureBgmChain(): Promise<HTMLAudioElement | null> {
		if (!this.room) return null;
		if (this.bgmAudioEl) return this.bgmAudioEl;
		const ctx = new AudioContext({ latencyHint: 'interactive' });
		await ctx.resume().catch(() => {});
		const el = new Audio();
		el.addEventListener('ended', () => this.onBgmEnded());
		const src = ctx.createMediaElementSource(el);
		const gain = ctx.createGain();
		gain.gain.value = this.bgmVolume / 100;
		const dest = ctx.createMediaStreamDestination();
		src.connect(gain);
		gain.connect(dest);
		gain.connect(ctx.destination); // 分享者自己也能听到
		await this.room.localParticipant.publishTrack(dest.stream.getAudioTracks()[0], {
			source: Track.Source.ScreenShareAudio,
			name: 'background-music'
		});
		this.bgmTrackPublished = true;
		this.bgmCtx = ctx;
		this.bgmGain = gain;
		this.bgmDest = dest;
		this.bgmAudioEl = el;
		// 进度轮询（UI 进度条用）
		this.bgmProgressTimer = setInterval(() => {
			if (this.bgmAudioEl && this.bgmAudioEl.duration > 0) {
				this.bgmProgress = Math.min(100, (this.bgmAudioEl.currentTime / this.bgmAudioEl.duration) * 100);
			}
		}, 500);
		return el;
	}

	private async playBgmIndex(index: number) {
		if (index < 0 || index >= this.bgmTracks.length) return;
		const el = await this.ensureBgmChain();
		if (!el) return;
		el.src = this.bgmTracks[index].url;
		el.loop = this.bgmLoopSingle;
		try {
			await el.play();
		} catch {
			/* 播放被拦时忽略：用户可手动点播放 */
		}
		this.bgmIndex = index;
		this.bgmName = this.bgmTracks[index].name;
		this.bgmActive = true;
		this.bgmPlaying = true;
		this.refresh();
	}

	private onBgmEnded() {
		// 单曲循环时浏览器 loop 属性自动重播；列表循环切下一首（末尾回到第一首）
		if (this.bgmLoopSingle) {
			if (this.bgmAudioEl) {
				this.bgmAudioEl.currentTime = 0;
				this.bgmAudioEl.play().catch(() => {});
			}
			return;
		}
		if (this.bgmTracks.length > 0) void this.playBgmIndex((this.bgmIndex + 1) % this.bgmTracks.length);
	}

	bgmNext() {
		if (this.bgmTracks.length) void this.playBgmIndex((this.bgmIndex + 1) % this.bgmTracks.length);
	}

	bgmPrev() {
		if (this.bgmTracks.length) {
			void this.playBgmIndex((this.bgmIndex - 1 + this.bgmTracks.length) % this.bgmTracks.length);
		}
	}

	toggleBgmPlay() {
		if (!this.bgmAudioEl) return;
		if (this.bgmPlaying) this.bgmAudioEl.pause();
		else void this.bgmAudioEl.play();
		this.bgmPlaying = !this.bgmPlaying;
	}

	toggleBgmLoop() {
		this.bgmLoopSingle = !this.bgmLoopSingle;
		if (this.bgmAudioEl) this.bgmAudioEl.loop = this.bgmLoopSingle;
	}

	setBgmVolume(v: number) {
		this.bgmVolume = Math.max(0, Math.min(100, Math.round(v)));
		if (this.bgmGain) this.bgmGain.gain.value = this.bgmVolume / 100;
	}

	removeBgmTrack(i: number) {
		const t = this.bgmTracks[i];
		if (!t) return;
		URL.revokeObjectURL(t.url);
		this.bgmTracks.splice(i, 1);
		if (i < this.bgmIndex) {
			this.bgmIndex--; // 删的是当前播放之前的：索引前移
			return;
		}
		if (i === this.bgmIndex) {
			// 删的是正在播的：切到同位置的下一首；列表空了则整停
			if (this.bgmTracks.length === 0) {
				this.stopBgm();
				return;
			}
			void this.playBgmIndex(this.bgmIndex % this.bgmTracks.length);
		}
	}

	stopBgm() {
		try {
			this.bgmAudioEl?.pause();
			if (this.bgmProgressTimer) clearInterval(this.bgmProgressTimer);
			this.bgmCtx?.close();
			for (const t of this.bgmTracks) URL.revokeObjectURL(t.url);
			// 取消已发布的音乐轨
			if (this.bgmTrackPublished && this.room) {
				const pub = this.room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
				if (pub?.track) this.room.localParticipant.unpublishTrack(pub.track);
			}
		} catch {
			/* 忽略清理错误 */
		}
		if (this.bgmProgressTimer) clearInterval(this.bgmProgressTimer);
		this.bgmProgressTimer = null;
		this.bgmAudioEl = null;
		this.bgmCtx = null;
		this.bgmGain = null;
		this.bgmDest = null;
		this.bgmTrackPublished = false;
		this.bgmTracks = [];
		this.bgmIndex = -1;
		this.bgmActive = false;
		this.bgmPlaying = false;
		this.bgmName = '';
		this.bgmProgress = 0;
		this.refresh();
	}

`
s = s.slice(0, methodStart) + newMethods + s.slice(stopIdx + '	this.refresh();\n	}\n'.length)

fs.writeFileSync(p, s)
console.log('BGM player refactored')
