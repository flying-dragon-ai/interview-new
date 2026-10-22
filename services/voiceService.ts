/**
 * 语音服务（PRD 4.1.5 / 4.1.6 / 附录 G）
 * - 输入：StepFun ASR（SSE 主路径）→ Web Speech API（兜底）→ 纯文字（降级）
 * - 输出：StepFun TTS（WebSocket 流式）→ 浏览器 speechSynthesis（兜底，无 key 可用）→ 纯文字（降级，保底可用）
 * - barge-in v1：用户开始说话/输入即停止当前 AI 播报（TC-04：300ms 内停止）
 * - 所有 StepFun 凭证经 /api/tts-token、/api/asr-token 服务端签发，前端不持 key（C9）
 *
 * 说明：StepFun 事件协议以附录 G 为准实现（tts.text.delta / tts.response.audio.delta /
 * tts.response.subtitle）；任何环节失败自动降级，不阻断群面进行。
 */

export type InputMode = 'stepfun-asr' | 'webspeech' | 'text';
export type OutputMode = 'stepfun-tts' | 'webspeech-tts' | 'text-only';
export interface VoiceCapabilities {
  inputMode: InputMode;
  outputMode: OutputMode;
  hasWebSpeech: boolean;
  hasSpeechSynthesis: boolean;
  hasMediaDevices: boolean;
  isIOS: boolean;
  note?: string;
}

export interface SpeakOptions {
  voiceId: string;
  rate?: number;
  emotion?: string;
  /** LLM 输出的语气指令（F.1 stepfun_tts_instruction） */
  instruction?: string | null;
}

import { arrayBufferToBase64 } from './binary.ts';
import { readSseStream } from './sse.ts';



function detectWebSpeech(): boolean {
  return typeof window !== 'undefined' && Boolean((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
}

function detectMediaDevices(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
}

function detectIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && 'ontouchend' in document);
}

function detectSpeechSynthesis(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof window.speechSynthesis !== 'undefined';
}

function isSecureContextForMedia(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.isSecureContext) return true;
  const host = window.location?.hostname ?? '';
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

export function detectCapabilities(): VoiceCapabilities {
  const hasWebSpeech = detectWebSpeech();
  const hasSpeechSynthesis = detectSpeechSynthesis();
  const hasMediaDevices = detectMediaDevices();
  const isIOS = detectIOS();
  const secure = isSecureContextForMedia();
  let note: string | undefined;
  if (isIOS) {
    note = 'iOS Safari 对 Web Speech API 支持受限，已按降级策略处理';
  } else if (!hasMediaDevices && !hasWebSpeech) {
    note = secure
      ? '当前浏览器不支持语音识别（Web Speech API），语音输入不可用；可换 Chrome/Edge'
      : '当前页面为非安全上下文（非 localhost/HTTPS），麦克风与语音识别被浏览器禁用；请改用 localhost 或 HTTPS 访问';
  }
  return {
    // iOS Safari 不支持 Web Speech → 纯文字（PRD 2.3：语音输入降级提示）
    inputMode: hasMediaDevices ? 'stepfun-asr' : hasWebSpeech ? 'webspeech' : 'text',
    // 输出三级：StepFun TTS → 浏览器 speechSynthesis（无 key 兜底）→ 纯文字
    outputMode: hasMediaDevices ? 'stepfun-tts' : hasSpeechSynthesis ? 'webspeech-tts' : 'text-only',
    hasWebSpeech,
    hasSpeechSynthesis,
    hasMediaDevices,
    isIOS,
    note,
  };
}
export class VoiceService {
  private caps: VoiceCapabilities;
  private inputMode: InputMode;
  private outputMode: OutputMode;

  // Web Speech 兜底
  private recognition: any = null;
  private listening = false;

  // StepFun ASR 录音
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private asrFormat: Record<string, unknown> = {};
  private mediaStream: MediaStream | null = null;

  // StepFun TTS 播放
  // StepFun TTS 播放（/api/tts 代理 SSE 流）
  private ttsReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private audioCtx: AudioContext | null = null;
  private audioQueue: AudioBufferSourceNode[] = [];
  private nextStartTime = 0;
  /** M7 P3：播放分析器（口型/灯光律动；懒创建，插入播放链 source → analyser → destination） */
  private playbackAnalyser: AnalyserNode | null = null;
  // Web Speech TTS 兜底
  private utterance: SpeechSynthesisUtterance | null = null;
  private speaking = false;
  private speakingListeners = new Set<(speaking: boolean) => void>();

