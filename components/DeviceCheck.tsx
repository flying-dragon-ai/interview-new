import React, { useState, useEffect, useRef } from 'react';

/**
 * 设备检测与准备流程（PRD 4.1.2 / US-01 / 5.2）
 * 依次检测：麦克风（权限 + 输入音量）→ 摄像头（权限 + 画面预览）→ 扬声器 → 网络。
 * 移动端额外：前后摄像头切换、横竖屏提示、省电模式提示、移动网络提示。
 * 「跳过摄像头」→ 纯语音模式可进入。隐私同意（C4）后才保存转写与聚合特征。
 */

export interface DeviceCheckResult {
  cameraEnabled: boolean;
  voiceEnabled: boolean;
  facingMode: 'user' | 'environment';
  consentSaveTranscript: boolean;
}

interface DeviceCheckProps {
  onReady: (result: DeviceCheckResult) => void;
  onBack: () => void;
}

type CheckStatus = 'pending' | 'checking' | 'passed' | 'failed' | 'skipped';

interface CheckItem {
  key: string;
  label: string;
  status: CheckStatus;
  detail?: string;
}

interface NetworkInfoLike {
  effectiveType?: string;
  saveData?: boolean;
  type?: string;
}

function getNetworkInfo(): NetworkInfoLike | undefined {
  return (navigator as unknown as { connection?: NetworkInfoLike }).connection;
}

