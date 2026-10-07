// RNNoise AudioWorklet 处理器（与 rnnoise-sync.js 拼接为一个 worklet 文件加载）。
// RNNoise 要求 48kHz 单声道、每帧 480 样本（10ms）；AudioWorklet 的量子是 128，
// 所以这里做输入累积 → 满帧进 wasm 处理 → 输出 FIFO 按序排出的三段缓冲。
class RnnoiseProcessor extends AudioWorkletProcessor {
	constructor(options) {
		super(options);
		this._frameSize = 480;
		this._ready = false;
		this._inBuf = new Float32Array(480);
		this._inPos = 0;
		this._fifo = new Float32Array(960);
		this._r = 0;
		this._w = 0;
		this._count = 0;
		this._m = null;
		this._state = null;
		this._inPtr = 0;
		this._outPtr = 0;
		// 直流/次声阻断（参考原版 denoise.c 喂模型前的高通）：
		// 麦克风直流偏移与超低频隆隆会让 RNNoise 的低频增益在帧间抖动，
		// 产生约 100Hz（帧率）的调制嗡嗡声。泄漏微分器，截止约 38Hz
		this._hpX = 0;
		this._hpY = 0;
		try {
			// 注意：同步版工厂直接返回 Module 对象（非 Promise），
			// wasm 以 base64 内联，此处同步实例化即可
			this._m = createRNNWasmModuleSync();
			this._state = this._m._rnnoise_create();
			this._m._rnnoise_init(this._state);
			this._inPtr = this._m._malloc(480 * 4);
			this._outPtr = this._m._malloc(480 * 4);
			this._ready = true;
			this.port.postMessage({ type: 'ready' });
		} catch (e) {
			this.port.postMessage({ type: 'error', error: String(e) });
		}
	}

	_fifoPush(x) {
		this._fifo[this._w] = x;
		this._w = (this._w + 1) % 960;
		this._count++;
	}

	_fifoPop() {
		if (this._count === 0) return 0;
		const v = this._fifo[this._r];
		this._r = (this._r + 1) % 960;
		this._count--;
		return v;
	}

	process(inputs, outputs) {
		const output = outputs[0] && outputs[0][0];
		const input = inputs[0] && inputs[0][0];
		if (!output) return true;

		if (!this._ready || !input) {
			// 模型加载完成前直通输入，保证音频流不中断
			if (input) output.set(input);
			else output.fill(0);
			return true;
		}

		for (let i = 0; i < input.length; i++) {
			const s = input[i];
			const hp = s - this._hpX + 0.995 * this._hpY;
			this._hpX = s;
			this._hpY = hp;
			// 关键：RNNoise 模型按 16 位 PCM 尺度（±32768）训练，
			// 喂 ±1 浮点会被当成数字静音（VAD 恒 0、不做任何抑制）。
			// 进模型前 ×32768，出模型后 ÷32768 还原
			this._inBuf[this._inPos++] = hp * 32768;
			if (this._inPos === 480) {
				this._inPos = 0;
				this._m.HEAPF32.set(this._inBuf, this._inPtr >> 2);
				this._m._rnnoise_process_frame(this._state, this._outPtr, this._inPtr);
				const processed = this._m.HEAPF32.subarray(this._outPtr >> 2, (this._outPtr >> 2) + 480);
				for (let j = 0; j < 480; j++) this._fifoPush(processed[j] / 32768);
			}
			// 每个输入样本对应弹出一个已处理样本；稳态时 FIFO 恒有货，
			// 仅最初的 10ms（一帧）为空，输出 0 作为处理延迟
			output[i] = this._fifoPop();
		}
		return true;
	}
}

registerProcessor('rnnoise', RnnoiseProcessor);
