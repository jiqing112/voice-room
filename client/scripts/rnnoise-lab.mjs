// RNNoise worklet 离线实验台：在 Node 里直接实例化 worklet 的 wasm 模块，
// 喂合成信号（低频隆隆声/直流偏移/嘶嘶声/人声），测量输出是否产生新的伪迹。
// 用法：node scripts/rnnoise-lab.mjs
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// —— shim AudioWorklet 宿主环境 ——
globalThis.sampleRate = 48000;
globalThis.AudioWorkletProcessor = class {
	constructor() {
		this.port = { postMessage() {} };
	}
};
let registered = null;
globalThis.registerProcessor = (name, cls) => {
	registered = cls;
};

const syncSrc = readFileSync(resolve(here, '../static/rnnoise/rnnoise-sync.js'), 'utf8')
	.replaceAll('import.meta.url', '"file:///rnnoise-sync.js"')
	.replace('export default createRNNWasmModuleSync;', 'globalThis.createRNNWasmModuleSync = createRNNWasmModuleSync;');
const procSrc = readFileSync(resolve(here, '../static/rnnoise/rnnoise-processor.js'), 'utf8');
(0, eval)(syncSrc);
(0, eval)(procSrc);

// —— 每帧 480 样本灌入，模拟 128 量子 ——
function makeProcessor() {
	return new registered();
}

function feed(p, signal) {
	// signal: Float32Array；以 128 样本量子分块调用 process
	const out = new Float32Array(signal.length);
	const chunk = new Float32Array(128);
	for (let off = 0; off < signal.length; off += 128) {
		const n = Math.min(128, signal.length - off);
		for (let i = 0; i < n; i++) chunk[i] = signal[off + i];
		const src = n === 128 ? chunk : chunk.subarray(0, n);
		const dst = new Float32Array(n);
		p.process([[src]], [[dst]]);
		out.set(dst, off);
	}
	return out;
}

// —— 简易频段能量计（一阶滤波对） ——
function bandEnergy(x, kind, freq) {
	// kind: 'low' (<150Hz) / 'mid' / 'high' (>6kHz)，粗测各频段 RMS
	let y = 0;
	let acc = 0;
	const dt = 1 / 48000;
	const rc = 1 / (2 * Math.PI * freq);
	const a = dt / (rc + dt);
	let lp = 0;
	for (let i = 0; i < x.length; i++) {
		lp += a * (x[i] - lp); // 低通
		if (kind === 'low') y = lp;
		else if (kind === 'high') y = x[i] - lp; // 高通
		else y = x[i];
		acc += y * y;
	}
	return Math.sqrt(acc / x.length);
}

// 包络波动（帧间 RMS 的标准差）：检测 100Hz 帧率调制伪迹
function envelopeFlap(x, frame = 480) {
	const rms = [];
	for (let off = 0; off + frame <= x.length; off += frame) {
		let s = 0;
		for (let i = 0; i < frame; i++) s += x[off + i] * x[off + i];
		rms.push(Math.sqrt(s / frame));
	}
	const mean = rms.reduce((a, b) => a + b) / rms.length;
	const varr = rms.reduce((a, b) => a + (b - mean) ** 2, 0) / rms.length;
	return { mean, flap: Math.sqrt(varr) / (mean || 1e-9) };
}

function gen({ dc = 0, rumble = 0, hiss = 0, voice = 0, seconds = 3 }) {
	const n = 48000 * seconds;
	const x = new Float32Array(n);
	let r1 = 0.3, r2 = -0.7; // 粉噪声近似（两级白噪声低通）
	for (let i = 0; i < n; i++) {
		const t = i / 48000;
		let v = 0;
		v += dc;
		v += rumble * Math.sin(2 * Math.PI * 45 * t); // 空调/风扇隆隆
		if (hiss > 0) {
			const w = Math.random() * 2 - 1;
			r1 = 0.85 * r1 + 0.15 * w; // 低通白噪声 → 咝嘶声底
			v += hiss * r1;
		}
		if (voice > 0) {
			// 类语音：220Hz 基频 + 谐波 + 4Hz 幅度起伏
			const env = 0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t);
			v += voice * env * (Math.sin(2 * Math.PI * 220 * t) + 0.5 * Math.sin(2 * Math.PI * 440 * t) + 0.3 * Math.sin(2 * Math.PI * 660 * t)) * 0.4;
		}
		x[i] = v * 0.5;
	}
	return x;
}

function report(name, input, output) {
	const rows = ['low<150', 'high>6k'].map(() => '');
	console.log(`\n== ${name} ==`);
	console.log('           输入RMS   输出RMS   低频(<150Hz)RMS        高频(>6kHz)RMS       包络抖动');
	for (const [label, x] of [['输入', input], ['输出', output]]) {
		console.log(
			`${label}    ${x === input ? bandEnergy(x).toFixed(4) : ''}`.padEnd(0)
		);
	}
	// 简洁打印
	const fmt = (v) => v.toFixed(4).padStart(8);
	console.log(
		`  全带    in${fmt(bandEnergy(input))}  out${fmt(bandEnergy(output))}`
	);
	console.log(
		`  低频    in${fmt(bandEnergy(input, 'low', 150))}  out${fmt(bandEnergy(output, 'low', 150))}`
	);
	console.log(
		`  高频    in${fmt(bandEnergy(input, 'high', 6000))}  out${fmt(bandEnergy(output, 'high', 6000))}`
	);
	const efI = envelopeFlap(input);
	const efO = envelopeFlap(output);
	console.log(`  帧包络抖动  in ${(efI.flap * 100).toFixed(1)}%  out ${(efO.flap * 100).toFixed(1)}%`);
}

