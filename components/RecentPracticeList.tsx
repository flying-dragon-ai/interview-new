import React, { useEffect, useState } from 'react';
import { getPracticeHistory } from '../src/api';

export interface RecentItem { questionId?: string; topic: string; jobTitle: string; company?: string; topicType: string; status?: string; score?: number; startedAt?: number; }

interface Props { onRetry?: (item: RecentItem) => void; }

const RecentPracticeList: React.FC<Props> = ({ onRetry }) => {
  const [items, setItems] = useState<RecentItem[]>([]);
  useEffect(() => {
    let active = true;
    const load = async () => {
      let local: RecentItem[] = [];
      try { local = JSON.parse(localStorage.getItem('lgd-practice-history') || '[]'); } catch { local = []; }
      const remote = await getPracticeHistory();
      const remoteItems: RecentItem[] = remote.map((item) => ({ questionId: String(item.id), topic: item.topic, company: item.company, jobTitle: item.job_title, topicType: item.topic_type ?? 'business_case', status: item.status === 'FINISHED' ? 'finished' : item.status === 'INTERRUPTED' ? 'interrupted' : 'in_progress' }));
      const merged = [...local, ...remoteItems].filter((item, index, all) => index === all.findIndex((other) => other.topic === item.topic && other.jobTitle === item.jobTitle));
      if (active) setItems(merged.slice(0, 5));
    };
    void load();
    return () => { active = false; };
  }, []);
  if (!items.length) return <div className="text-sm text-slate-400">还没有练习记录，完成第一场群面后会显示在这里。</div>;
  const scores = items.filter((item) => typeof item.score === 'number').map((item) => item.score as number);
  const average = scores.length ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length) : null;
  return <div><div className="flex items-center gap-3 mb-3 text-xs text-slate-500">累计练习 {items.length} 次{average !== null && <><span>·</span><span>平均表现 {average} 分</span></>}</div><div className="space-y-2">{items.map((item, index) => <div key={`${item.questionId}-${index}`} className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 px-3 py-2.5 bg-white"><div className="min-w-0"><div className="text-sm font-bold text-slate-800 truncate">{item.topic}</div><div className="text-[11px] text-slate-400 mt-1">{item.jobTitle} · {item.status === 'finished' ? `已完成${typeof item.score === 'number' ? ` · ${item.score} 分` : ''}` : item.status === 'interrupted' ? '已中断' : '进行中'}</div></div>{onRetry && <button type="button" onClick={() => onRetry(item)} className="shrink-0 text-xs font-bold text-slate-700 hover:text-blue-600">再练此题</button>}</div>)}</div></div>;
};

export default RecentPracticeList;
