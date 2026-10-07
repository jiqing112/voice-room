// LiveKit 房间控制器：把 livekit-client 的事件流翻译成 Svelte 5 响应式状态。
//
// 架构约束（重要）：媒体层完全交给 LiveKit SDK —— 本文件没有任何
// RTCPeerConnection / createOffer / 编解码 / 回声消除逻辑，
// 连接、发布、订阅、音量检测全部由 SDK 与 LiveKit 服务端完成。
//
// API 均已按 livekit-client@2.22.3 的类型定义核对过：
//   - RoomEvent.ActiveSpeakersChanged 的参数是 Participant[]（2.x 改的，老版本是 {identity, level}）
//   - room.startAudio(): Promise<void>；room.canPlaybackAudio: boolean
//   - room.localParticipant.setMicrophoneEnabled(enabled): Promise<LocalTrackPublication | undefined>
import {
	Room,
	RoomEvent,
	Track,
	AudioPresets,
	type LocalAudioTrack,
	type Participant,
	type RemoteTrack
} from 'livekit-client';
import { fetchMyIp, resolveSignalUrl } from '#lib/api';
import { VoiceProcessor, captureOptionsOf, publishOptionsOf } from '#lib/voice-processor';
import { loadTuning, saveTuning, type AudioTuning } from '#lib/audio-tuning.svelte';

export type ConnStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

// 自动舒适音量开关的持久化
const AUTO_COMFORT_KEY = 'echo:autocomfort';
function loadAutoComfort(): boolean {
	try {
		const v = localStorage.getItem(AUTO_COMFORT_KEY);
		if (v === '0') return false;
	} catch {
		/* 忽略 */
	}
	return true;
}

// 舒适目标的参考电平：LiveKit 的 audioLevel 典型说话范围约 0.05-0.5，
// 取 0.15 为"大家都舒适"的收敛目标；超出目标 35% 视为太吵、低于一半视为太小
const COMFORT_TARGET = 0.15;

// 影响浏览器采集约束的调校键组合成快照（用于判断是否必须重新 getUserMedia）
function captureKeyOf(t: AudioTuning): string {
	return JSON.stringify([
		t.echoCancellation,
		t.noiseSuppression,
		t.autoGainControl,
		t.voiceIsolation && !t.aiDenoise,
		t.musicMode
	]);
}

export interface MemberView {
	identity: string;
	name: string;
	isLocal: boolean;
	micMuted: boolean;
	speaking: boolean;
	volume: number; // 该成员在本地的播放音量（0-100，仅远端成员可调）
	bgm: boolean; // 是否正在分享背景音乐（屏幕共享音频轨）
	rtt?: number; // 该成员到自己媒体服务器的往返延迟 ms（数据通道广播，未测到时缺省）
	ip?: string; // 该成员的公网 IP（各自上报，数据通道广播；未取到时缺省）
	bgmName: string; // 正在播放的音乐名（未播放为空串）
	bgmPlaying: boolean;
}

// 每个成员经数据通道广播的实时状态（identity → 状态）
interface MemberStat {
	rtt?: number;
	ip?: string;
	bgm?: { name: string; playing: boolean } | null;
}

export class VoiceRoom {
	// —— 响应式状态（页面直接绑定）——
	status = $state<ConnStatus>('connecting');
	errorMsg = $state('');
	members = $state<MemberView[]>([]);
	micEnabled = $state(false);
	// false 表示音频播放被浏览器自动播放策略拦截，页面据此显示“点击开启声音”按钮
	canPlaybackAudio = $state(true);

	// 音频采集调校（回声消除/降噪/自动增益/人声隔离/音乐模式），
	// 存 localStorage 全局生效；改动经 applyTuning 热应用到已开启的麦克风
	tuning = $state<AudioTuning>(loadTuning());

	// 按参会者独立调节的本地播放音量（0-100，identity → 音量）。
	// 会话级：对方的 identity 每次进房都会变化，跨会话保存没有意义
	volumes = $state<Record<string, number>>({});

	// —— 背景音乐：上传音乐文件，在房间里播放给所有人听 ——
	// 音轨作为独立的音乐轨发布（ScreenShareAudio 源），不经过麦克风处理链，
	// 不受降噪/增益影响（音乐无损）；本地通过 WebAudio 同时回放给分享者自己
	// —— 背景音乐：上传多个音乐文件，在房间里循环播放 ——
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
	private bgmProgressTimer: ReturnType<typeof setInterval> | null = null;

