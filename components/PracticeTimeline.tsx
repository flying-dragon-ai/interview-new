import React from 'react';
import type { GameEvent } from '../types';

const labels: Record<string, string> = { stage_start: '阶段开始', stage_end: '阶段结束', stage_change: '阶段切换', speaker_start: '开始发言', speaker_end: '结束发言', interrupt: '发生打断', interviewer_prompt: '面试官提问', user_called: '用户被点名' };
const PracticeTimeline: React.FC<{ events: GameEvent[] }> = ({ events }) => <div className="space-y-2">{events.slice(-20).map((event, index) => <div key={`${event.timestamp_ms}-${index}`} className="flex gap-3 items-center text-xs"><span className="font-mono text-slate-400 w-12">{Math.floor(event.timestamp_ms / 60000).toString().padStart(2, '0')}:{Math.floor((event.timestamp_ms % 60000) / 1000).toString().padStart(2, '0')}</span><span className="w-2 h-2 rounded-full bg-lime-400 shrink-0" /><span className="text-slate-700">{labels[event.event_type] ?? event.event_type}</span><span className="text-slate-400">{event.actor}</span></div>)}</div>;
export default PracticeTimeline;