console.log('实例化 RNNoise worklet ...');
const p = makeProcessor();
console.log('ready =', p._ready);

// 场景 1：纯低频隆隆 + 直流（外放桌面震动 / 喷麦）
{
	const input = gen({ dc: 0.08, rumble: 0.35, seconds: 3 });
	const warm = feed(p, gen({ dc: 0.08, rumble: 0.35, seconds: 0.5 })); // 预热模型状态
	void warm;
	const output = feed(p, input);
	report('纯低频隆隆+直流（无语音）', input, output);
}

// 场景 2：低频 + 嘶嘶声 + 类语音
{
	const input = gen({ rumble: 0.3, hiss: 0.12, voice: 0.5, seconds: 3 });
	const output = feed(p, input);
	report('低频隆隆 + 嘶嘶底噪 + 类语音', input, output);
}

// 场景 3：只有类语音（应该基本无损通过）
{
	const input = gen({ voice: 0.5, seconds: 3 });
	const output = feed(p, input);
	report('干净类语音', input, output);
}

// —— 补充：RNNoise 理论强项的客观测量 ——
function gen2({ white = 0, pink = 0, keyboard = 0, voice = 0, seconds = 4 }) {
	const n = 48000 * seconds;
	const x = new Float32Array(n);
	let b0 = 0, b1 = 0, b2 = 0;
	for (let i = 0; i < n; i++) {
		const t = i / 48000;
		let v = 0;
		if (white > 0) v += white * (Math.random() * 2 - 1);
		if (pink > 0) {
			// Paul Kellet 一阶粉噪声
			const w = Math.random() * 2 - 1;
			b0 = 0.99765 * b0 + w * 0.0990460;
			b1 = 0.96300 * b1 + w * 0.2965164;
			b2 = 0.57000 * b2 + w * 1.0526913;
			v += pink * ((b0 + b1 + b2 + w * 0.1848) / 3);
		}
		if (voice > 0) {
			const env = 0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t);
			v += voice * env * (Math.sin(2 * Math.PI * 220 * t) + 0.5 * Math.sin(2 * Math.PI * 440 * t) + 0.3 * Math.sin(2 * Math.PI * 660 * t)) * 0.4;
		}
		x[i] = v * 0.5;
	}
	// 键盘敲击：随机时刻的短衰减脉冲（模拟机械键盘瞬态）
	if (keyboard > 0) {
		let next = 8000;
		while (next < n) {
			const dur = 400;
			for (let i = 0; i < dur && next + i < n; i++) {
				x[next + i] += keyboard * (Math.random() * 2 - 1) * Math.exp(-i / 80);
			}
			next += 15000 + Math.floor(Math.random() * 40000);
		}
	}
	return x;
}

function db(ratio) {
	return ratio > 0 ? (20 * Math.log10(ratio)).toFixed(1) : '-inf';
}

// A：纯稳态宽带粉噪声（无人声）——RNNoise 的看家场景
{
	const input = gen2({ pink: 0.35, seconds: 4 });
	feed(p, gen2({ pink: 0.35, seconds: 1 })); // 预热
	const output = feed(p, input);
	const ri = bandEnergy(input), ro = bandEnergy(output);
	console.log(`\n== A 纯稳态粉噪声（无人声） ==  抑制量 ${db(ri / ro)} dB`);
}

// B：白噪声底 + 类语音——测量语音段与停顿段的残留噪声
{
	const input = gen2({ white: 0.12, voice: 0.55, seconds: 6 });
	const output = feed(p, input);
	// 语音停顿段（包络谷底附近，取 4Hz 调制周期的后半）
	const gaps = [];
	for (let off = 0; off + 4800 <= input.length; off += 4800) {
		let si = 0, so = 0;
		for (let i = 0; i < 4800; i++) {
			si += input[off + i] ** 2;
			so += output[off + i] ** 2;
		}
		gaps.push([Math.sqrt(si / 4800), Math.sqrt(so / 4800)]);
	}
	const inRms = Math.sqrt(gaps.reduce((a, g) => a + g[0] ** 2, 0) / gaps.length);
	const outRms = Math.sqrt(gaps.reduce((a, g) => a + g[1] ** 2, 0) / gaps.length);
	console.log(`\n== B 白噪声+语音（停顿段噪声残留） ==  抑制量 ${db(inRms / outRms)} dB`);
}

// C：键盘敲击 + 语音——瞬态噪声
{
	const input = gen2({ keyboard: 0.6, voice: 0.5, seconds: 6 });
	const output = feed(p, input);
	const ri = bandEnergy(input), ro = bandEnergy(output);
	console.log(`\n== C 键盘瞬态+语音（全带能量比） ==  ${db(ri / ro)} dB（语音同时被削，仅作参考）`);
}