	// 批量添加音乐文件；首次添加会初始化播放链并发布音乐轨，从新歌开始播
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
		// 播放状态一律以 <audio> 的实际事件为准回填（自动播放被拦、手动播放
		// 都由此同步），避免"UI 显示播放中、实际没声"的假状态广播给全房间
		el.addEventListener('play', () => {
			if (!this.bgmPlaying) {
				this.bgmPlaying = true;
				this.refresh();
				void this.publishStat();
			}
		});
		el.addEventListener('pause', () => {
			if (this.bgmPlaying) {
				this.bgmPlaying = false;
				this.refresh();
				void this.publishStat();
			}
		});
		const src = ctx.createMediaElementSource(el);
		const gain = ctx.createGain();
		gain.gain.value = this.bgmVolume / 100;
		const dest = ctx.createMediaStreamDestination();
		src.connect(gain);
		gain.connect(dest);
		gain.connect(ctx.destination); // 分享者自己也能听到
		await this.room.localParticipant.publishTrack(dest.stream.getAudioTracks()[0], {
			source: Track.Source.ScreenShareAudio,
			name: 'background-music',
			// 音乐轨按高保真发布：128k 立体声、无 DTX/RED。
			// （不指定预设会落到默认 48k 单声道，音乐明显发闷）
			audioPreset: AudioPresets.musicHighQualityStereo,
			forceStereo: true,
			dtx: false,
			red: false
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

	async playBgmIndex(index: number) {
		if (index < 0 || index >= this.bgmTracks.length) return;
		const el = await this.ensureBgmChain();
		if (!el) return;
		el.src = this.bgmTracks[index].url;
		el.loop = this.bgmLoopSingle;
		// 不 await 也不预设播放状态：个别环境 play() 可能长时间不落定或被
		// 自动播放策略拦下，实际状态由上面的 play/pause 事件回填
		void el.play().catch(() => {
			/* 被拦时保持"已暂停"，用户可手动点播放 */
		});
		this.bgmIndex = index;
		this.bgmName = this.bgmTracks[index].name;
		this.bgmActive = true;
		this.refresh();
		void this.publishStat(); // 歌名变了：不等 3 秒周期，立刻广播给全房间
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
		// 只驱动 <audio>：播放/暂停状态由 ensureBgmChain 里的 play/pause
		// 事件回填并广播，被浏览器拦截时不会出现"假播放中"状态
		if (this.bgmPlaying) this.bgmAudioEl.pause();
		else void this.bgmAudioEl.play().catch(() => {});
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
		void this.publishStat(); // 停止播放：立刻广播清空歌名
	}


	// —— 房间内实时状态广播：延迟 & 正在播的歌 ——
	// LiveKit 是 SFU：每个客户端只能测到自己到媒体服务器的往返延迟（WebRTC RTT，
	// 即语音包真实路径上的 "ping"，比 TCP 握手延迟更反映通话质量）。
	// 每 3 秒把自己的 RTT + 正在播的歌名经数据通道广播给全房间，
	// 卡片右上角于是能显示"那个人的网络"延迟、背景音乐层能显示歌名。
	private stats = new Map<string, MemberStat>();
	private statTimer: ReturnType<typeof setInterval> | null = null;
	private myIp = ''; // 自己的公网 IP（连上后从 /api/ip 取一次，随状态广播）

	private startStatLoop() {
		this.stopStatLoop();
		void this.publishStat();
		this.statTimer = setInterval(() => void this.publishStat(), 3000);
	}

	private stopStatLoop() {
		if (this.statTimer) {
			clearInterval(this.statTimer);
			this.statTimer = null;
		}
	}

	// 广播自己的 RTT、公网 IP 与背景音乐状态（bgm 变化时也会立即调用）
	private async publishStat() {
		if (!this.room || this.status !== 'connected') return;
		const me = this.room.localParticipant;
		const rtt = await this.measureRtt();
		const prev = this.stats.get(me.identity);
		// RTT 偶发测不到（浏览器不支持/协商中）时保留上次值
		this.stats.set(me.identity, {
			rtt: rtt ?? prev?.rtt,
			ip: this.myIp || prev?.ip,
			bgm: this.bgmActive ? { name: this.bgmName, playing: this.bgmPlaying } : null
		});
		this.refresh();
		try {
			this.room.localParticipant.publishData(
				new TextEncoder().encode(
					JSON.stringify({
						k: 'stat',
						id: me.identity,
						ms: rtt ?? undefined,
						ip: this.myIp || undefined,
						bgm: this.bgmActive ? { n: this.bgmName, on: this.bgmPlaying } : null
					})
				),
				{ reliable: false, topic: 'stat' }
			);
		} catch {
			/* 数据通道不可用时放弃本轮，3 秒后重试 */
		}
	}

	// 从 WebRTC 统计里取当前选中链路的往返延迟（秒 → ms）。
	// 优先 publisher 连接（上行语音的真实路径），拿不到再看 subscriber
	private async measureRtt(): Promise<number | null> {
		const pcm = (
			this.room as unknown as {
				engine?: { pcManager?: { publisher?: { pc?: RTCPeerConnection }; subscriber?: { pc?: RTCPeerConnection } } };
			}
		).engine?.pcManager;
		for (const t of [pcm?.publisher, pcm?.subscriber]) {
			if (!t?.pc) continue;
			try {
				const stats = await t.pc.getStats();
				let best: number | null = null;
				stats.forEach((s) => {
					if (
						s.type === 'candidate-pair' &&
						s.state === 'succeeded' &&
						typeof s.currentRoundTripTime === 'number' &&
						(best === null || s.currentRoundTripTime < best)
					) {
						best = s.currentRoundTripTime;
					}
				});
				if (best !== null) return Math.round(best * 1000);
			} catch {
				/* 换下一条连接 */
			}
		}
		return null;
	}

	// —— 本地即时说话检测（VAD）——
	// 服务端的说话人列表要经一趟上行 + 检测平滑 + 下行广播，本地看慢半拍。
	// 这里直接在本地每 100ms 读一次麦克风电平：超阈值立刻亮（attack 无延迟），
	// 安静后保持 350ms 再灭（release 防闪烁）。阈值随环境噪声自适应，
	// 避免安静房间"听不见小声说话"、嘈杂房间"一直亮"。
	private vadTimer: ReturnType<typeof setInterval> | null = null;
	private localVoiceActive = false;
	private lastVoiceAt = 0;
	private noiseFloor = 0.005;
	private vadCtx: AudioContext | null = null;
	private vadAnalyser: AnalyserNode | null = null;
	private vadTrackId = '';
	private vadTapBuilding = false;

	private startVad() {
		this.stopVad();
		this.vadTimer = setInterval(() => this.vadTick(), 100);
	}

	private onDeviceChange = () => void this.bindDefaultOutput();

	private stopVad() {
		if (this.vadTimer) {
			clearInterval(this.vadTimer);
			this.vadTimer = null;
		}
		this.setLocalVoice(false);
	}

	private vadTick() {
		if (!this.room || this.status !== 'connected' || !this.isMicEnabled()) {
			this.setLocalVoice(false);
			return;
		}
		if (!this.voiceProcessor) {
			// 音乐模式：轨道可能在重新开麦时被更换，旧分析器会一直读到 0——
			// 检测到轨道换了就重建（下次 tick 生效）
			const mst = this.room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track
				?.mediaStreamTrack;
			if (mst && this.vadTrackId !== mst.id) {
				this.teardownVadTap();
				void this.ensureVadTap();
			}
		}
		const lvl = this.readLocalLevel();
		if (lvl === null) {
			// 电平源还没就绪（音乐模式的旁路分析器要现建）：下一拍再试
			void this.ensureVadTap();
			return;
		}
		const attack = Math.max(0.02, this.noiseFloor * 3);
		if (lvl >= attack) {
			this.lastVoiceAt = performance.now();
		} else {
			// 只用安静段更新噪声底，EMA 平滑
			this.noiseFloor = Math.max(0.002, this.noiseFloor * 0.95 + lvl * 0.05);
		}
		this.setLocalVoice(performance.now() - this.lastVoiceAt < 350);
	}

	private setLocalVoice(v: boolean) {
		if (this.localVoiceActive === v) return;
		this.localVoiceActive = v;
		this.refresh();
	}

	// 本地电平（0-1）：语音模式直接读处理链上的输入电平表（按 micGain 折算，
	// 与对方实际听到的响度一致）；音乐模式没有处理链，对原始轨道挂旁路分析器
	private readLocalLevel(): number | null {
		if (this.voiceProcessor) return Math.min(1, this.voiceProcessor.readLevel() * (this.tuning.micGain / 100));
		if (this.vadAnalyser) {
			const buf = new Float32Array(this.vadAnalyser.fftSize);
			this.vadAnalyser.getFloatTimeDomainData(buf);
			let sum = 0;
			for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
			return Math.sqrt(sum / buf.length);
		}
		return null;
	}

	private async ensureVadTap() {
		if (this.vadTapBuilding) return;
		const track = this.room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
		const mst = track?.mediaStreamTrack;
		if (!mst) return;
		if (this.vadAnalyser && this.vadTrackId === mst.id) return; // 已就绪
		this.vadTapBuilding = true;
		try {
			this.vadCtx = this.vadCtx ?? new AudioContext();
			await this.vadCtx.resume().catch(() => {});
			const analyser = this.vadCtx.createAnalyser();
			analyser.fftSize = 512;
			this.vadCtx.createMediaStreamSource(new MediaStream([mst])).connect(analyser);
			this.vadTrackId = mst.id;
			this.vadAnalyser = analyser;
		} catch {
			/* 建不起来就退回服务端说话人信号 */
		} finally {
			this.vadTapBuilding = false;
		}
	}

	private teardownVadTap() {
		try {
			this.vadAnalyser?.disconnect();
			void this.vadCtx?.close();
		} catch {
			/* 忽略 */
		}
		this.vadAnalyser = null;
		this.vadCtx = null;
		this.vadTrackId = '';
	}

	// 自动舒适音量：按服务端上报的说话电平，自动微调每人的播放音量到舒适区间。
	// 手动拖过滑杆的成员会被记住并退出自动调整（尊重手动选择）
	autoComfort = $state(loadAutoComfort());
	private manualSpeakers = new Set<string>();
	private comfort = new Map<string, { ema: number; n: number; lastAdj: number }>();
	private comfortTimer: ReturnType<typeof setInterval> | null = null;

	setAutoComfort(on: boolean) {
		this.autoComfort = on;
		try {
			localStorage.setItem(AUTO_COMFORT_KEY, on ? '1' : '0');
		} catch {
			/* 忽略 */
		}
		if (on) {
			this.manualSpeakers.clear();
			this.startComfortLoop();
		} else {
			this.stopComfortLoop();
		}
	}

	private startComfortLoop() {
		if (this.comfortTimer) return;
		this.comfortTimer = setInterval(() => this.comfortTick(), 2000);
	}

	private stopComfortLoop() {
		if (this.comfortTimer) {
			clearInterval(this.comfortTimer);
			this.comfortTimer = null;
		}
	}

	// 每 2 秒跑一次的舒适度调节：
	//   只统计"正在说话"时的电平（EMA 平滑），EMA 稳定后：
	//   太吵（超目标 35%）→ 按比例调低该成员的本地音量；太小（低于目标一半）→ 上调（上限 100%）
	//   手动拖过滑杆的成员跳过；音乐模式跳过（保真优先）
	private comfortTick() {
		if (!this.room || !this.autoComfort || this.tuning.musicMode) return;
		const now = Date.now();
		for (const p of this.room.remoteParticipants.values()) {
			if (this.manualSpeakers.has(p.identity)) continue;
			const level = p.audioLevel;
			if (level < 0.03) continue; // 没在说话，不计入
			let st = this.comfort.get(p.identity);
			if (!st) {
				this.comfort.set(p.identity, { ema: level, n: 1, lastAdj: now });
				continue;
			}
			st.ema = st.ema * 0.7 + level * 0.3;
			st.n++;
			if (st.n < 3 || now - st.lastAdj < 6000) continue;

			const cur = this.volumes[p.identity] ?? 100;
			if (st.ema > COMFORT_TARGET * 1.35 && cur > 25) {
				// 太吵：按目标比例调低（最低 25%，避免一刀静音）
				const next = Math.max(25, Math.round(cur * (COMFORT_TARGET / st.ema)));
				if (next < cur) {
					this.setVolume(p.identity, next);
					st.lastAdj = now;
					st.n = 0;
				}
			} else if (st.ema < COMFORT_TARGET * 0.5 && cur < 100) {
				// 太小：上调（元素音量上限 100%，超出部分依赖对方侧 AGC）
				const next = Math.min(100, Math.round(cur * (COMFORT_TARGET / Math.max(st.ema, 0.01))));
				if (next > cur) {
					this.setVolume(p.identity, next);
					st.lastAdj = now;
					st.n = 0;
				}
			}
		}
		for (const id of this.comfort.keys()) {
			if (!this.room.remoteParticipants.has(id)) this.comfort.delete(id);
		}
	}

	// 语音处理链（TrackProcessor）：挂载在 SDK 原生管理的麦克风轨道上，
	// 开麦/闭麦/重发布生命周期全部由 SDK 负责，避免自管轨道的假死问题
	private voiceProcessor: VoiceProcessor | null = null;
	private lastMicTrack: LocalAudioTrack | null = null;
	private selfCheckTimer: ReturnType<typeof setInterval> | null = null;
	private lastOutboundBytes = -1;
	private selfCheckRetries = 0;
	private selfCheckTicks = 0;

	// Room 实例故意不放 $state：Svelte 的深层代理会包住 SDK 内部对象，
	// 只把从它提取出的纯数据快照放进响应式状态即可。
	private room: Room | null = null;
	private disposed = false;
	// 当前正在说话的 identity 集合（非响应式，重建列表时取用）
	private speakingIds = new Set<string>();

	async connect(wsUrl: string, token: string) {
		const room = new Room();
		this.room = room;

		// —— 成员进出 & 麦克风开关：任何变化都重建成员快照 ——
		const onChange = () => this.refresh();
		room.on(RoomEvent.ParticipantConnected, onChange);
		room.on(RoomEvent.ParticipantDisconnected, onChange);
		room.on(RoomEvent.TrackMuted, onChange);
		room.on(RoomEvent.TrackUnmuted, onChange);
		room.on(RoomEvent.LocalTrackPublished, onChange);
		room.on(RoomEvent.LocalTrackUnpublished, onChange);

		room.on(RoomEvent.TrackSubscribed, (track) => {
			this.attachRemoteAudio(track);
			// 低延迟提示：Chrome 支持对音频接收器设置抖动缓冲目标，
			// 默认缓冲会随网络抖动涨到数百毫秒，这里压到 ~100ms
			setTimeout(() => this.applyPlayoutDelayHint(), 100);
			// Chromium 已知问题：输出走"默认设备"别名时回声消除可能完全失效
			// （issues.chromium.org/40252911）——显式绑定到具体输出设备规避
			void this.bindDefaultOutput();
			onChange();
		});
		room.on(RoomEvent.TrackUnsubscribed, (track) => {
			if (track.kind === Track.Kind.Audio) {
				// 移除自己 append 的播放元素并解除绑定
				for (const el of track.attachedElements) el.remove();
				track.detach();
			}
			onChange();
		});

		// —— “谁在说话”：LiveKit 服务端已经做好音量检测，直接下发说话人列表，
		//    浏览器端不需要（也不应该）自己分析音频电平 ——
		//    （本地成员由上面的 VAD 即时判定，不等服务端回传，见 refresh()）
		room.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
			this.speakingIds = new Set(speakers.map((p) => p.identity));
			this.refresh();
		});

		// —— 数据通道：接收其他成员广播的 {延迟, 公网IP, 正在播的歌} ——
		room.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
			if (topic !== 'stat') return;
			try {
				const msg = JSON.parse(new TextDecoder().decode(payload));
				if (msg?.k !== 'stat' || typeof msg.id !== 'string') return;
				const prev = this.stats.get(msg.id);
				this.stats.set(msg.id, {
					rtt: typeof msg.ms === 'number' && msg.ms >= 0 ? Math.round(msg.ms) : prev?.rtt,
					ip: typeof msg.ip === 'string' && msg.ip ? msg.ip : prev?.ip,
					bgm:
						msg.bgm && typeof msg.bgm.n === 'string'
							? { name: msg.bgm.n, playing: !!msg.bgm.on }
							: null
				});
				this.refresh();
			} catch {
				/* 坏包忽略 */
			}
		});

		// —— 浏览器自动播放限制的处理（关键逻辑）——
		// Chrome 规定：页面没有用户手势前禁止出声。“加入房间”的点击发生在上一个页面，
		// 手势通常带不过来，所以 connect() 后立刻 startAudio() 很可能被拦。
		// 被拦时 SDK 会发出 AudioPlaybackStatusChanged 事件（canPlaybackAudio = false），
		// 页面上随之渲染“点击开启声音”按钮 → 用户在当前页面点一下 → 再调 startAudio()，
		// 这一次带了真实手势，浏览器必然放行。
		room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
			this.canPlaybackAudio = room.canPlaybackAudio;
		});

		room.on(RoomEvent.Disconnected, () => {
			this.stopComfortLoop();
			this.stopPublishSelfCheck();
			this.stopStatLoop();
			this.stopVad();
			this.stopEchoPoll();
			navigator.mediaDevices?.removeEventListener?.('devicechange', this.onDeviceChange);
			if (this.disposed) return;
			// 非主动离开的断线：被同 identity 顶号、服务端踢出、网络中断等
			this.status = 'disconnected';
		});

		this.status = 'connecting';
		try {
			// 建立信令连接；HTTPS 下自动改走同源 /livekit 代理（见 api.ts resolveSignalUrl）。
			// autoSubscribe 默认开启，别人发布的音频会自动订阅
			await room.connect(resolveSignalUrl(wsUrl), token);
			// 房间里已有的远端音频轨道（先于我们加入的人）也要同样挂载播放，
			// 必须走同一入口进 DOM（iOS Safari 不进 DOM 可能不出声）并打上
			// data-echo-remote 标记，bindDefaultOutput 的 setSinkId 修复才覆盖得到
			for (const p of room.remoteParticipants.values()) {
				const mic = p.getTrackPublication(Track.Source.Microphone);
				if (mic?.isSubscribed && mic.track?.kind === Track.Kind.Audio) this.attachRemoteAudio(mic.track);
			}
			this.applyStoredVolumes();
			this.applyPlayoutDelayHint();
			void this.bindDefaultOutput();
		} catch (e) {
			this.status = 'error';
			this.errorMsg = e instanceof Error ? e.message : String(e);
			return;
		}
		this.status = 'connected';

		// 取自己的公网 IP（拿到后随状态广播给房间成员）
		fetchMyIp()
			.then((ip) => {
				this.myIp = ip;
				void this.publishStat();
			})
			.catch(() => {
				/* 取不到（接口异常）就不广播 IP，弹窗里显示"未知" */
			});

		// 启动自动舒适音量调节循环（可在面板关闭）
		if (this.autoComfort) this.startComfortLoop();
		// 延迟/歌名广播（3 秒一拍）、本地即时说话检测（100ms 一拍）、回声抑制读数（2 秒一拍）
		this.startStatLoop();
		this.startVad();
		this.startEchoPoll();
		// 输出设备插拔/切换时重新绑定远端播放元素（保 AEC 参考）
		navigator.mediaDevices?.addEventListener?.('devicechange', this.onDeviceChange);

		// 开发调试钩子：把底层 Room 与控制器暂存到 window，方便在控制台/自动化
		// 测试中做调试（例如检查 VAD/延迟广播内部状态）。
		if (import.meta.env.DEV || localStorage.getItem('echo:debug') === '1') {
			(window as unknown as { __lkRoom?: Room; __echoCtl?: VoiceRoom }).__lkRoom = room;
			(window as unknown as { __echoCtl?: VoiceRoom }).__echoCtl = this;
		}

		// 尽早尝试解锁播放；被拦截也没关系，上面的监听会把按钮显示出来
		try {
			await room.startAudio();
		} catch {
			/* 等待用户手势，见 AudioPlaybackStatusChanged */
		}
		this.canPlaybackAudio = room.canPlaybackAudio;

		this.refresh();
	}

	// 开/关麦克风（统一入口）。
	// 语音模式：原生开麦后，通过 TrackProcessor 把「压限 → 增益 → RNNoise」
	// 挂到 SDK 管理的麦克风轨道上（setProcessor 内部 replaceTrack 无缝换轨）；
	// 音乐模式：原生采集无处理，高音质立体声。
	async toggleMic() {
		if (!this.room || this.status !== 'connected') return;
		await this.enableMic(!this.isMicEnabled());
	}

	// 影响浏览器采集约束（getUserMedia 参数）的调校键快照。
	// SDK 的 setMicrophoneEnabled(true) 在已有轨道时只会解除静音、忽略新约束，
	// 所以必须自己记住"上次实际采集用的参数"，变了就强制重新采集
	private lastCaptureKey = '';

	private async enableMic(on: boolean) {
		if (!this.room || this.status !== 'connected') return;
		const lp = this.room.localParticipant;
		try {
			this.errorMsg = '';
			if (!on) {
				await this.enableMicOff();
				this.refresh();
				return;
			}

			const wantKey = captureKeyOf(this.tuning);
			const stale = lp.getTrackPublication(Track.Source.Microphone)?.track;
			if (stale && this.lastCaptureKey !== wantKey) {
				// 采集参数变了：彻底下线旧轨，逼 SDK 重新 getUserMedia。
				// 不走 enableMicOff 的 mute 路径——stopProcessor 会把原始轨
				// replace 回 sender，与 unpublish 的换轨互相抢占，重启多了可能卡死；
				// unpublishTrack(…, true) 的 stop() 会连带销毁处理器
				this.stopPublishSelfCheck();
				this.voiceProcessor = null;
				this.lastMicTrack = null;
				try {
					await lp.unpublishTrack(stale, true);
				} catch {
					/* 旧轨道可能已被移除 */
				}
			} else if (this.isMicEnabled()) {
				// 同参数重启（处理链变化）：先关后开
				await this.enableMicOff();
			}

			// 原生开麦（采集约束按调校；发布参数按模式）
			await lp.setMicrophoneEnabled(true, captureOptionsOf(this.tuning), publishOptionsOf(this.tuning));
			this.lastCaptureKey = wantKey;
			const pub = lp.getTrackPublication(Track.Source.Microphone);
			const localTrack = pub?.track as LocalAudioTrack | undefined;

			if (this.tuning.musicMode || !localTrack) {
				// 音乐模式：无处理链
				this.stopPublishSelfCheck();
			} else {
				// 语音模式：挂处理链（低切 → 嘶声抑制 → 压限 → 增益 → RNNoise 人声提取）
				this.voiceProcessor = new VoiceProcessor(this.tuning);
				await localTrack.setProcessor(this.voiceProcessor);
				// 记住挂了链的轨道：关麦时才能真正 stopProcessor（否则 AudioContext
				// 和 RNNoise 会在闭麦后继续空转烧 CPU）
				this.lastMicTrack = localTrack;
				// RNNoise 模块没加载出来（浏览器不支持/网络拦截）：
				// 把浏览器降噪开回来兜底，麦克风保持可用，并提示用户
				if (this.voiceProcessor.aiFallbackUsed) {
					try {
						await localTrack.applyConstraints({ noiseSuppression: true });
					} catch {
						/* 浏览器不接受就算了 */
					}
					this.errorMsg = 'AI 降噪模块在当前浏览器加载失败，本次已自动改用浏览器降噪（麦克风不受影响）';
				}
				// 发布后自检：确认上行真的在流动（防轨道假死）
				this.startPublishSelfCheck(localTrack);
			}
			this.refresh();
		} catch (e) {
			this.errorMsg = '麦克风操作失败：' + (e instanceof Error ? e.message : String(e));
		}
	}

	private async enableMicOff() {
		if (!this.room) return;
		const lp = this.room.localParticipant;
		this.stopPublishSelfCheck();
		if (this.lastMicTrack) {
			try {
				await this.lastMicTrack.stopProcessor();
			} catch {
				/* 可能已随轨道停止 */
			}
		}
		this.voiceProcessor = null;
		this.lastMicTrack = null;
		await lp.setMicrophoneEnabled(false);
	}

	// 麦克风输入增益（0-200）：处理链活着时实时调整，无需重启
	setMicGain(percent: number) {
		this.tuning.micGain = Math.max(0, Math.min(200, Math.round(percent)));
		saveTuning(this.tuning);
		this.voiceProcessor?.setGain(this.tuning.micGain);
	}

	// 输入电平（0-1）：设置面板的电平条按需读取
	readInputLevel(): number {
		return this.voiceProcessor?.readLevel() ?? 0;
	}

	// —— 发布后自检：确认上行真的在流动，防偶发"轨道假死"（发布成功但 RTP 从未流出）。
	// 节奏：开麦后前 10 秒每秒一查（快速自愈窗口，用户刚点开麦多半正在说话）；
	// 之后降为每 5 秒一查的慢速阶段，覆盖"开麦后先憋着不说话"的情况，
	// 直到确认字节流动才停止。检出假死 → 重挂处理链，最多 3 次，仍失败才提示手动。
	// 误判防护：静默期（电平≈0）不判定，开 DTX 后的静音停包不会被误认为假死。 ---
	private startPublishSelfCheck(track: LocalAudioTrack) {
		this.stopPublishSelfCheck();
		this.lastOutboundBytes = -1;
		this.selfCheckRetries = 0;
		this.selfCheckTicks = 0;
		this.selfCheckTimer = setInterval(() => this.selfCheckTick(track), 1000);
	}

	private stopPublishSelfCheck() {
		if (this.selfCheckTimer) {
			clearInterval(this.selfCheckTimer);
			this.selfCheckTimer = null;
		}
		this.lastOutboundBytes = -1;
	}

	private async selfCheckTick(track: LocalAudioTrack) {
		if (this.disposed || !this.room || !this.voiceProcessor) return this.stopPublishSelfCheck();
		this.selfCheckTicks++;
		// 快速阶段（前 10 秒）每秒一查；慢速阶段每 5 秒一查
		if (this.selfCheckTicks > 10 && this.selfCheckTicks % 5 !== 0) return;

		const pc = (
			(this.room as unknown as {
				engine?: { pcManager?: { publisher?: { pc?: RTCPeerConnection } } };
			}).engine?.pcManager?.publisher?.pc
		);
		if (!pc) return;
		const stats = await pc.getStats();
		let bytes = 0;
		stats.forEach((s) => {
			if (s.type === 'outbound-rtp' && s.kind === 'audio') bytes = s.bytesSent;
		});

		const inputLevel = this.voiceProcessor.readLevel();
		// 用户正在发声（原始麦有电平）但 RTP 字节零增长 → 轨道假死
		const stalled = this.lastOutboundBytes >= 0 && bytes === this.lastOutboundBytes && inputLevel > 0.02;
		// 用户在发声且字节在增长 → 上行健康确认
		const flowing = bytes > this.lastOutboundBytes && inputLevel > 0.02;
		this.lastOutboundBytes = bytes;

		if (flowing) {
			// 确认上行健康：自检使命完成（慢速阶段由此收尾）
			this.stopPublishSelfCheck();
			return;
		}
		if (!stalled) return; // 用户没在说话，无从判断，继续等

		if (this.selfCheckRetries >= 3) {
			this.stopPublishSelfCheck();
			this.errorMsg = '检测到麦克风异常，自动重试 3 次未恢复，请手动关闭再打开麦克风';
			return;
		}
		this.selfCheckRetries++;
		this.errorMsg = '';
		try {
			await track.stopProcessor();
			this.voiceProcessor = new VoiceProcessor(this.tuning);
			await track.setProcessor(this.voiceProcessor);
		} catch {
			/* 轨道可能已停止，忽略 */
		}
	}

	// 按参会者调音量：SDK 会在对方麦克风轨道"现在有或将来加入"时都应用该音量。
	// manual=true 表示用户手动拖滑杆——该成员退出自动舒适调整
	setVolume(identity: string, volume: number, manual = false) {
		this.volumes[identity] = volume;
		if (manual) this.manualSpeakers.add(identity);
		this.room?.remoteParticipants.get(identity)?.setVolume(volume / 100, Track.Source.Microphone);
		this.refresh();
	}

	// 远端音频轨统一挂载入口（订阅事件与 connect 时的存量轨道都走这里）：
	// vanilla 版 SDK 的 attach() 只创建播放元素、不自动加入 DOM，
	// 必须自己 append（iOS Safari 不进 DOM 可能不出声）；
	// 元素带 data-echo-remote 标记，bindDefaultOutput 的 setSinkId 修复按它扫描
	private attachRemoteAudio(track: RemoteTrack) {
		if (track.kind !== Track.Kind.Audio) return;
		// 防御：清理上一轮发布遗留的已结束播放元素（个别重发布场景
		// Unsubscribed 事件不触发，元素会越积越多）
		for (const old of document.querySelectorAll<HTMLAudioElement>('audio[data-echo-remote]')) {
			const src = old.srcObject;
			const t = src instanceof MediaStream ? src.getAudioTracks()[0] : undefined;
			if (!t || t.readyState === 'ended') old.remove();
		}
		const el = track.attach() as HTMLAudioElement;
		el.dataset.echoRemote = 'true';
		el.style.display = 'none';
		document.body.appendChild(el);
		this.applyStoredVolumes();
	}

	// 挂载远端音轨后，把记住的按人音量重新应用一遍
	private applyStoredVolumes() {
		if (!this.room) return;
		for (const [identity, vol] of Object.entries(this.volumes)) {
			this.room.remoteParticipants
				.get(identity)
				?.setVolume(vol / 100, Track.Source.Microphone);
		}
	}

	// Chromium 已知问题规避（issues.chromium.org/40252911）：
	// 音频输出走 <audio> 默认别名时，Chrome 的 AEC 参考可能绑定失败 → 回声消除完全失效，
	// 尤其系统存在多个输出设备（显示器 HDMI/蓝牙/USB）时。把所有远端播放元素显式
	// setSinkId 到"默认设备对应的具体 deviceId"（而非 'default' 别名）即可修复
	private async bindDefaultOutput() {
		if (!this.room) return;
		try {
			const devs = await navigator.mediaDevices.enumerateDevices();
			const def = devs.find((d) => d.kind === 'audiooutput' && d.deviceId === 'default');
			if (!def || !def.label) return;
			// 'default' 条目的 label 形如 "默认 - 扬声器 (…)" / "Default - …"，去掉前缀后
			// 与物理设备条目同名，取其具体 id
			const bare = def.label.replace(/^(默认|Default|既定)\s*-\s*/, '');
			const concrete = devs.find(
				(d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.label === bare
			);
			if (!concrete) return;
			for (const el of document.querySelectorAll<HTMLAudioElement>('audio[data-echo-remote]')) {
				if (typeof el.setSinkId === 'function' && el.sinkId !== concrete.deviceId) {
					await el.setSinkId(concrete.deviceId).catch(() => {});
				}
			}
		} catch {
			/* 枚举失败（权限未授予等）就保持默认输出 */
		}
	}

	// —— 回声消除健康读数：从发布端 WebRTC 统计读"回声抑制量"（ERLE, dB）——
	// Chrome 专有统计；对方出声时该值明显高于 0 说明 AEC 在真实工作，
	// 面板里直接显示，把"回声消除似乎没用"变成可观测的数据
	echoLevelDb = $state<number | null>(null);
	private echoPollTimer: ReturnType<typeof setInterval> | null = null;

	private startEchoPoll() {
		this.stopEchoPoll();
		this.echoPollTimer = setInterval(() => void this.pollEchoStats(), 2000);
	}

	private stopEchoPoll() {
		if (this.echoPollTimer) {
			clearInterval(this.echoPollTimer);
			this.echoPollTimer = null;
		}
		this.echoLevelDb = null;
	}

	private async pollEchoStats() {
		if (!this.room || this.status !== 'connected') return;
		const pc = (
			(this.room as unknown as {
				engine?: { pcManager?: { publisher?: { pc?: RTCPeerConnection } } };
			}).engine?.pcManager?.publisher?.pc
		);
		if (!pc) return;
		try {
			const stats = await pc.getStats();
			let erle: number | null = null;
			stats.forEach((s) => {
				if (s.type === 'outbound-rtp' && s.kind === 'audio') {
					const v = (s as { echoReturnLossEnhancement?: number }).echoReturnLossEnhancement;
					if (typeof v === 'number' && isFinite(v)) erle = v;
				}
			});
			this.echoLevelDb = erle;
		} catch {
			/* 统计不可用时保持上次值 */
		}
	}

	// 低延迟提示：对音频接收器设置 playoutDelayHint（Chrome 私有特性），
	// 目标 100ms——正常网络下显著小于浏览器自适应缓冲的增长上限。
	// 依赖 SDK 内部的 PeerConnection，非 Chrome 或结构变化时静默跳过
	private applyPlayoutDelayHint() {		if (!this.room) return;
		try {
			const pcm = (this.room as unknown as {
				engine?: { pcManager?: { publisher?: { pc?: RTCPeerConnection }; subscriber?: { pc?: RTCPeerConnection } } };
			}).engine?.pcManager;
			if (!pcm) return;
			for (const t of [pcm.publisher, pcm.subscriber]) {
				t?.pc?.getReceivers().forEach((r) => {
					if ('playoutDelayHint' in r) {
						(r as RTCRtpReceiver & { playoutDelayHint: number }).playoutDelayHint = 0.1;
					}
				});
			}
		} catch {
			/* 结构变化时静默跳过 */
		}
	}

	// 热应用新的音频调校：
	//   仅输入增益变了 → 实时改增益；
	//   采集开关（回声消除/降噪/自动增益/人声隔离）或处理链开关变了 →
	//   完整重启麦克风。注意采集开关不要走 applyConstraints 热更新——
	//   Chrome 对运行中的轨道切换回声消除并不可靠（可能"成功"却没真开），
	//   必须重新 getUserMedia（enableMic 内部会按参数快照强制重新采集）
	async applyTuning(next: AudioTuning) {
		const prev = this.tuning;
		this.tuning = next;
		saveTuning(next);
		if (!this.room || this.status !== 'connected' || !this.isMicEnabled()) return;

		const gainOnly =
			prev.micGain !== next.micGain &&
			['echoCancellation', 'noiseSuppression', 'autoGainControl', 'voiceIsolation', 'aiDenoise', 'compressor', 'musicMode', 'lowCut', 'hissCut'].every(
				(k) => prev[k as keyof AudioTuning] === next[k as keyof AudioTuning]
			);
		if (gainOnly) {
			this.voiceProcessor?.setGain(next.micGain);
			return;
		}

		// 直接调 enableMic(true)：它内部按"参数是否变化"选择换轨或快速重启，
		// 不先 enableMicOff——避免 stopProcessor 的换轨与 unpublish 抢占 sender
		try {
			await this.enableMic(true);
			this.refresh();
		} catch (e) {
			this.errorMsg = '应用音频设置失败：' + (e instanceof Error ? e.message : String(e));
		}
	}

	// “点击开启声音”按钮的回调：此刻有真实用户手势，浏览器会放行
	async unlockAudio() {
		if (!this.room) return;
		try {
			await this.room.startAudio();
		} catch {
			/* 仍然被拦就保持按钮展示 */
		}
		this.canPlaybackAudio = this.room.canPlaybackAudio;
	}

	async leave() {
		this.disposed = true;
		this.stopComfortLoop();
		this.comfort.clear();
		this.manualSpeakers.clear();
		this.stopPublishSelfCheck();
		this.stopStatLoop();
		this.stopVad();
		this.stopEchoPoll();
		this.teardownVadTap();
		try {
			await this.lastMicTrack?.stopProcessor();
		} catch {
			/* 已停止 */
		}
		this.voiceProcessor = null;
		this.lastMicTrack = null;
		this.stopBgm();
		// disconnect 会向服务端发送离开信令，其他成员立刻收到 ParticipantDisconnected
		await this.room?.disconnect();
		this.room = null;
	}

	isMicEnabled(): boolean {
		const pub = this.room?.localParticipant.getTrackPublication(Track.Source.Microphone);
		return !!pub && !pub.isMuted;
	}

	// 从 SDK 对象提取纯数据快照，重建响应式成员列表
	private refresh() {
		if (!this.room) return;
		const micMutedOf = (p: Participant) => {
			const pub = p.getTrackPublication(Track.Source.Microphone);
			return pub ? pub.isMuted : true; // 没发布轨道视同闭麦
		};
		const local = this.room.localParticipant;
		this.micEnabled = !micMutedOf(local);

		const statOf = (p: Participant) => {
			const s = this.stats.get(p.identity);
			return {
				rtt: s?.rtt,
				ip: s?.ip,
				bgmName: s?.bgm?.name ?? '',
				bgmPlaying: s?.bgm?.playing ?? false
			};
		};

		const localStat = statOf(local);
		const list: MemberView[] = [
			{
				identity: local.identity,
				name: local.name || local.identity,
				isLocal: true,
				micMuted: micMutedOf(local),
				// 本地成员：优先用自己的即时 VAD（attack 0 延迟），处理链没就绪时退回服务端信号
				speaking: this.localVoiceActive || this.speakingIds.has(local.identity),
				volume: 100,
				bgm: !!local.getTrackPublication(Track.Source.ScreenShareAudio)?.track,
				...localStat
			}
		];
		for (const p of this.room.remoteParticipants.values()) {
			list.push({
				identity: p.identity,
				name: p.name || p.identity,
				isLocal: false,
				micMuted: micMutedOf(p),
				speaking: this.speakingIds.has(p.identity),
				volume: this.volumes[p.identity] ?? 100,
				bgm: !!p.getTrackPublication(Track.Source.ScreenShareAudio)?.track,
				...statOf(p)
			});
		}
		// 清掉已离开成员的广播状态
		for (const id of this.stats.keys()) {
			if (id !== local.identity && !this.room.remoteParticipants.has(id)) this.stats.delete(id);
		}
		this.members = list;
	}
}
