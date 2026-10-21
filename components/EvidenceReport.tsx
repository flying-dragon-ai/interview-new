import React, { Suspense, lazy, useState } from 'react';
import type { Evidence, FeedbackData, GameEvent, Message, ReportV15 } from '../types';
import { useWalletIdentity } from '../src/wallet/context';
import { isCertConfigured } from '../src/onchain/config';

/** 链上证书卡片懒加载：未配置 VITE_CERT_ADDRESS / 钱包层未就绪时不进 bundle（与 ParaWalletProvider 同 pattern） */
const LazyCertificateSection = lazy(() => import('./CertificateSection'));

/**
 * 面后报告 v1.5（PRD 4.1.7 / 7.5 / E.5 / US-05 / US-06 / US-11）
 * 维度分 + evidence 引用（原话 + 时间点）+ 规则引擎指标 + 事件时间轴 + 删除记录。
 */

interface EvidenceReportProps {
  report: ReportV15;
  /** 旧 4 字段报告（冗余展示）：外部已生成时直接展示 */
  legacy?: FeedbackData | null;
  /** 旧报告懒加载（App 不再无条件预生成；点击按钮才消耗一次 LLM 调用） */
  loadLegacy?: () => Promise<FeedbackData>;
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

const DIMENSION_META: { key: 'content' | 'voice' | 'visual' | 'stress' | 'teamwork'; label: string; icon: string; color: string }[] = [
  { key: 'content', label: '内容贡献', icon: '🧠', color: '#22D3EE' },
  { key: 'voice', label: '语音表现', icon: '🎙️', color: '#A78BFA' },
  { key: 'visual', label: '视觉表现', icon: '👁️', color: '#60A5FA' },
  { key: 'stress', label: '抗压/冲突', icon: '🛡️', color: '#FBBF24' },
  { key: 'teamwork', label: '团队协作', icon: '🤝', color: '#34D399' },
];

/** 证据来源标签（M6：视觉维度 → 画面） */
const MODALITY_LABEL: Record<Evidence['modality'], string> = {
  text: '原话',
  voice: '语音',
  visual: '画面',
  event: '事件',
};

const EvidenceItem: React.FC<{ evidence: Evidence; onClick?: () => void }> = ({ evidence, onClick }) => (
  <div
    onClick={onClick}
    className={`text-xs bg-white/[0.06] border border-white/10 rounded-xl px-3 py-2 transition-all ${
      onClick ? 'cursor-pointer hover:border-white/25 hover:bg-white/[0.09] hover:shadow-[0_0_16px_rgba(91,108,255,0.25)]' : ''
    }`}
  >
    <span className="font-mono font-bold tabular-nums text-gradient-brand">[{formatTs(evidence.timestamp_ms)}]</span>{' '}
    <span className="text-white/75">{evidence.content}</span>
    <span className="ml-1 text-[10px] text-white/40">（{MODALITY_LABEL[evidence.modality]}）</span>
  </div>
);

const EvidenceReport: React.FC<EvidenceReportProps> = ({
  report,
  legacy,
  loadLegacy,
  messages = [],
  events = [],
  sessionStartAt = 0,
  sessionId = null,
  onRestart,
  onDeleteRecords,
}) => {
  const wallet = useWalletIdentity();
  const [deleting, setDeleting] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [highlightMsgIndex, setHighlightMsgIndex] = useState<number | null>(null);
  const [legacyData, setLegacyData] = useState<FeedbackData | null>(legacy ?? null);
  const [legacyLoading, setLegacyLoading] = useState(false);
  const [legacyError, setLegacyError] = useState(false);

  const handleDelete = async () => {
    if (!sessionId || !onDeleteRecords) return;
    if (!window.confirm('确认删除本次练习的全部记录？删除后不可恢复。')) return;
    setDeleting(true);
    const ok = await onDeleteRecords(sessionId);
    setDeleting(false);
    if (ok) setDeleted(true);
  };

  const eventTimeline = events
    .filter((e) => e.event_type === 'interrupt' || e.event_type === 'stage_change')
    .slice(0, 20);

  const RING_C = 2 * Math.PI * 52;
  const scorePct = Math.min(100, Math.max(0, report.overall_score)) / 100;

  return (
    <div className="max-w-4xl mx-auto glass-panel p-6 md:p-8">
      {/* 英雄区：综合得分超大渐变数字 + 玻璃圆环仪表盘 */}
      <div className="text-center mb-10">
        <div className="glass-chip px-4 py-1 text-xs font-bold text-white/60 mb-6 inline-flex">模拟面试报告 v1.5</div>
        <h2 className="text-3xl font-black text-white mb-8">面试表现评估</h2>
        <div className="flex justify-center">
          <div className="relative w-40 h-40 md:w-48 md:h-48">
            <svg viewBox="0 0 120 120" className="w-full h-full -rotate-90">
              <defs>
                <linearGradient id="score-ring-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#5B6CFF" />
                  <stop offset="100%" stopColor="#A78BFA" />
                </linearGradient>
              </defs>
              <circle cx="60" cy="60" r="52" fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth="7" />
              <circle
                cx="60"
                cy="60"
                r="52"
                fill="none"
                stroke="url(#score-ring-grad)"
                strokeWidth="7"
                strokeLinecap="round"
                strokeDasharray={RING_C}
                strokeDashoffset={RING_C * (1 - scorePct)}
                style={{ filter: 'drop-shadow(0 0 8px rgba(91,108,255,0.6))', transition: 'stroke-dashoffset 1s ease' }}
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <div className="text-6xl md:text-7xl font-black text-gradient-brand tabular-nums leading-none">{report.overall_score}</div>
              <div className="text-[10px] text-white/40 font-bold uppercase tracking-widest mt-2">综合得分</div>
            </div>
          </div>
        </div>

        {/* 次级指标：一排玻璃 stat 卡 */}
        <div className="grid grid-cols-3 gap-3 mt-8 max-w-lg mx-auto">
          <div className="glass-card p-3 text-center">
            <div className="text-2xl font-black text-emerald-300 tabular-nums">{report.dimensions.voice.metrics?.['话语权占比'] ?? 0}%</div>
            <div className="text-[10px] text-white/40 font-bold uppercase tracking-widest mt-1">话语权占有</div>
          </div>
          <div className="glass-card p-3 text-center">
            <div className="text-2xl font-black text-white tabular-nums">{messages.length}</div>
            <div className="text-[10px] text-white/40 font-bold uppercase tracking-widest mt-1">发言条数</div>
          </div>
          <div className="glass-card p-3 text-center">
            <div className="text-2xl font-black text-white tabular-nums">{eventTimeline.length}</div>
            <div className="text-[10px] text-white/40 font-bold uppercase tracking-widest mt-1">关键事件</div>
          </div>
        </div>
      </div>

      {/* 维度分：Bento 玻璃卡网格 + 发光进度条 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
        {DIMENSION_META.map(({ key, label, icon, color }) => {
          const dim = report.dimensions[key];
          const disabled = 'status' in dim && dim.status === 'not_enabled';
          return (
            <div key={key} className={`glass-card p-5 ${key === 'content' ? 'md:col-span-2' : ''} ${disabled ? 'opacity-50 saturate-50' : ''}`}>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-bold text-white/85 flex items-center">
                  <span className="mr-2">{icon}</span>
                  {label}
                </h3>
                <span className="text-lg font-black text-white tabular-nums">
                  {disabled ? '—' : dim.score}
                  <span className="text-xs text-white/40 font-bold">/{dim.max}</span>
                </span>
              </div>
              {!disabled && (
                <div className="h-1.5 bg-white/10 rounded-full overflow-hidden mb-3">
                  <div
                    className="h-full rounded-full transition-all duration-700"
                    style={{
                      width: `${Math.min(100, Math.max(0, (dim.score / dim.max) * 100))}%`,
                      background: `linear-gradient(90deg, ${color}, ${color}99)`,
                      boxShadow: `0 0 8px ${color}66`,
                    }}
                  />
                </div>
              )}
              {disabled ? <p className="text-xs text-white/40">{dim.note ?? '本场未开启'}</p> : null}
              {!disabled && dim.metrics && Object.keys(dim.metrics).length > 0 && (
                <div className="flex flex-wrap gap-2 mb-3">
                  {Object.entries(dim.metrics).map(([k, v]) => (
                    <span key={k} className="glass-chip text-[10px] px-2 py-0.5 text-white/60">
                      {k}: <b className="text-white tabular-nums">{v}</b>
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
              {!disabled && dim.evidence.length === 0 && <p className="text-xs text-white/40">暂无证据引用</p>}
              {!disabled && dim.note && <p className="text-[10px] text-white/40 mt-2">{dim.note}</p>}
            </div>
          );
        })}
      </div>

      {/* 事件时间轴：纵向玻璃时间轴，阶段色发光圆点 + white/10 连接线 */}
      {eventTimeline.length > 0 && (
        <div className="mb-8">
          <h3 className="text-lg font-bold text-white mb-4">事件时间轴</h3>
          <div className="relative pl-6 space-y-3 before:content-[''] before:absolute before:left-[5px] before:top-1 before:bottom-1 before:w-px before:bg-white/10">
            {eventTimeline.map((e, i) => {
              const nodeColor = e.event_type === 'interrupt' ? '#F87171' : '#60A5FA';
              return (
                <div key={i} className="relative flex items-center gap-3 text-xs">
                  <span
                    className="absolute -left-6 w-[11px] h-[11px] rounded-full"
                    style={{ background: nodeColor, boxShadow: `0 0 8px ${nodeColor}` }}
                  />
                  <span className="font-mono text-white/40 w-12 tabular-nums">{formatTs(e.timestamp_ms)}</span>
                  <span
                    className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                      e.event_type === 'interrupt' ? 'badge-danger' : 'glass-chip text-white/70'
                    }`}
                  >
                    {e.event_type === 'interrupt' ? '打断' : e.event_type === 'stage_change' ? '阶段切换' : e.event_type}
                  </span>
                  <span className="text-white/70">
                    {e.actor} → {e.target}
                    {e.metadata && typeof e.metadata === 'object' && 'reason' in e.metadata ? `（${String(e.metadata.reason)}）` : ''}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 原话定位（点击证据定位到消息）：品牌渐变色条玻璃卡 */}
      {highlightMsgIndex !== null && messages[highlightMsgIndex] && (
        <div className="relative glass-card p-4 pl-6 mb-8">
          <div className="absolute left-3 top-4 bottom-4 w-[3px] rounded-full bg-gradient-to-b from-brand to-brand-soft" aria-hidden="true" />
          <div className="text-xs font-bold text-gradient-brand mb-1">
            定位到 {formatTs(Math.max(0, messages[highlightMsgIndex].timestamp - sessionStartAt))} 的发言
          </div>
          <p className="text-sm text-white/85">{messages[highlightMsgIndex].content}</p>
        </div>
      )}

      {/* 改进建议：编号玻璃卡 + 渐变序号大字 */}
      <div className="mb-8">
        <h3 className="text-lg font-bold text-white mb-4">改进建议</h3>
        <ul className="space-y-3">
          {report.suggestions.map((s, i) => (
            <li key={i} className="glass-card glass-card-hover flex items-start gap-4 p-4">
              <span className="text-3xl font-black text-gradient-brand tabular-nums leading-none shrink-0 w-8 text-center">
                {i + 1}
              </span>
              <p className="text-sm text-white/80 leading-relaxed">{s}</p>
            </li>
          ))}
        </ul>
      </div>

      {/* 链上证书（InterviewCertificate soulbound NFT）：仅在配置合约地址且钱包层就绪时渲染 */}
      {isCertConfigured() && wallet.configured && !wallet.isLoading && (
        <Suspense fallback={null}>
          <LazyCertificateSection report={report} />
        </Suspense>
      )}

      {/* 旧 4 字段（冗余展示，PRD D.2）：懒加载折叠面板——点击才消耗一次 LLM 调用 */}
      {(legacyData || legacyError) && (
        <details className="glass-details mb-8" open={legacyError}>
          <summary className="text-sm font-bold text-white/40 cursor-pointer hover:text-white/70 transition-colors">
            展开经典四维评价（旧版字段）▾
          </summary>
          <div className="glass-details-body grid grid-cols-1 md:grid-cols-2 gap-4 mt-3">
            {legacyError && !legacyData ? (
              <div className="glass-panel p-4 text-sm text-white/50 md:col-span-2">经典四维评价生成失败（LLM 异常），不影响上方 v1.5 报告。</div>
            ) : legacyData ? (
              <>
                <div className="glass-panel p-4 text-sm text-white/70">
                  <b className="text-white/85">发言时机：</b>
                  {legacyData.timing}
                </div>
                <div className="glass-panel p-4 text-sm text-white/70">
                  <b className="text-white/85">结构贡献：</b>
                  {legacyData.structuralContribution}
                </div>
                <div className="glass-panel p-4 text-sm text-white/70 md:col-span-2">
                  <b className="text-white/85">抗压/冲突处理：</b>
                  {legacyData.interruptionHandling}
                </div>
              </>
            ) : null}
          </div>
        </details>
      )}
      {!legacyData && loadLegacy && (
        <div className="mb-8 text-center">
          <button
            onClick={async () => {
              setLegacyLoading(true);
              setLegacyError(false);
              try {
                setLegacyData(await loadLegacy());
              } catch {
                setLegacyError(true);
              } finally {
                setLegacyLoading(false);
              }
            }}
            disabled={legacyLoading}
            className="glass-btn-ghost px-4 py-2 text-xs font-bold"
          >
            {legacyLoading ? '经典四维评价生成中…' : '展开经典四维评价（旧版字段，需一次 AI 调用）'}
          </button>
        </div>
      )}

      {/* 隐私与删除 */}
      <div className="glass-panel p-4 mb-8 text-xs text-white/50 leading-relaxed">
        隐私说明：原始音频/视频默认不保存；本报告基于转写文本与聚合特征生成。第三方 API（DeepSeek / StepFun）按隐私政策处理数据。
        {sessionId && onDeleteRecords && (
          <div className="mt-3">
            <button
              onClick={handleDelete}
              disabled={deleting || deleted}
              className="glass-btn-danger px-4 py-2 text-xs font-medium"
            >
              {deleted ? '已删除本次记录' : deleting ? '删除中...' : '删除本次记录（不可恢复）'}
            </button>
          </div>
        )}
      </div>

      {/* 主 CTA：液态玻璃大按钮 */}
      <button
        onClick={onRestart}
        className="liquid glass-btn-primary w-full py-5 text-lg font-bold"
      >
        <span className="liquid-content">再来一场</span>
      </button>
    </div>
  );
};

export default EvidenceReport;
