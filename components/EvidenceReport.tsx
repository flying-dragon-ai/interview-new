import React, { useState } from 'react';
import type { Evidence, FeedbackData, GameEvent, Message, ReportV15 } from '../types';
import PracticeTimeline from './PracticeTimeline';
import RetryGoalCard from './RetryGoalCard';
import CredentialPublisher from './CredentialPublisher';

/**
 * 面后报告 v1.5（PRD 4.1.7 / 7.5 / E.5 / US-05 / US-06 / US-11）
 * 维度分 + evidence 引用（原话 + 时间点）+ 规则引擎指标 + 事件时间轴 + 删除记录。
 */

interface EvidenceReportProps {
  report: ReportV15;
  legacy?: FeedbackData | null;
  messages?: Message[];
  events?: GameEvent[];
  sessionStartAt?: number;
  sessionId?: number | null;
  onRestart: () => void;
  onDeleteRecords?: (sessionId: number) => Promise<boolean> | boolean;
}

function formatTs(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const DIMENSION_META: { key: 'content' | 'voice' | 'visual' | 'stress' | 'teamwork'; label: string; icon: string }[] = [
  { key: 'content', label: '内容贡献', icon: '🧠' },
  { key: 'voice', label: '语音表现', icon: '🎙️' },
  { key: 'visual', label: '视觉表现', icon: '👁️' },
  { key: 'stress', label: '抗压/冲突', icon: '🛡️' },
  { key: 'teamwork', label: '团队协作', icon: '🤝' },
];

const EvidenceItem: React.FC<{ evidence: Evidence; onClick?: () => void }> = ({ evidence, onClick }) => (
  <div
    onClick={onClick}
    className={`text-xs bg-slate-50 border border-slate-100 rounded-lg px-3 py-2 ${onClick ? 'cursor-pointer hover:border-blue-300' : ''}`}
  >
    <span className="font-mono text-slate-900 font-bold">[{formatTs(evidence.timestamp_ms)}]</span>{' '}
    <span className="text-slate-700">{evidence.content}</span>
    <span className="ml-1 text-[10px] text-slate-400">（{evidence.modality === 'event' ? '事件' : '原话'}）</span>
  </div>
);

const EvidenceReport: React.FC<EvidenceReportProps> = ({
  report,
  legacy,
  messages = [],
  events = [],
  sessionStartAt = 0,
  sessionId = null,
  onRestart,
  onDeleteRecords,
}) => {
  const [deleting, setDeleting] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [highlightMsgIndex, setHighlightMsgIndex] = useState<number | null>(null);

  const handleDelete = async () => {
    if (!sessionId || !onDeleteRecords) return;
    if (!window.confirm('确认删除本次练习的全部记录？删除后不可恢复。')) return;
    setDeleting(true);
    const ok = await onDeleteRecords(sessionId);
    setDeleting(false);
    if (ok) setDeleted(true);
  };

  const eventTimeline = events
    .filter((e) => e.event_type === 'interrupt' || e.event_type === 'stage_change' || e.event_type === 'stage_start' || e.event_type === 'stage_end')
    .slice(0, 20);

  return (
    <div className="max-w-4xl mx-auto p-6 md:p-8 bg-[#f4f4f0] rounded-2xl border border-[#d8d8d2]">
      {/* 总分 */}
      <div className="text-center mb-8">
        <div className="inline-block px-4 py-1 bg-[#dfff00] text-[#171717] rounded-full text-xs font-black mb-4">模拟面试报告 v1.5</div>
        <h2 className="text-3xl font-black text-slate-900 mb-4">面试表现评估</h2>
        <div className="flex justify-center items-center gap-6">
          <div className="flex flex-col items-center">
            <div className="text-5xl font-black text-[#171717]">{report.overall_score}</div>
            <div className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">综合得分</div>
          </div>
          <div className="h-10 w-px bg-slate-200" />
          <div className="flex flex-col items-center">
            <div className="text-2xl font-black text-[#171717]">{report.performance_rank ?? '待评估'}</div>
            <div className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">本场表现位次</div>
          </div>
          <div className="h-10 w-px bg-slate-200" />
          <div className="flex flex-col items-center">
            <div className="text-2xl font-black text-slate-700">{report.performance_level ?? '待评估'}</div>
            <div className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">表现等级</div>
          </div>
          <div className="flex flex-col items-center">
            <div className="text-sm font-black text-slate-700">{report.simulated_rank ?? '待评估'}</div>
            <div className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">模拟排名</div>
          </div>
          <div className="flex flex-col items-center">
            <div className="text-5xl font-black text-emerald-500">{report.dimensions.voice.metrics?.['话语权占比'] ?? 0}%</div>
            <div className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">话语权占有</div>
          </div>
        </div>
      </div>

      {/* 维度分 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
        {DIMENSION_META.map(({ key, label, icon }) => {
          const dim = report.dimensions[key];
          const disabled = 'status' in dim && dim.status === 'not_enabled';
          return (
            <div key={key} className={`p-5 rounded-2xl border ${disabled ? 'bg-white/60 border-[#e2e2dc]' : 'bg-white border-[#e2e2dc]'}`}>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-bold text-slate-700 flex items-center">
                  <span className="mr-2">{icon}</span>
                  {label}
                </h3>
                <span className="text-lg font-black text-slate-900">
                  {disabled ? '—' : dim.score}
                  <span className="text-xs text-slate-400 font-bold">/{dim.max}</span>
                </span>
              </div>
              {disabled ? <p className="text-xs text-slate-400">{dim.note ?? '本场未开启'}</p> : null}
              {!disabled && dim.metrics && Object.keys(dim.metrics).length > 0 && (
                <div className="flex flex-wrap gap-2 mb-3">
                  {Object.entries(dim.metrics).map(([k, v]) => (
                    <span key={k} className="text-[10px] bg-white border border-slate-200 rounded-full px-2 py-0.5 text-slate-500">
                      {k}: <b className="text-slate-700">{v}</b>
                    </span>
                  ))}
                </div>
              )}
              {!disabled && dim.evidence.length > 0 && (
                <div className="space-y-1.5">
                  {dim.evidence.slice(0, 4).map((ev) => (
                    <EvidenceItem
                      key={ev.id}
                      evidence={ev}
                      onClick={
                        typeof ev.message_index === 'number' && messages[ev.message_index]
                          ? () => setHighlightMsgIndex(ev.message_index!)
                          : undefined
                      }
                    />
                  ))}
                </div>
              )}
              {!disabled && dim.evidence.length === 0 && <p className="text-xs text-slate-400">暂无证据引用</p>}
              {!disabled && dim.note && <p className="text-[10px] text-slate-400 mt-2">{dim.note}</p>}
            </div>
          );
        })}
      </div>

      {/* 事件时间轴 */}
      {eventTimeline.length > 0 && (
        <div className="mb-8">
          <h3 className="text-lg font-bold text-slate-900 mb-4">事件时间轴</h3>
          <PracticeTimeline events={eventTimeline} />
        </div>
      )}

      {/* 原话定位（点击证据定位到消息） */}
      {highlightMsgIndex !== null && messages[highlightMsgIndex] && (
        <div className="mb-8 p-4 rounded-2xl bg-white border border-[#d8d8d2]">
          <div className="text-xs font-bold text-slate-700 mb-1">
            定位到 {formatTs(Math.max(0, messages[highlightMsgIndex].timestamp - sessionStartAt))} 的发言
          </div>
          <p className="text-sm text-slate-700">{messages[highlightMsgIndex].content}</p>
        </div>
      )}

      {/* 改进建议 */}
      <div className="mb-8">
        <h3 className="text-lg font-bold text-slate-900 mb-4">改进建议</h3>
        <ul className="space-y-3">
          {report.suggestions.map((s, i) => (
            <li key={i} className="flex items-start gap-3 bg-white p-4 rounded-xl border border-[#e2e2dc]">
              <span className="w-6 h-6 rounded-full bg-[#dfff00] text-[#171717] flex items-center justify-center text-xs font-black shrink-0">
                {i + 1}
              </span>
              <p className="text-sm text-slate-700 font-medium">{s}</p>
            </li>
          ))}
        </ul>
      </div>
      <CredentialPublisher report={report} sessionId={sessionId} />
      <div className="mb-8"><RetryGoalCard suggestions={report.suggestions} onRetry={onRestart} /></div>

      {/* 旧 4 字段（冗余展示，PRD D.2） */}
      {legacy && (
        <details className="mb-8">
          <summary className="text-sm font-bold text-slate-500 cursor-pointer">展开经典四维评价（旧版字段）</summary>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
            <div className="p-4 bg-slate-50 rounded-xl text-sm text-slate-600">
              <b>发言时机：</b>
              {legacy.timing}
            </div>
            <div className="p-4 bg-slate-50 rounded-xl text-sm text-slate-600">
              <b>结构贡献：</b>
              {legacy.structuralContribution}
            </div>
            <div className="p-4 bg-slate-50 rounded-xl text-sm text-slate-600 md:col-span-2">
              <b>抗压/冲突处理：</b>
              {legacy.interruptionHandling}
            </div>
          </div>
        </details>
      )}

      {/* 隐私与删除 */}
      <div className="mb-8 p-4 rounded-2xl bg-slate-50 border border-slate-100 text-xs text-slate-500 leading-relaxed">
        隐私说明：原始音频/视频默认不保存；本报告基于转写文本与聚合特征生成。第三方 API（DeepSeek / StepFun）按隐私政策处理数据。
        {sessionId && onDeleteRecords && (
          <div className="mt-3">
            <button
              onClick={handleDelete}
              disabled={deleting || deleted}
              className="px-4 py-2 bg-red-50 text-red-600 border border-red-200 rounded-lg font-medium hover:bg-red-100 disabled:opacity-50"
            >
              {deleted ? '已删除本次记录' : deleting ? '删除中...' : '删除本次记录（不可恢复）'}
            </button>
          </div>
        )}
      </div>

      <button
        onClick={onRestart}
        className="w-full bg-[#171717] text-white font-bold py-4 rounded-xl hover:bg-[#333] transition-all active:scale-[0.98]"
      >
        重新开始模拟
      </button>
    </div>
  );
};

export default EvidenceReport;