const DeviceCheck: React.FC<DeviceCheckProps> = ({ onReady, onBack }) => {
  const [micStatus, setMicStatus] = useState<CheckStatus>('pending');
  const [micLevel, setMicLevel] = useState(0);
  const [cameraStatus, setCameraStatus] = useState<CheckStatus>('pending');
  const [speakerStatus, setSpeakerStatus] = useState<CheckStatus>('pending');
  const [networkStatus, setNetworkStatus] = useState<CheckStatus>('pending');
  const [networkDetail, setNetworkDetail] = useState<string>('');
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const [consent, setConsent] = useState(false);
  const [orientationHint, setOrientationHint] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number>(0);

  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  // 网络检测
  useEffect(() => {
    const conn = getNetworkInfo();
    const detail = conn ? `${conn.effectiveType ?? conn.type ?? 'unknown'}${conn.saveData ? '（省流模式）' : ''}` : '无法读取';
    setNetworkDetail(detail);
    const t0 = performance.now();
    fetch('/api/avatars/presets', { method: 'GET' })
      .then((res) => {
        const ms = Math.round(performance.now() - t0);
        setNetworkStatus(res.ok ? 'passed' : 'failed');
        setNetworkDetail(`${detail} · API 探测 ${ms}ms`);
      })
      .catch(() => {
        setNetworkStatus('failed');
        setNetworkDetail(`${detail} · API 不可达（弱网降级纯语音）`);
      });
  }, []);

  // 横竖屏提示（移动端）
  useEffect(() => {
    if (!isMobile) return;
    const check = () => {
      setOrientationHint(window.innerWidth > window.innerHeight ? '横屏模式：建议竖握手机获得最佳布局' : null);
    };
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, [isMobile]);

  // 清理
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      audioCtxRef.current?.close().catch(() => undefined);
    };
  }, []);

  const startMicCheck = async () => {
    setMicStatus('checking');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const loop = () => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        setMicLevel(Math.min(100, Math.round((avg / 128) * 100)));
        rafRef.current = requestAnimationFrame(loop);
      };
      loop();
      setMicStatus('passed');
    } catch {
      setMicStatus('failed');
    }
  };

  const startCameraCheck = async (mode: 'user' | 'environment' = facingMode) => {
    setCameraStatus('checking');
    try {
      streamRef.current?.getVideoTracks().forEach((t) => t.stop());
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: mode },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => undefined);
      }
      setCameraStatus('passed');
    } catch {
      setCameraStatus('failed');
      setCameraEnabled(false);
    }
  };

  const switchCamera = async () => {
    const next = facingMode === 'user' ? 'environment' : 'user';
    setFacingMode(next);
    if (cameraStatus === 'passed') await startCameraCheck(next);
  };

  const playTestTone = async () => {
    setSpeakerStatus('checking');
    try {
      const ctx = audioCtxRef.current ?? new AudioContext();
      if (!audioCtxRef.current) audioCtxRef.current = ctx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 440;
      gain.gain.value = 0.15;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.4);
      setTimeout(() => setSpeakerStatus('passed'), 500);
    } catch {
      setSpeakerStatus('failed');
    }
  };

  const skipCamera = () => {
    streamRef.current?.getVideoTracks().forEach((t) => t.stop());
    setCameraStatus('skipped');
    setCameraEnabled(false);
  };

  const micReady = micStatus === 'passed' || micStatus === 'failed'; // 失败也可继续（纯文字）
  const canEnter = micReady && consent && (cameraStatus !== 'pending' || !cameraEnabled);

  const statusIcon = (s: CheckStatus) =>
    s === 'passed' ? '✅' : s === 'failed' ? '❌' : s === 'skipped' ? '⏭️' : s === 'checking' ? '⏳' : '⬜';

  return (
    <div className="w-full max-w-2xl mx-auto bg-white rounded-2xl shadow-lg border border-slate-200 overflow-hidden">
      <div className="bg-slate-900 px-8 py-6">
        <h1 className="text-2xl font-bold text-white">设备检测与准备</h1>
        <p className="text-slate-300 text-sm mt-1">按提示逐项检测，随时可以跳过摄像头进入纯语音模式</p>
      </div>

      <div className="p-8 space-y-6">
        {/* 麦克风 */}
        <div className="flex items-center justify-between p-4 rounded-xl border border-slate-200">
          <div>
            <div className="font-semibold text-slate-800">🎤 麦克风 {statusIcon(micStatus)}</div>
            <div className="text-xs text-slate-500 mt-1">
              {micStatus === 'failed' ? '未获得麦克风权限，将使用纯文字模式' : '检测权限与输入音量'}
            </div>
            {micStatus === 'passed' && (
              <div className="mt-2 h-2 w-48 bg-slate-100 rounded-full overflow-hidden">
                <div className="h-full bg-emerald-500 transition-all" style={{ width: `${micLevel}%` }} />
              </div>
            )}
          </div>
          <button
            onClick={startMicCheck}
            disabled={micStatus === 'checking' || micStatus === 'passed'}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40"
          >
            {micStatus === 'passed' ? '已通过' : '开始检测'}
          </button>
        </div>

        {/* 摄像头 */}
        <div className="flex items-center justify-between p-4 rounded-xl border border-slate-200">
          <div className="flex-1">
            <div className="font-semibold text-slate-800">📷 摄像头 {statusIcon(cameraStatus)}</div>
            <div className="text-xs text-slate-500 mt-1">
              {cameraStatus === 'skipped' ? '已跳过摄像头（纯语音模式）' : '检测权限与画面预览'}
            </div>
            {cameraStatus === 'passed' && (
              <video ref={videoRef} muted playsInline className="mt-2 w-40 h-28 bg-black rounded-lg object-cover" />
            )}
          </div>
          <div className="flex flex-col gap-2">
            <button
              onClick={() => startCameraCheck()}
              disabled={cameraStatus === 'checking' || !cameraEnabled}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40"
            >
              {cameraStatus === 'passed' ? '已通过' : '开始检测'}
            </button>
            {isMobile && cameraStatus === 'passed' && (
              <button onClick={switchCamera} className="px-4 py-2 bg-slate-100 text-slate-700 rounded-lg text-sm">
                切换{facingMode === 'user' ? '后置' : '前置'}
              </button>
            )}
            <button onClick={skipCamera} className="px-4 py-2 bg-slate-100 text-slate-600 rounded-lg text-sm hover:bg-slate-200">
              跳过摄像头
            </button>
          </div>
        </div>

        {/* 扬声器 */}
        <div className="flex items-center justify-between p-4 rounded-xl border border-slate-200">
          <div>
            <div className="font-semibold text-slate-800">🔊 扬声器 {statusIcon(speakerStatus)}</div>
            <div className="text-xs text-slate-500 mt-1">播放测试音，确认能听到 AI 发言</div>
          </div>
          <button
            onClick={playTestTone}
            disabled={speakerStatus === 'passed'}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40"
          >
            {speakerStatus === 'passed' ? '已通过' : '播放测试音'}
          </button>
        </div>

        {/* 网络 */}
        <div className="flex items-center justify-between p-4 rounded-xl border border-slate-200">
          <div>
            <div className="font-semibold text-slate-800">🌐 网络 {statusIcon(networkStatus)}</div>
            <div className="text-xs text-slate-500 mt-1">{networkDetail || '检测连通性'}</div>
            {networkStatus === 'failed' && <div className="text-xs text-amber-600 mt-1">弱网将自动降级为纯语音/纯文字模式</div>}
          </div>
          <span className="text-xs text-slate-400">{networkStatus === 'checking' ? '检测中' : ''}</span>
        </div>

        {/* 移动端提示 */}
        {isMobile && (
          <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 space-y-1">
            <div className="text-sm font-semibold text-amber-800">📱 移动端提示</div>
            <ul className="text-xs text-amber-700 list-disc pl-4 space-y-0.5">
              {orientationHint && <li>{orientationHint}</li>}
              <li>请保持手机前台，iOS Safari 后台会限制音频播放</li>
              <li>省电模式可能降低帧率与语音质量</li>
              <li>移动网络下延迟可能升高，可降级纯语音</li>
            </ul>
          </div>
        )}

        {/* 隐私同意（C4） */}
        <div className="p-4 rounded-xl bg-slate-50 border border-slate-200">
          <label className="flex items-start gap-3 cursor-pointer">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-1 w-4 h-4" />
            <span className="text-sm text-slate-700">
              我同意保存本次群面的<b>转写文本与聚合特征</b>用于面后评估；<b>原始音频/视频默认不保存</b>，摄像头分析全部在浏览器本地完成（0 字节上传）。
              第三方 API（DeepSeek / StepFun）按隐私政策处理数据。
            </span>
          </label>
        </div>
        {/* 群面阶段说明（PRD 4.1.3） */}
        <div className="p-4 rounded-xl bg-blue-50/60 border border-blue-100">
          <div className="text-sm font-semibold text-blue-800 mb-2">⏱️ 群面流程（倒计时驱动，到点强制切换）</div>
          <ol className="text-xs text-blue-700 space-y-1 list-decimal pl-4">
            <li>审题（2 分钟，暂不发言）</li>
            <li>个人陈述（每人 1 分钟）</li>
            <li>自由讨论（≤15 分钟，可打断/抢话）</li>
            <li>总结陈词（3 分钟）→ 面后报告</li>
          </ol>
        </div>
        <div className="flex gap-3">
          <button onClick={onBack} className="px-6 py-3 bg-slate-100 text-slate-700 rounded-xl font-medium hover:bg-slate-200">
            上一步
          </button>
          <button
            onClick={() =>
              onReady({ cameraEnabled: cameraEnabled && cameraStatus === 'passed', voiceEnabled: micStatus !== 'failed', facingMode, consentSaveTranscript: consent })
            }
            disabled={!canEnter}
            className="flex-1 py-3 bg-slate-900 text-white rounded-xl font-bold hover:bg-slate-800 disabled:opacity-40"
          >
            进入群面房间
          </button>
        </div>
      </div>
    </div>
  );
};

export default DeviceCheck;
