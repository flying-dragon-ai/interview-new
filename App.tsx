import React, { useState } from 'react';
import QuestionBankHome from './components/QuestionBankHome';
import DeviceCheck, { type DeviceCheckResult } from './components/DeviceCheck';
import QuestionBriefing from './components/QuestionBriefing';
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
import type { PhaseState } from './engine/phaseEngine';
import { buildRuleReport } from './engine/reportEngine';
import {
  createLocalPracticeId,
  deleteLocalPracticeRecord,
  getLocalPracticeRecord,
  saveLocalPracticeRecord,
} from './src/localPractice';

/**
 * 应用主流程（PRD 5.2 目标流程）
 * SetupForm → DeviceCheck → VoiceRoom（MockSharp 八阶段）→ EvidenceReport（v1.5）
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
  const [demoMode, setDemoMode] = useState(false);
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [localRecordId, setLocalRecordId] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [localSaveFailed, setLocalSaveFailed] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
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
  const [resumeCheckpoint, setResumeCheckpoint] = useState<PhaseState | null>(null);
  const startPreparation = (params: { topic: string; jobTitle: string; company: string; topicType: string; roles: RoleCard[]; resumeCheckpoint?: PhaseState | null; demoMode?: boolean }) => {
    setState((prev) => ({
      ...prev,
      topic: params.topic,
      jobTitle: params.jobTitle,
      company: params.company,
      status: 'BRIEFING',
    }));
    setRoles(params.roles);
    setTopicType(params.topicType);
    setDemoMode(params.demoMode ?? false);
    setResumeCheckpoint(params.resumeCheckpoint ?? null);
  };

  // ---- 设备检测完成 → 创建会话 → 进入房间 ----
  const enterRoom = async (result: DeviceCheckResult) => {
    setConsent(result.consentSaveTranscript);
    setCameraEnabled(result.cameraEnabled);
    setVoiceEnabled(result.voiceEnabled);
    setFacingMode(result.facingMode);

    // 未同意服务端保存时不创建数据库会话，完整练习记录仅留在当前浏览器。
    const session = result.consentSaveTranscript
      ? await createSession({
          company: state.company,
          jobTitle: state.jobTitle,
          topic: state.topic,
          topicType,
          roles: roles.map((r) => r.id),
          voiceEnabled: result.voiceEnabled,
          cameraEnabled: result.cameraEnabled,
          walletAddress: null,
        })
      : null;
    // 用户未同意服务器保存，或数据库不可用时，转为本机持久化。
    const localId = session ? null : createLocalPracticeId();
    setLocalRecordId(localId);
    setLocalSaveFailed(false);
    if (localId) {
      const saved = saveLocalPracticeRecord({
        id: localId,
        company: state.company,
        jobTitle: state.jobTitle,
        topic: state.topic,
        topicType,
        status: 'in_progress',
        startedAt: Date.now(),
      });
      setLocalSaveFailed(!saved);
    }
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
    try { localStorage.removeItem(`lgd-checkpoint:${state.topic}`); } catch { /* best effort */ }
    try {
      const items = JSON.parse(localStorage.getItem('lgd-practice-history') || '[]');
      localStorage.setItem('lgd-practice-history', JSON.stringify(items.map((item: { topic?: string }) => item.topic === state.topic ? { ...item, status: 'finished', finishedAt: Date.now() } : item)));
    } catch { /* local history is best effort */ }
    setFinishedMessages(history);
    setFinishedEvents(events);
    setSessionStartAt(startedAt);
    if (localRecordId) {
      const localRecord = getLocalPracticeRecord(localRecordId);
      if (localRecord) {
        setLocalSaveFailed(!saveLocalPracticeRecord({ ...localRecord, status: 'finished', finishedAt: Date.now(), messages: history, events }));
      }
    }
    setIsLoadingFeedback(true);
    setFeedbackError(false);

    const durationMs = Date.now() - startedAt;

    // 并行：服务端分析（有会话时）+ 旧 4 字段报告（冗余展示）
    const tasks: Promise<unknown>[] = [];

    tasks.push(
      (async () => {
        try {
          let reportV15: ReportV15 | null = null;
          if (demoMode) {
            reportV15 = buildRuleReport({ transcripts: history, events, sessionStartAt: startedAt, durationMs, voiceEnabled });
          } else if (sessionId && consent) {
            reportV15 = await triggerAnalyze(sessionId);
          }
          if (!reportV15) {
            try {
              reportV15 = await generateReportV15({
                topic: state.topic,
                jobTitle: state.jobTitle,
                messages: history,
                events,
                sessionStartAt: startedAt,
                durationMs,
                sessionId,
                voiceEnabled,
              });
            } catch (error) {
              console.warn('在线报告不可用，切换本地规则评分:', error);
              reportV15 = buildRuleReport({ transcripts: history, events, sessionStartAt: startedAt, durationMs, voiceEnabled });
            }
          }
          setReport(reportV15);
          if (localRecordId) {
            const localRecord = getLocalPracticeRecord(localRecordId);
            if (localRecord) {
              setLocalSaveFailed(!saveLocalPracticeRecord({ ...localRecord, status: 'finished', finishedAt: Date.now(), messages: history, events, report: reportV15, score: reportV15.overall_score }));
            }
          }
          try {
            const items = JSON.parse(localStorage.getItem('lgd-practice-history') || '[]');
            localStorage.setItem('lgd-practice-history', JSON.stringify(items.map((item: { topic?: string }) => item.topic === state.topic ? { ...item, status: 'finished', score: reportV15?.overall_score, finishedAt: Date.now() } : item)));
          } catch { /* local history is best effort */ }
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
        if (demoMode) return;
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

  const handleDeleteLocalRecord = (id: string): boolean => deleteLocalPracticeRecord(id);

  const interruptSimulation = () => {
    try {
      const items = JSON.parse(localStorage.getItem('lgd-practice-history') || '[]');
      localStorage.setItem('lgd-practice-history', JSON.stringify(items.map((item: { topic?: string }) => item.topic === state.topic ? { ...item, status: 'interrupted', interruptedAt: Date.now() } : item)));
    } catch { /* local history is best effort */ }
    if (localRecordId) {
      const localRecord = getLocalPracticeRecord(localRecordId);
      if (localRecord) saveLocalPracticeRecord({ ...localRecord, status: 'interrupted' });
    }
    if (sessionId) updateSessionStatus(sessionId, 'INTERRUPTED');
    setState((prev) => ({ ...prev, status: 'INTERRUPTED' }));
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
    setLocalRecordId(null);
    setReport(null);
    setLegacyFeedback(null);
    setFinishedMessages([]);
    setFinishedEvents([]);
    setLocalSaveFailed(false);
  };

  const openLocalReport = (id: string) => {
    const record = getLocalPracticeRecord(id);
    if (!record?.report) return;
    setLocalRecordId(id);
    setConsent(false);
    setDbAvailable(false);
    setSessionId(null);
    setDemoMode(false);
    setState({
      topic: record.topic,
      jobTitle: record.jobTitle,
      company: record.company,
      messages: record.messages ?? [],
      status: 'FINISHED',
      activeCharacterId: null,
      round: record.messages?.length ?? 0,
    });
    setReport(record.report);
    setLegacyFeedback(null);
    setFinishedMessages(record.messages ?? []);
    setFinishedEvents(record.events ?? []);
    setSessionStartAt(record.startedAt);
    setIsLoadingFeedback(false);
    setFeedbackError(false);
    setLocalSaveFailed(false);
  };

  return (
    <div className="min-h-screen bg-slate-50">
      {/* MockSharp 风格顶部导航 */}
      <div className="bg-[#171717] text-white px-5 md:px-8 py-4">
        <div className="max-w-[1180px] mx-auto flex justify-between items-center">
          <div className="flex items-center gap-3"><div className="w-3 h-3 bg-[#dfff00] rounded-full" /><div className="text-sm font-black tracking-[.08em]">把面试记录永久留存</div></div>
          <div className="flex items-center gap-4">
            {!dbAvailable && state.status !== 'IDLE' && (
                <span className="text-[10px] text-[#dfff00] border border-white/20 rounded-full px-2 py-0.5">
                本地模式（{consent ? '未配置数据库' : '未同意云端保存'}）
              </span>
            )}
            <button onClick={() => setShowPrivacy(true)} className="text-sm text-white/60 hover:text-[#dfff00]">
              隐私政策
            </button>
            <button onClick={restart} className="text-sm font-bold text-[#dfff00] hover:underline">
              新建练习
            </button>
          </div>
        </div>
      </div>

      {/* 主内容 */}
      <div className={state.status === 'DISCUSSING' ? 'h-[calc(100vh-57px)]' : 'p-4 md:p-6'}>
        {state.status === 'IDLE' && (
          <div className="max-w-3xl mx-auto">
            <QuestionBankHome onStart={startPreparation} onViewLocalReport={openLocalReport} />
          </div>
        )}

        {state.status === 'BRIEFING' && (
          <QuestionBriefing state={state} topicType={topicType} onContinue={() => setState((prev) => ({ ...prev, status: 'PREPARING' }))} onBack={restart} />
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
              voiceEnabled={voiceEnabled}
              facingMode={facingMode}
              onFinish={finishSimulation}
              onExit={interruptSimulation}
              resumeCheckpoint={resumeCheckpoint}
              demoMode={demoMode}
            />
          </div>
        )}

        {state.status === 'INTERRUPTED' && (
          <div className="max-w-xl mx-auto bg-white rounded-3xl border border-amber-200 shadow-sm p-8 text-center">
            <div className="text-4xl mb-4">⏸</div>
            <h2 className="text-2xl font-black text-slate-900">本次练习已中断</h2>
            <p className="text-sm text-slate-500 mt-3 leading-6">本次练习已标记为中断，未完成的聊天和事件不会被伪装成完整报告。</p>
            <button type="button" onClick={restart} className="mt-6 rounded-xl bg-slate-950 text-white px-6 py-3 font-black">返回题库大厅</button>
          </div>
        )}

        {state.status === 'FINISHED' && (
          <div className="max-w-4xl mx-auto">
            {localSaveFailed && (
              <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                浏览器存储空间不足，本次报告暂时只在当前页面显示；请清理不需要的本地练习记录后重试。
              </div>
            )}
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
                localRecordId={localRecordId}
                onDeleteLocalRecord={handleDeleteLocalRecord}
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
