/**
 * LipSyncService —— 频谱 → viseme 口型权重（M7 P3-3 / D3）
 * - AnalyserNode(fftSize 1024) → 5 个频段能量 → 映射 aa/ih/ou/ee/oh + jawOpen
 * - 包络：attack 30ms / release 120ms；静音期权重归零
 * - 预留 setTimingSource()：后续 StepFun TTS 词级时间戳（tts.response.subtitle）可用时
 *   切成时间戳驱动（D3 升级点），接口不变
 */

export interface VisemeFrame {
  aa: number;
  ih: number;
  ou: number;
  ee: number;
  oh: number;
  jawOpen: number;
}

/** 频谱分析器最小接口（AnalyserNode 共形；测试注入 fake） */
export interface SpectrumSource {
  fftSize: number;
  frequencyBinCount: number;
  context: { sampleRate: number };
  getByteFrequencyData(array: Uint8Array): void;
  getByteTimeDomainData(array: Uint8Array): void;
}

const ATTACK_MS = 30;
const RELEASE_MS = 120;
/**
 * 收敛吸附阈值：目标为零（静音/静止）且衰减到此值以下 → 直接归零。
 * 指数衰减是渐近线，不吸附会残留 1e-2 级权重导致 UI 静止态不确定
 * （测试要求恢复后精确收敛为零）。
 */
const RELEASE_SNAP = 0.02;
/** 静音门限（时域 RMS 低于此值 → 全部权重归零） */
const SILENCE_RMS = 0.015;

/** 频段（Hz）：按元音共振峰粗分——oh/ou 低，aa 低中，ih 中高，ee 高 */
interface Band {
  from: number;
  to: number;
}
const BANDS: Record<'oh' | 'ou' | 'aa' | 'ih' | 'ee', Band> = {
  oh: { from: 150, to: 400 },
  ou: { from: 300, to: 600 },
  aa: { from: 500, to: 1100 },
  ih: { from: 1100, to: 2400 },
  ee: { from: 2400, to: 4800 },
};

export class LipSyncService {
  private readonly analyser: SpectrumSource;
  private readonly freq: Uint8Array;
  private readonly time: Uint8Array;
  private current: VisemeFrame = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0, jawOpen: 0 };
  /** 时间戳驱动源（D3 升级项）；设置后 update 直接返回其输出 */
  private timingSource: null | ((t: number) => VisemeFrame) = null;

  constructor(analyser: SpectrumSource) {
    this.analyser = analyser;
    this.freq = new Uint8Array(analyser.frequencyBinCount);
    this.time = new Uint8Array(analyser.fftSize);
  }

  /** 切换到词级时间戳驱动（传 null 恢复频谱驱动） */
  setTimingSource(src: null | ((t: number) => VisemeFrame)): void {
    this.timingSource = src;
  }

  /** 每帧调用；dtMs 为距上次调用的毫秒数 */
  update(dtMs: number): VisemeFrame {
    if (this.timingSource) {
      this.current = this.clampFrame(this.timingSource(dtMs));
      return this.current;
    }
    const target = this.readTarget();
    this.current = this.envelope(this.current, target, dtMs);
    return this.current;
  }

  /** 从频谱读目标权重（0..1，静音全零） */
  private readTarget(): VisemeFrame {
    // 时域 RMS（静音判定）
    this.analyser.getByteTimeDomainData(this.time);
    let sum = 0;
    for (let i = 0; i < this.time.length; i++) {
      const v = (this.time[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.time.length);
    if (rms < SILENCE_RMS) return { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0, jawOpen: 0 };

    // 频域分带能量（byte 0..255 → 0..1）
    this.analyser.getByteFrequencyData(this.freq);
    const hzPerBin = this.analyser.context.sampleRate / 2 / this.analyser.frequencyBinCount;
    const bandEnergy = (b: Band): number => {
      const from = Math.max(0, Math.floor(b.from / hzPerBin));
      const to = Math.min(this.freq.length - 1, Math.ceil(b.to / hzPerBin));
      if (to <= from) return 0;
      let acc = 0;
      for (let i = from; i <= to; i++) acc += this.freq[i];
      return acc / ((to - from + 1) * 255);
    };
    const e = {
      oh: bandEnergy(BANDS.oh),
      ou: bandEnergy(BANDS.ou),
      aa: bandEnergy(BANDS.aa),
      ih: bandEnergy(BANDS.ih),
      ee: bandEnergy(BANDS.ee),
    };
    // 语音频谱低频天然占优：按带做增益补偿后取主导映射
    const total = e.oh + e.ou + e.aa + e.ih + e.ee || 1;
    const jawOpen = Math.min(1, rms * 6);
    return {
      oh: Math.min(1, (e.oh / total) * 2.2 * jawOpen * 2),
      ou: Math.min(1, (e.ou / total) * 2.2 * jawOpen * 2),
      aa: Math.min(1, (e.aa / total) * 2.2 * jawOpen * 2),
      ih: Math.min(1, (e.ih / total) * 2.6 * jawOpen * 2),
      ee: Math.min(1, (e.ee / total) * 2.6 * jawOpen * 2),
      jawOpen,
    };
  }

  /** attack/release 包络（帧率无关） */
  private envelope(prev: VisemeFrame, target: VisemeFrame, dtMs: number): VisemeFrame {
    const step = (p: number, t: number): number => {
      const tau = t > p ? ATTACK_MS : RELEASE_MS;
      const k = 1 - Math.exp(-Math.max(0, dtMs) / tau);
      const v = p + (t - p) * k;
      const clamped = Math.max(0, Math.min(1, v));
      // 目标为零且已衰减到阈值以下 → 吸附到精确 0（静止态确定性）
      if (t === 0 && clamped < RELEASE_SNAP) return 0;
      return clamped;
    };
    return {
      aa: step(prev.aa, target.aa),
      ih: step(prev.ih, target.ih),
      ou: step(prev.ou, target.ou),
      ee: step(prev.ee, target.ee),
      oh: step(prev.oh, target.oh),
      jawOpen: step(prev.jawOpen, target.jawOpen),
    };
  }

  private clampFrame(f: VisemeFrame): VisemeFrame {
    const c = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
    return { aa: c(f.aa), ih: c(f.ih), ou: c(f.ou), ee: c(f.ee), oh: c(f.oh), jawOpen: c(f.jawOpen) };
  }
}
