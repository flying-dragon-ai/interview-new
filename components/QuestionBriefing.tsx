import React, { useEffect, useState } from 'react';
import type { SimulationState } from '../types';

interface Props { state: SimulationState; topicType: string; onContinue: () => void; onBack: () => void; }

const QuestionBriefing: React.FC<Props> = ({ state, topicType, onContinue, onBack }) => {
  const [seconds, setSeconds] = useState(20);
  useEffect(() => { const timer = window.setInterval(() => setSeconds((value) => Math.max(0, value - 1)), 1000); return () => window.clearInterval(timer); }, []);
  return <div className="max-w-3xl mx-auto bg-[#f4f4f0] rounded-2xl border border-[#d8d8d2] overflow-hidden"><div className="bg-[#171717] text-white px-7 py-6"><div className="text-xs uppercase tracking-widest text-[#dfff00] font-black">题目前置页</div><h1 className="text-2xl font-black mt-2">请先读题和确认规则</h1></div><div className="p-7"><div className="flex flex-wrap gap-2 text-xs font-bold text-slate-600 mb-5"><span className="bg-white rounded-full px-3 py-1">{topicType.replaceAll('_', ' ')}</span><span className="bg-white rounded-full px-3 py-1">{state.company || '模拟练习'}</span><span className="bg-white rounded-full px-3 py-1">{state.jobTitle}</span></div><p className="text-lg leading-8 font-medium text-slate-900 whitespace-pre-wrap">{state.topic}</p><div className="mt-6 grid grid-cols-3 gap-3 text-center text-sm"><div className="bg-white rounded-xl p-3"><b className="block text-xl text-slate-900">{seconds}s</b>读题准备</div><div className="bg-white rounded-xl p-3"><b className="block text-xl text-slate-900">8</b>个阶段</div><div className="bg-white rounded-xl p-3"><b className="block text-xl text-slate-900">5</b>位参与者</div></div><div className="mt-7 flex gap-3"><button type="button" onClick={onBack} className="flex-1 rounded-xl border border-[#c9c9c1] py-3 font-bold text-slate-700">返回筛选</button><button type="button" onClick={onContinue} className="flex-[2] rounded-xl bg-[#dfff00] text-black py-3 font-black hover:bg-[#eaff66]">进入设备检测</button></div></div></div>;
};

export default QuestionBriefing;
