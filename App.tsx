import React, { useState } from 'react';
import SetupForm from './components/SetupForm';
import DeviceCheck, { type DeviceCheckResult } from './components/DeviceCheck';
import VoiceRoom from './components/VoiceRoom';
import EvidenceReport from './components/EvidenceReport';
import FeedbackReport from './components/FeedbackReport';
import PrivacyPolicy from './components/PrivacyPolicy';
import { SimulationState, Message, GameEvent, RoleCard, ReportV15, FeedbackData } from './types';
import { generateReportV15, generateFeedback } from './services/geminiService';
import {
  createSession,
  updateSessionStatus,
  deleteSession,
  saveReport,
  triggerAnalyze,
} from './src/api';

/**
 * 应用主流程（PRD 5.2 目标流程）
 * SetupForm → DeviceCheck → VoiceRoom（倒计时四阶段）→ EvidenceReport（v1.5）
 * 降级路径：无麦克风 → 纯文字；无摄像头 → 纯语音；弱网 → 纯语音/纯文字。
 */

const App: React.FC = () => {
  const [state, setState] = useState<SimulationState>({
    topic: '',
    jobTitle: '',
    company: '',
    messages: [],
    status: 'IDLE',
    activeCharacterId: null,
    round: 0,
  });
  const [roles, setRoles] = useState<RoleCard[]>([]);
  const [topicType, setTopicType] = useState('business_case');
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [consent, setConsent] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const [dbAvailable, setDbAvailable] = useState(true);

  const [report, setReport] = useState<ReportV15 | null>(null);
  const [legacyFeedback, setLegacyFeedback] = useState<FeedbackData | null>(null);
  const [finishedMessages, setFinishedMessages] = useState<Message[]>([]);
  const [finishedEvents, setFinishedEvents] = useState<GameEvent[]>([]);
  const [sessionStartAt, setSessionStartAt] = useState(0);
  const [isLoadingFeedback, setIsLoadingFeedback] = useState(false);
  const [feedbackError, setFeedbackError] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);

  // ---- 准备页 → 设备检测 ----
  const startPreparation = (params: { topic: string; jobTitle: string; company: string; topicType: string; roles: RoleCard[] }) => {
    setState((prev) => ({
      ...prev,
      topic: params.topic,
      jobTitle: params.jobTitle,
      company: params.company,
      status: 'PREPARING',
    }));
    setRoles(params.roles);
    setTopicType(params.topicType);
  };

  // ---- 设备检测完成 → 创建会话 → 进入房间 ----
  const enterRoom = async (result: DeviceCheckResult) => {
    setConsent(result.consentSaveTranscript);
    setCameraEnabled(result.cameraEnabled);
    setFacingMode(result.facingMode);

    // 创建会话（数据库不可用时降级本地模式）
    const session = await createSession({
      company: state.company,
      jobTitle: state.jobTitle,
      topic: state.topic,
      topicType,
      roles: roles.map((r) => r.id),
      voiceEnabled: result.voiceEnabled,
      cameraEnabled: result.cameraEnabled,
    });
    if (session) {
      setSessionId(session.id);
      setDbAvailable(true);
    } else {
      setSessionId(null);
      setDbAvailable(false);
    }
    setState((prev) => ({ ...prev, status: 'DISCUSSING' }));
  };

  // ---- 群面结束 → 面后分析 → 报告 v1.5 ----
  const finishSimulation = async (history: Message[], events: GameEvent[], startedAt: number) => {
    setState((prev) => ({ ...prev, status: 'FINISHED', messages: history }));
    setFinishedMessages(history);
    setFinishedEvents(events);
    setSessionStartAt(startedAt);
    setIsLoadingFeedback(true);
    setFeedbackError(false);

    const durationMs = Date.now() - startedAt;

    // 并行：服务端分析（有会话时）+ 旧 4 字段报告（冗余展示）
    const tasks: Promise<unknown>[] = [];

    tasks.push(
      (async () => {
        try {
          let reportV15: ReportV15 | null = null;
          if (sessionId && consent) {
            reportV15 = await triggerAnalyze(sessionId);
          }
          if (!reportV15) {
            reportV15 = await generateReportV15({
              topic: state.topic,
              jobTitle: state.jobTitle,
              messages: history,
              events,
              sessionStartAt: startedAt,
              durationMs,
              sessionId,
            });
          }
          setReport(reportV15);
          if (sessionId && consent) {
            saveReport({ sessionId, report: reportV15 });
          }
        } catch (e) {
          console.error('报告 v1.5 生成失败:', e);
          setFeedbackError(true);
        }
      })()
    );

    tasks.push(
      (async () => {
        try {
          const legacy = await generateFeedback(state.topic, state.jobTitle, history);
          setLegacyFeedback(legacy);
        } catch {
          // 旧字段报告失败不阻断 v1.5
        }
      })()
    );

    await Promise.all(tasks);

    // 更新会话状态
    if (sessionId) {
      updateSessionStatus(sessionId, 'FINISHED');
    }
    setIsLoadingFeedback(false);
  };

  const handleDeleteRecords = async (id: number): Promise<boolean> => {
    return deleteSession(id);
  };

  const restart = () => {
    setState({
      topic: '',
      jobTitle: '',
      company: '',
      messages: [],
      status: 'IDLE',
      activeCharacterId: null,
      round: 0,
    });
    setRoles([]);
    setSessionId(null);
    setReport(null);
    setLegacyFeedback(null);
    setFinishedMessages([]);
    setFinishedEvents([]);
  };

  return (
    <div className="min-h-screen bg-slate-50">
      {/* 顶部导航 */}
      <div className="bg-white border-b border-slate-200 px-4 md:px-6 py-3">
        <div className="max-w-6xl mx-auto flex justify-between items-center">
          <div className="text-lg font-bold text-blue-600">LGD Simulator</div>
          <div className="flex items-center gap-4">
            {!dbAvailable && state.status !== 'IDLE' && (
              <span className="text-[10px] text-amber-600 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
                本地模式（未配置数据库）
              </span>
            )}
            <button onClick={() => setShowPrivacy(true)} className="text-sm text-slate-500 hover:text-blue-600">
              隐私政策
            </button>
            <button onClick={restart} className="text-sm text-blue-600 hover:underline">
              新建练习
            </button>
          </div>
        </div>
      </div>

      {/* 主内容 */}
      <div className={state.status === 'DISCUSSING' ? 'h-[calc(100vh-57px)]' : 'p-4 md:p-6'}>
        {state.status === 'IDLE' && (
          <div className="max-w-3xl mx-auto">
            <SetupForm onStart={startPreparation} />
          </div>
        )}

        {state.status === 'PREPARING' && (
          <div className="max-w-2xl mx-auto">
            <DeviceCheck onReady={enterRoom} onBack={restart} />
          </div>
        )}

        {state.status === 'DISCUSSING' && (
          <div className="max-w-7xl mx-auto h-full">
            <VoiceRoom
              state={state}
              roles={roles}
              sessionId={sessionId}
              consentSaveTranscript={consent}
              cameraEnabled={cameraEnabled}
              facingMode={facingMode}
              onFinish={finishSimulation}
              onExit={restart}
            />
          </div>
        )}

        {state.status === 'FINISHED' && (
          <div className="max-w-4xl mx-auto">
            {isLoadingFeedback ? (
              <div className="flex flex-col items-center justify-center py-20">
                <div className="relative">
                  <div className="w-20 h-20 border-4 border-blue-100 border-t-blue-600 rounded-full animate-spin"></div>
                  <div className="absolute inset-0 flex items-center justify-center text-blue-600 font-bold">AI</div>
                </div>
                <div className="mt-6 text-center">
                  <h3 className="text-xl font-bold text-slate-800">面试官正在整理评估报告...</h3>
                  <p className="text-slate-500 mt-2">规则引擎实算指标 + AI 语义分析 + 证据池生成中（目标 ≤30 秒）</p>
                </div>
              </div>
            ) : report ? (
              <EvidenceReport
                report={report}
                legacy={legacyFeedback}
                messages={finishedMessages}
                events={finishedEvents}
                sessionStartAt={sessionStartAt}
                sessionId={sessionId}
                onRestart={restart}
                onDeleteRecords={handleDeleteRecords}
              />
            ) : legacyFeedback ? (
              <div className="space-y-4">
                {feedbackError && (
                  <div className="max-w-3xl mx-auto text-center text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-xl px-4 py-2">
                    ⚠️ v1.5 证据化报告生成失败（LLM 异常），已降级展示经典四维评价
                  </div>
                )}
                <FeedbackReport feedback={legacyFeedback} onRestart={restart} />
              </div>
            ) : (
              <div className="text-center p-8 bg-white rounded-3xl shadow-xl">
                <h2 className="text-2xl font-bold text-red-500 mb-4">反馈生成失败</h2>
                <p className="text-slate-500 mb-6">请检查网络后重试（LLM 服务异常时会自动降级）</p>
                <button onClick={restart} className="px-6 py-2 bg-slate-900 text-white rounded-xl">
                  返回主页
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {showPrivacy && <PrivacyPolicy onClose={() => setShowPrivacy(false)} />}
    </div>
  );
};

export default App;
