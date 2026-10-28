/**
 * RealtimePlayback —— StepFun Realtime AI 侧音频播放（全面切换实时对话 M8）
 * - 消费 response.audio.delta 的 base64 pcm16 分片，平滑排队播放
 * - barge-in：stop() 立即清空队列（TC-04 ≤300ms 停声）
 * - 播放链 source → analyser → destination（口型/灯光律动复用 M7 P3 通道）
 * - Node 测试环境（无 AudioContext）优雅 no-op
 */

/** 默认输出采样率：StepFun Realtime 输出 pcm16，文档未标注采样率；按 TTS 惯例 24kHz，实测不符只改这里 */
export const REALTIME_OUTPUT_SAMPLE_RATE = 24000;

export class RealtimePlayback {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private queue: AudioBufferSourceNode[] = [];
  private nextStartTime = 0;
  private _playing = false;
  /** 播放自然结束的回调（队列排空时触发一次）——上层据此收敛 speakingCharId / 打断窗口 */
  private onDrain: (() => void) | null = null;
  private readonly sampleRate: number;

  constructor(sampleRate: number = REALTIME_OUTPUT_SAMPLE_RATE, onDrain?: (() => void) | null) {
    this.sampleRate = sampleRate;
    this.onDrain = onDrain ?? null;
  }

  /** 替换播放结束回调 */
  setOnDrain(cb: (() => void) | null): void {
    this.onDrain = cb;
  }

  /** 是否仍有未播完的音频（驱动 speakingCharId 与调度等待） */
  get playing(): boolean {
    return this._playing;
  }

  /** PCM16 base64 分片入队（解码失败静默丢弃，不中断流） */
  enqueue(base64: string): void {
    const ctx = this.ensureCtx();
    if (!ctx) return;
    try {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const samples = new Int16Array(bytes.buffer);
      if (samples.length === 0) return;
      const buffer = ctx.createBuffer(1, samples.length, this.sampleRate);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 32768;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.onended = () => {
        this.queue = this.queue.filter((s) => s !== source);
        if (this.queue.length === 0) {
          this._playing = false;
          // 队列排空 = 播报自然结束：必须通知上层，否则 speakingCharId / 打断窗口永远挂着
          this.onDrain?.();
        }
      };
      const analyser = this.ensureAnalyser(ctx);
      source.connect(analyser ?? ctx.destination);
      const startAt = Math.max(ctx.currentTime, this.nextStartTime);
      source.start(startAt);
      this.nextStartTime = startAt + buffer.duration;
      this.queue.push(source);
      this._playing = true;
    } catch (err) {
      console.error('Realtime PCM 解码失败:', err);
    }
  }

  /** barge-in：立即停止全部播放（TC-04） */
  stop(): void {
    this.queue.forEach((s) => {
      try {
        s.stop();
      } catch {
        // 忽略
      }
    });
    this.queue = [];
    this.nextStartTime = 0;
    this._playing = false;
  }

  /** 播放分析器（口型/灯光律动；与 VoiceService.getPlaybackAnalyser 同型） */
  getPlaybackAnalyser(): AnalyserNode | null {
    const ctx = this.ensureCtx();
    return ctx ? this.analyser : null;
  }

  dispose(): void {
    this.stop();
    if (this.ctx) {
      void this.ctx.close().catch(() => undefined);
      this.ctx = null;
      this.analyser = null;
    }
  }

  private ensureCtx(): AudioContext | null {
    if (this.ctx) return this.ctx;
    if (typeof window === 'undefined') return null;
    const w = window as unknown as { AudioContext?: new () => AudioContext; webkitAudioContext?: new () => AudioContext };
    const Ctor = w.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) return null;
    try {
      this.ctx = new Ctor();
      if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
      return this.ctx;
    } catch {
      return null;
    }
  }

  private ensureAnalyser(ctx: AudioContext): AnalyserNode | null {
    if (this.analyser) return this.analyser;
    try {
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.connect(ctx.destination);
      return this.analyser;
    } catch {
      return null;
    }
  }
}
