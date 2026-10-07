// 语音处理链 TrackProcessor：实现 LiveKit 官方的处理器接口，
// 把「压限器 → 输入增益 → RNNoise 人声提取」挂到 SDK 原生管理的麦克风轨道上。
//
// 相比自行 getUserMedia + publishTrack 的自管轨道方案：
//   - SDK 全权管理设备生命周期（开麦/闭麦/重连/重发布），不再有"轨道假死"的自管轨道问题
//   - setProcessor 内部通过 replaceTrack 无缝换轨，新成员立即能听到
//   - 闭麦 = 原生 mute，开麦 = 原生 unmute，毫秒级且不重建设备
import { AudioPresets, Track, type TrackProcessor, type AudioProcessorOptions, type AudioCaptureOptions, type TrackPublishOptions } from 'livekit-client';
import type { AudioTuning } from './audio-tuning.svelte';

const WORKLET_URL = '/rnnoise/rnnoise-worklet.js';

// 处理链共享的单例 AudioContext（48kHz）：
// 每次重启麦克风都新建 ctx 会反复编译 1.9MB 的 RNNoise worklet，
// 且浏览器对页面同时存在的 AudioContext 数量有限制——多次重启后
// addModule 开始失败（触发降噪降级）。单例 + 只加载一次彻底避免。
let sharedCtx: AudioContext | null = null;
let workletReady: Promise<void> | null = null;

function getSharedCtx(): AudioContext {
	if (!sharedCtx || sharedCtx.state === 'closed') {
		try {
			sharedCtx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
		} catch {
			sharedCtx = new AudioContext();
		}
	}
	return sharedCtx;
}

function ensureWorklet(): Promise<void> {
	workletReady ??= getSharedCtx().audioWorklet.addModule(WORKLET_URL).catch((e) => {
		workletReady = null; // 失败允许下次重试
		throw e;
	});
	return workletReady;
}

export interface VoiceChainHandle {
	setGain: (percent: number) => void;
	readLevel: () => number;
}

