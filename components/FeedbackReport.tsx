
import React from 'react';
import { FeedbackData } from '../types';

interface FeedbackReportProps {
  feedback: FeedbackData;
  onRestart: () => void;
}

const FeedbackReport: React.FC<FeedbackReportProps> = ({ feedback, onRestart }) => {
  return (
    <div className="max-w-3xl mx-auto glass-panel p-8">
      <div className="text-center mb-10">
        <div className="glass-chip px-4 py-1 text-xs font-bold text-white/60 mb-4 inline-flex">模拟面试报告</div>
        <h2 className="text-4xl font-black text-white mb-6">面试表现评估</h2>
        <div className="flex justify-center items-center gap-6">
          <div className="flex flex-col items-center">
            <div className="text-6xl font-black text-gradient-brand tabular-nums">{feedback.overallScore}</div>
            <div className="text-[10px] text-white/40 font-bold uppercase tracking-widest mt-1">综合得分</div>
          </div>
          <div className="h-10 w-px bg-white/15"></div>
          <div className="flex flex-col items-center">
            <div className="text-6xl font-black text-emerald-300 tabular-nums">{feedback.voiceShare}%</div>
            <div className="text-[10px] text-white/40 font-bold uppercase tracking-widest mt-1">话语权占有</div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-10">
        <div className="glass-card p-5">
          <h3 className="text-sm font-bold text-white/85 flex items-center mb-3">
            <span className="w-2 h-2 bg-brand rounded-full mr-2"></span>
            发言时机
          </h3>
          <p className="text-sm text-white/70 leading-relaxed">{feedback.timing}</p>
        </div>

        <div className="glass-card p-5">
          <h3 className="text-sm font-bold text-white/85 flex items-center mb-3">
            <span className="w-2 h-2 bg-brand rounded-full mr-2"></span>
            结构贡献
          </h3>
          <p className="text-sm text-white/70 leading-relaxed">{feedback.structuralContribution}</p>
        </div>

        <div className="glass-card p-5 md:col-span-2">
          <h3 className="text-sm font-bold text-white/85 flex items-center mb-3">
            <span className="w-2 h-2 bg-brand rounded-full mr-2"></span>
            抗压/冲突处理
          </h3>
          <p className="text-sm text-white/70 leading-relaxed">{feedback.interruptionHandling}</p>
        </div>
      </div>

      <div className="mb-10">
        <h3 className="text-lg font-bold text-white mb-4">改进建议</h3>
        <ul className="space-y-3">
          {feedback.suggestions.map((s, i) => (
            <li key={i} className="glass-card flex items-start gap-4 p-4">
              <span className="text-2xl font-black text-gradient-brand tabular-nums leading-none shrink-0 w-7 text-center">{i + 1}</span>
              <p className="text-sm text-white/80 leading-relaxed">{s}</p>
            </li>
          ))}
        </ul>
      </div>

      <button
        onClick={onRestart}
        className="liquid glass-btn-primary w-full py-4 font-bold"
      >
        <span className="liquid-content">再来一场</span>
      </button>
    </div>
  );
};

export default FeedbackReport;