  // 当前 ASR 回调
  private asrOnPartial: ((text: string) => void) | null = null;
  private asrOnFinal: ((text: string) => void) | null = null;

  constructor(overrides?: Partial<Pick<VoiceCapabilities, 'inputMode' | 'outputMode'>>) {
    this.caps = detectCapabilities();
    // 测试/特殊场景可强制指定模式（如无浏览器环境下验证 TTS 协议）
    if (overrides?.inputMode) this.caps.inputMode = overrides.inputMode;
    if (overrides?.outputMode) this.caps.outputMode = overrides.outputMode;
    this.inputMode = this.caps.inputMode;
    this.outputMode = this.caps.outputMode;
  }

  getCapabilities(): VoiceCapabilities {
    return this.caps;
  }

  /** 初始化：探测 StepFun 凭证可用性，不可用则降级 */
  async init(): Promise<VoiceCapabilities> {
    // ASR 凭证探测
    if (this.inputMode === 'stepfun-asr') {
      try {
        const res = await fetch('/api/asr-token', { method: 'POST' });
        if (!res.ok) {
          this.setInputMode(this.caps.hasWebSpeech ? 'webspeech' : 'text');
        }
      } catch {
        this.setInputMode(this.caps.hasWebSpeech ? 'webspeech' : 'text');
      }
    }
    // TTS 凭证探测
    if (this.outputMode === 'stepfun-tts') {
      try {
        const res = await fetch('/api/tts-token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        if (!res.ok) {
          this.setOutputMode(this.caps.hasSpeechSynthesis ? 'webspeech-tts' : 'text-only');
        }
      } catch {
        this.setOutputMode(this.caps.hasSpeechSynthesis ? 'webspeech-tts' : 'text-only');
      }
    }
    this.caps = { ...this.caps, inputMode: this.inputMode, outputMode: this.outputMode };
    return this.caps;
  }

  private setInputMode(mode: InputMode) {
    this.inputMode = mode;
    this.caps = { ...this.caps, inputMode: mode };
  }

  private setOutputMode(mode: OutputMode) {
    this.outputMode = mode;
    this.caps = { ...this.caps, outputMode: mode };
  }

  onSpeakingChange(cb: (speaking: boolean) => void): () => void {
    this.speakingListeners.add(cb);
    return () => this.speakingListeners.delete(cb);
  }

  private setSpeaking(v: boolean) {
    if (this.speaking === v) return;
    this.speaking = v;
    this.speakingListeners.forEach((cb) => cb(v));
  }

  isSpeaking(): boolean {
    return this.speaking;
  }

  // ==================== 语音输入 ====================

