/**
 * 语音服务（PRD 4.1.5 / 4.1.6 / 附录 G）
 * - 输入：StepFun ASR（SSE 主路径）→ Web Speech API（兜底）→ 纯文字（降级）
 * - 输出：StepFun TTS（WebSocket 流式）→ 纯文字播报（降级，保底可用）
 * - barge-in v1：用户开始说话/输入即停止当前 AI 播报（TC-04：300ms 内停止）
 * - 所有 StepFun 凭证经 /api/tts-token、/api/asr-token 服务端签发，前端不持 key（C9）
 *
 * 说明：StepFun 事件协议以附录 G 为准实现（tts.text.delta / tts.response.audio.delta /
 * tts.response.subtitle）；任何环节失败自动降级，不阻断群面进行。
 */

export type InputMode = 'stepfun-asr' | 'webspeech' | 'text';
export type OutputMode = 'stepfun-tts' | 'text-only';

export interface VoiceCapabilities {
  inputMode: InputMode;
  outputMode: OutputMode;
  hasWebSpeech: boolean;
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

interface TtsTokenResponse {
  token: string;
  endpoint: string;
  model: string;
  expires_in: number;
  fallback_models?: string[];
}

interface AsrTokenResponse {
  token: string;
  endpoint: string;
  model: string;
  expires_in: number;
}

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

export function detectCapabilities(): VoiceCapabilities {
  const hasWebSpeech = detectWebSpeech();
  const hasMediaDevices = detectMediaDevices();
  const isIOS = detectIOS();
  return {
    // iOS Safari 不支持 Web Speech → 纯文字（PRD 2.3：语音输入降级提示）
    inputMode: hasMediaDevices ? 'stepfun-asr' : hasWebSpeech ? 'webspeech' : 'text',
    outputMode: hasMediaDevices ? 'stepfun-tts' : 'text-only',
    hasWebSpeech,
    hasMediaDevices,
    isIOS,
    note: isIOS ? 'iOS Safari 对 Web Speech API 支持受限，已按降级策略处理' : undefined,
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
  private mediaStream: MediaStream | null = null;

  // StepFun TTS 播放
  private ttsWs: WebSocket | null = null;
  private audioCtx: AudioContext | null = null;
  private audioQueue: AudioBufferSourceNode[] = [];
  private nextStartTime = 0;
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
          this.setOutputMode('text-only');
        }
      } catch {
        this.setOutputMode('text-only');
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
      this.mediaRecorder = new MediaRecorder(this.mediaStream);
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
    const tokenRes = await fetch('/api/asr-token', { method: 'POST' });
    if (!tokenRes.ok) throw new Error('ASR token 签发失败');
    const { token, endpoint, model } = (await tokenRes.json()) as AsrTokenResponse;

    const res = await fetch(`${endpoint}?model=${encodeURIComponent(model)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': blob.type || 'audio/webm',
      },
      body: blob,
    });
    if (!res.ok || !res.body) throw new Error(`ASR 请求失败: ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalText = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;
        try {
          const data = JSON.parse(dataLine.slice(6));
          const text = data.text ?? data.transcript ?? data.result;
          if (typeof text === 'string' && text) {
            finalText = text;
            this.asrOnPartial?.(text);
          }
        } catch {
          // 忽略
        }
      }
    }
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
    if (this.outputMode !== 'stepfun-tts' || !text) return;

    // barge-in：停止上一段
    this.stopPlayback();

    try {
      const tokenRes = await fetch('/api/tts-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice_id: opts.voiceId }),
      });
      if (!tokenRes.ok) throw new Error('TTS token 签发失败');
      const { token, endpoint, model } = (await tokenRes.json()) as TtsTokenResponse;

      this.audioCtx = this.audioCtx ?? new AudioContext();
      if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();
      this.nextStartTime = this.audioCtx.currentTime;

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(endpoint);
        this.ttsWs = ws;
        let settled = false;
        let safetyTimer: ReturnType<typeof setTimeout> | null = null;
        const finish = (err?: unknown) => {
          if (settled) return;
          settled = true;
          if (safetyTimer) clearTimeout(safetyTimer);
          this.ttsWs = null;
          err ? reject(err) : resolve();
        };

        ws.onopen = () => {
          // 会话配置 + 文本增量（边发边合成）
          ws.send(JSON.stringify({ type: 'session.update', model, voice: opts.voiceId, rate: opts.rate ?? 1 }));
          ws.send(
            JSON.stringify({
              type: 'tts.text.delta',
              text,
              ...(opts.instruction ? { instruction: opts.instruction } : {}),
            })
          );
          ws.send(JSON.stringify({ type: 'tts.text.done' }));
          this.setSpeaking(true);
        };
        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data as string);
            const type = data.type ?? data.event;
            if (type === 'tts.response.audio.delta' || type === 'response.audio.delta') {
              const b64 = data.audio ?? data.delta ?? data.audio_delta;
              if (typeof b64 === 'string') this.enqueuePcm16(b64);
            } else if (type === 'tts.response.done' || type === 'response.done' || type === 'tts.done') {
              finish();
            } else if (type === 'error') {
              finish(new Error(String(data.message ?? 'TTS error')));
            }
          } catch {
            // 忽略非 JSON 帧
          }
        };
        ws.onerror = () => finish(new Error('TTS WebSocket 错误'));
        ws.onclose = () => finish();
        // 安全超时：异常协议下不卡住流程（finish 时清除，避免定时器泄漏）
        safetyTimer = setTimeout(() => finish(), Math.max(15_000, text.length * 300));
      });
    } catch (err) {
      console.error('StepFun TTS 失败，降级文字播报:', err);
      this.setOutputMode('text-only');
    } finally {
      // 等音频队列播完再置闲（barge-in 会立即清空）
      const waitDrain = () => {
        if (this.audioQueue.length === 0) {
          this.setSpeaking(false);
          return;
        }
        setTimeout(waitDrain, 100);
      };
      setTimeout(waitDrain, 150);
    }
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
      source.connect(this.audioCtx.destination);
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

  /** barge-in v1：立即停止播报（TC-04：300ms 内停止） */
  bargeIn(): void {
    this.stopPlayback();
  }

  private stopPlayback(): void {
    this.audioQueue.forEach((s) => {
      try {
        s.stop();
      } catch {
        // 忽略
      }
    });
    this.audioQueue = [];
    if (this.ttsWs) {
      try {
        this.ttsWs.close();
      } catch {
        // 忽略
      }
      this.ttsWs = null;
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