export function captureOptionsOf(t: AudioTuning): AudioCaptureOptions {
	if (t.musicMode) {
		return { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
	}
	const opts: AudioCaptureOptions = {
		echoCancellation: t.echoCancellation,
		// 浏览器 NS 与 RNNoise 叠加使用：RNNoise 实测不覆盖低频段（隆隆声原样
		// 通过），低频稳态噪声正是浏览器 NS 的强项，关掉它会让 AI 降噪显现
		// "低频负优化"。个别设备叠加出怪声时用户可手动关闭"噪声抑制"。
		noiseSuppression: t.noiseSuppression,
		autoGainControl: t.autoGainControl
	};
	// 浏览器原生"人声隔离"，与 RNNoise 二选一，避免双重 ML 处理
	if (t.voiceIsolation && !t.aiDenoise) opts.voiceIsolation = true;
	return opts;
}

export function publishOptionsOf(t: AudioTuning): TrackPublishOptions {
	if (t.musicMode) {
		return { audioPreset: AudioPresets.musicHighQualityStereo, forceStereo: true, dtx: false, red: false };
	}
	return { dtx: true, red: true };
}

export class VoiceProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
	name = 'rnnoise-voice';
	processedTrack: MediaStreamTrack | undefined;
	// RNNoise 模块加载失败时为 true：本次链路退回浏览器降噪（麦克风保持可用）
	aiFallbackUsed = false;

	private tuning: AudioTuning;
	private ctx: AudioContext | null = null;
	private source: MediaStreamAudioSourceNode | null = null;
	private worklet: AudioWorkletNode | null = null;
	private gainNode: GainNode | null = null;
	private meter: AnalyserNode | null = null;

	constructor(tuning: AudioTuning) {
		this.tuning = tuning;
	}

	// SDK 调用：拿到原生麦克风轨，构建处理链，产出 processedTrack
	async init(opts: AudioProcessorOptions) {
		this.ctx = getSharedCtx();
		if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});

		this.source = this.ctx.createMediaStreamSource(new MediaStream([opts.track]));
		let head: AudioNode = this.source;

		// 低切：人声基频（男声约 85Hz）以下全是杂音——桌面敲击震动、空调嗡嗡、
		// 喷麦气流、Line 电共模嗡声（50/60Hz 及其谐波）都在这个区间
		if (this.tuning.lowCut) {
			const hp = this.ctx.createBiquadFilter();
			hp.type = 'highpass';
			hp.frequency.value = 85;
			hp.Q.value = 0.71; // Butterworth 特性：通带平直、12dB/倍频程
			head.connect(hp);
			head = hp;
		}

		// 嘶声抑制：高频搁架式衰减，压住电流嘶嘶声/话筒底噪/前置放大噪声。
		// 搁架比硬低通自然——保留齿音附近的通透感，只压 9kHz 以上
		if (this.tuning.hissCut) {
			const shelf = this.ctx.createBiquadFilter();
			shelf.type = 'highshelf';
			shelf.frequency.value = 9000;
			shelf.gain.value = -6;
			head.connect(shelf);
			head = shelf;
		}

		// 防炸压限：削掉瞬间峰值（阈值 -24dB，压缩比 12:1，快攻击慢释放）
		if (this.tuning.compressor) {
			const comp = this.ctx.createDynamicsCompressor();
			comp.threshold.value = -24;
			comp.knee.value = 30;
			comp.ratio.value = 12;
			comp.attack.value = 0.003;
			comp.release.value = 0.25;
			head.connect(comp);
			head = comp;
		}

		// 输入增益：敏感麦调低防炸、哑麦调高（0-200%），运行中可实时改
		this.gainNode = this.ctx.createGain();
		this.gainNode.gain.value = Math.max(0, Math.min(200, this.tuning.micGain)) / 100;
		head.connect(this.gainNode);
		head = this.gainNode;

		// RNNoise 人声提取：滤掉键盘声等突发噪声。
		// 模块加载失败（浏览器不支持/企业网络拦截/上下文耗尽）不应让麦克风
		// 整个不可用：退回浏览器降噪并标记，由控制器提示用户
		if (this.tuning.aiDenoise) {
			try {
				await ensureWorklet();
				this.worklet = new AudioWorkletNode(this.ctx, 'rnnoise', {
					numberOfInputs: 1,
					numberOfOutputs: 1,
					outputChannelCount: [1]
				});
				head.connect(this.worklet);
				head = this.worklet;
			} catch {
				this.worklet = null;
				this.aiFallbackUsed = true;
			}
		}

		const dest = this.ctx.createMediaStreamDestination();
		head.connect(dest);
		this.processedTrack = dest.stream.getAudioTracks()[0];

		// 输入电平表：抽头在增益之前，反映真实说话电平
		this.meter = this.ctx.createAnalyser();
		this.meter.fftSize = 1024;
		this.source.connect(this.meter);
	}

	// 调校变更（开关/压限/降噪）：SDK 调用，重建链
	async restart(opts: AudioProcessorOptions) {
		this.teardownChain();
		await this.init(opts);
	}

	async destroy() {
		this.teardownChain();
	}

	// 实时调整输入增益（0-200），无需重启链
	setGain(percent: number) {
		if (this.gainNode) this.gainNode.gain.value = Math.max(0, Math.min(200, percent)) / 100;
	}

	// 原始麦克风瞬时 RMS（0-1），供设置面板电平条
	readLevel(): number {
		if (!this.meter) return 0;
		const buf = new Float32Array(this.meter.fftSize);
		this.meter.getFloatTimeDomainData(buf);
		let sum = 0;
		for (let j = 0; j < buf.length; j++) sum += buf[j] * buf[j];
		return Math.sqrt(sum / buf.length);
	}

	private teardownChain() {
		try {
			this.source?.disconnect();
			// worklet/gain 也断开：只断 source 的话，下游子图（尤其 AudioWorklet）
			// 可能滞留继续空转处理静音，等 GC 才回收
			this.worklet?.disconnect();
			this.gainNode?.disconnect();
			this.meter?.disconnect();
			this.processedTrack?.stop();
		} catch {
			/* 忽略清理错误 */
		}
		this.source = null;
		this.worklet = null;
		this.gainNode = null;
		this.meter = null;
		this.processedTrack = undefined;
		// 注意：不关闭 this.ctx——它是跨处理链共享的单例（见 getSharedCtx），
		// 只断开本链的节点即可
		this.ctx = null;
	}
}
