// 音频采集调校：浏览器 DSP 开关 + 音乐模式。
// 这些参数在麦克风轨道创建/重启时生效（见 VoiceRoom.applyTuning）。

export interface AudioTuning {
	echoCancellation: boolean; // 回声消除（外放扬声器必开，耳机可关）
	noiseSuppression: boolean; // 浏览器内置噪声抑制（对稳态噪声有效）
	autoGainControl: boolean; // 自动增益（自动调音量，有人嫌忽大忽小可关）
	voiceIsolation: boolean; // 人声隔离（Chrome 实验特性，比 NS 强；开启时忽略 NS）
	aiDenoise: boolean; // RNNoise 人声提取：滤掉键盘声等突发噪声（AudioWorklet，耗少量 CPU）
	micGain: number; // 麦克风输入增益（0-200%，敏感麦调低防炸、哑麦调高）
	compressor: boolean; // 压限器：削掉瞬间峰值防"炸"
	musicMode: boolean; // 音乐模式：关闭所有 DSP + 高音质立体声编码（放歌/乐器用）
	lowCut: boolean; // 低切：滤掉低频杂音（桌面震动、空调嗡嗡、喷麦气流）
	hissCut: boolean; // 嘶声抑制：压低高频嘶嘶声（电流声、话筒底噪）
}

export const defaultTuning: AudioTuning = {
	echoCancellation: true,
	noiseSuppression: true,
	autoGainControl: true,
	voiceIsolation: false,
	aiDenoise: true,
	micGain: 100,
	compressor: true,
	musicMode: false,
	lowCut: true,
	hissCut: true
};

const KEY = 'echo:audio-tuning';

export function loadTuning(): AudioTuning {
	try {
		const raw = localStorage.getItem(KEY);
		if (raw) {
			const parsed = { ...defaultTuning, ...JSON.parse(raw) };
			// 音乐模式只在当前会话生效：防止上次忘了退出，这次上线"没降噪"找不着原因
			parsed.musicMode = false;
			return parsed;
		}
	} catch {
		/* 解析失败就用默认值 */
	}
	return { ...defaultTuning };
}

export function saveTuning(t: AudioTuning) {
	try {
		localStorage.setItem(KEY, JSON.stringify(t));
	} catch {
		/* 写不进就算了 */
	}
}

// 采集约束（captureOptionsOf）与发布参数（publishOptionsOf）在 voice-processor.ts 里：
// 这里曾有一份重复的 captureOptionsOf 死代码，改它会以为生效实则不被导入——已删除防再踩坑。