  /** 开始语音识别（主路径 StepFun ASR；兜底 Web Speech） */
  async startAsr(onPartial: (text: string) => void, onFinal: (text: string) => void): Promise<void> {
    this.asrOnPartial = onPartial;
    this.asrOnFinal = onFinal;

    if (this.inputMode === 'webspeech') {
      this.startWebSpeech(onPartial, onFinal);
      return;
    }
    if (this.inputMode === 'text') {
      return; // 纯文字模式：无 ASR
    }
    // StepFun ASR：先录音，停止时一次性提交
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.audioChunks = [];
      // 容器选择：优先 ogg/opus（StepFun 原生支持）；webm 时 format 置空由上游嗅探
      const candidates = ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/webm'];
      let mime = '';
      if (typeof MediaRecorder.isTypeSupported === 'function') {
        mime = candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
      }
      this.mediaRecorder = mime ? new MediaRecorder(this.mediaStream, { mimeType: mime }) : new MediaRecorder(this.mediaStream);
      const chosen = this.mediaRecorder.mimeType || mime;
      this.asrFormat = chosen.includes('ogg') ? { type: 'ogg' } : {};
      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) this.audioChunks.push(e.data);
      };
      this.mediaRecorder.start(250);
    } catch {
      // 无麦克风权限 → 降级
      const degradedMode: InputMode = this.caps.hasWebSpeech ? 'webspeech' : 'text';
      this.setInputMode(degradedMode);
      if (degradedMode === 'webspeech') this.startWebSpeech(onPartial, onFinal);
    }
  }

  /** 停止语音识别；StepFun 路径在此提交音频并返回最终转写 */
  async stopAsr(): Promise<string> {
    if (this.inputMode === 'webspeech' && this.recognition) {
      this.recognition.stop();
      return '';
    }
    if (this.inputMode !== 'stepfun-asr' || !this.mediaRecorder) return '';

    const blob = await new Promise<Blob>((resolve) => {
      const recorder = this.mediaRecorder!;
      recorder.onstop = () => resolve(new Blob(this.audioChunks, { type: recorder.mimeType || 'audio/webm' }));
      if (recorder.state !== 'inactive') recorder.stop();
      else resolve(new Blob(this.audioChunks));
    });
    this.mediaStream?.getTracks().forEach((t) => t.stop());
    this.mediaStream = null;
    this.mediaRecorder = null;

    try {
      return await this.submitAsr(blob);
    } catch (err) {
      console.error('StepFun ASR 失败，降级为文字输入:', err);
      return '';
    }
  }

  private async submitAsr(blob: Blob): Promise<string> {
    // /api/asr 服务端代理（C9：前端不持 key）：base64 音频 → SSE 增量/最终转写
    const base64 = arrayBufferToBase64(await blob.arrayBuffer());
    const res = await fetch('/api/asr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio: base64, format: this.asrFormat }),
    });
    if (!res.ok || !res.body) throw new Error(`ASR 代理失败: ${res.status}`);

    let finalText = '';
    let acc = '';
    await readSseStream(res.body, (event, data) => {
      if (event === 'delta' && typeof data.delta === 'string') {
        acc += data.delta;
        this.asrOnPartial?.(acc);
      } else if (event === 'done' && typeof data.text === 'string') {
        finalText = data.text;
      } else if (event === 'error') {
        throw new Error(String(data.message ?? 'ASR 上游错误'));
      }
    });
    this.asrOnFinal?.(finalText);
    return finalText;
  }

  private startWebSpeech(onPartial: (text: string) => void, onFinal: (text: string) => void): void {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return;
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'zh-CN';
    recognition.onresult = (event: any) => {
      let finalText = '';
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) finalText += event.results[i][0].transcript;
      }
      if (finalText) onFinal(finalText);
      else {
        const interim = event.results[event.results.length - 1]?.[0]?.transcript;
        if (interim) onPartial(interim);
      }
    };
    recognition.onerror = () => {
      this.listening = false;
    };
    recognition.onend = () => {
      this.listening = false;
    };
    try {
      recognition.start();
      this.listening = true;
      this.recognition = recognition;
    } catch {
      this.listening = false;
    }
  }

  isListening(): boolean {
    return this.listening;
  }

  // ==================== 语音输出（TTS） ====================

  /** 播放 AI 发言（流式 TTS）；text-only 模式为 no-op（界面已展示文字） */
  async speak(text: string, opts: SpeakOptions): Promise<void> {
    if (!text) return;
    if (this.outputMode === 'webspeech-tts') {
      return this.speakWebSpeechTts(text, opts);
    }
    if (this.outputMode !== 'stepfun-tts') return;

    // barge-in：停止上一段
    this.stopPlayback();
    try {
      this.audioCtx = this.audioCtx ?? new AudioContext();
      if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();
      this.nextStartTime = this.audioCtx.currentTime;

      // /api/tts 服务端代理（C9：前端不持 key）：PCM 24kHz s16le base64 SSE 流
      const res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          voice_id: opts.voiceId,
          rate: opts.rate ?? 1,
          ...(opts.instruction ? { instruction: opts.instruction } : {}),
        }),
      });
      if (!res.ok || !res.body) throw new Error(`TTS 代理失败: ${res.status}`);

      const reader = res.body.getReader();
      this.ttsReader = reader;
      this.setSpeaking(true);
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split('\n\n');
          buffer = blocks.pop() ?? '';
          for (const block of blocks) {
            const event = block.match(/^event: (.+)$/m)?.[1] ?? 'message';
            const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
            if (!dataLine) continue;
            let data: { audio?: string; message?: string };
            try {
              data = JSON.parse(dataLine.slice(6));
            } catch {
              continue; // 忽略单条解析失败
            }
            if (event === 'delta' && typeof data.audio === 'string' && data.audio) {
              this.enqueuePcm16(data.audio);
            } else if (event === 'error') {
              throw new Error(String(data.message ?? 'TTS 上游错误'));
            }
          }
        }
      } finally {
        if (this.ttsReader === reader) this.ttsReader = null;
        reader.releaseLock();
      }
    } catch (err) {
      console.error('StepFun TTS 失败，降级浏览器语音/文字播报:', err);
      this.setOutputMode(this.caps.hasSpeechSynthesis ? 'webspeech-tts' : 'text-only');
    } finally {
      // 等音频队列播完再置闲（barge-in 会立即清空队列 → 立即返回）；
      // speak() 因此在「播完」而非「流读完」时 resolve，调度器据此串行化发言
      await this.waitForQueueDrain();
      this.setSpeaking(false);
    }
  }


  /** 等待播放队列排空（100ms 轮询；barge-in 清空后立即返回） */
  private waitForQueueDrain(): Promise<void> {
    return new Promise((resolve) => {
      const poll = () => {
        if (this.audioQueue.length === 0) return resolve();
        setTimeout(poll, 100);
      };
      poll();
    });
  }
  /** PCM16 base64 入队播放（假设 24kHz 单声道，附录 G 流式音频） */
  private enqueuePcm16(base64: string): void {
    if (!this.audioCtx) return;
    try {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const samples = new Int16Array(bytes.buffer);
      const buffer = this.audioCtx.createBuffer(1, samples.length, 24000);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 32768;
      const source = this.audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.playbackAnalyser ?? this.audioCtx.destination);
      const startAt = Math.max(this.audioCtx.currentTime, this.nextStartTime);
      source.start(startAt);
      this.nextStartTime = startAt + buffer.duration;
      source.onended = () => {
        this.audioQueue = this.audioQueue.filter((s) => s !== source);
      };
      this.audioQueue.push(source);
    } catch (err) {
      console.error('PCM 解码失败:', err);
    }
  }

  /** Web Speech TTS 兜底播报（无 key 可用；barge-in 经 speechSynthesis.cancel 即时生效） */
  private speakWebSpeechTts(text: string, opts: SpeakOptions): Promise<void> {
    return new Promise((resolve) => {
      const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
      if (!synth) return resolve();
      this.stopPlayback();

      // Chrome 单句过长会被静默截断：按句切分逐段排队
      const chunks = text.match(/[^。！？；\n]+[。！？；\n]?/g)?.filter((c) => c.trim()) ?? [text];
      const rate = Math.min(2, Math.max(0.5, opts.rate ?? 1));
      // 角色音色差异化：浏览器不保证多音色，用 voiceId 哈希映射音高（同卡恒定）
      let hash = 0;
      for (let i = 0; i < opts.voiceId.length; i++) hash = (hash * 31 + opts.voiceId.charCodeAt(i)) >>> 0;
      const pitch = 0.6 + (hash % 80) / 100; // 0.6 - 1.4

      let index = 0;
      const speakNext = () => {
        if (index >= chunks.length) {
          this.utterance = null;
          this.setSpeaking(false);
          resolve();
          return;
        }
        const utter = new SpeechSynthesisUtterance(chunks[index++]);
        utter.lang = 'zh-CN';
        utter.rate = rate;
        utter.pitch = pitch;
        this.utterance = utter;
        if (index === 1) utter.onstart = () => this.setSpeaking(true);
        utter.onend = () => speakNext();
        utter.onerror = () => speakNext(); // 单句失败不阻塞后续
        synth.speak(utter);
      };
      speakNext();
    });
  }

  /** barge-in v1：立即停止播报（TC-04：300ms 内停止） */
  bargeIn(): void {
    this.stopPlayback();
  }

  /**
   * M7 P3：TTS 播放分析器（口型/灯光律动用）。
   * 懒创建并接入播放链（source → analyser → destination）；不改动既有播放路径与公开 API。
   */
  getPlaybackAnalyser(): AnalyserNode | null {
    if (typeof window === 'undefined') return null;
    try {
      this.audioCtx = this.audioCtx ?? new AudioContext();
      if (!this.playbackAnalyser) {
        this.playbackAnalyser = this.audioCtx.createAnalyser();
        this.playbackAnalyser.fftSize = 1024;
        this.playbackAnalyser.connect(this.audioCtx.destination);
      }
      return this.playbackAnalyser;
    } catch {
      return null;
    }
  }

  private stopPlayback(): void {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // 忽略
      }
    }
    this.utterance = null;
    this.audioQueue.forEach((s) => {
      try {
        s.stop();
      } catch {
        // 忽略
      }
    });
    this.audioQueue = [];
    if (this.ttsReader) {
      try {
        this.ttsReader.cancel().catch(() => undefined);
      } catch {
        // 忽略
      }
      this.ttsReader = null;
    }
    this.setSpeaking(false);
  }

  /** 释放资源 */
  dispose(): void {
    this.stopPlayback();
    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch {
        // 忽略
      }
    }
    this.mediaStream?.getTracks().forEach((t) => t.stop());
    this.audioCtx?.close().catch(() => undefined);
  }
}
