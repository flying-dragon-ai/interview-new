import React from 'react';

const RetryGoalCard: React.FC<{ suggestions: string[]; onRetry?: () => void }> = ({ suggestions, onRetry }) => <div className="rounded-2xl bg-lime-50 border border-lime-200 p-5"><div className="text-xs font-black tracking-widest text-lime-700 uppercase">下一次再练目标</div><ul className="mt-3 space-y-2 text-sm text-slate-700">{suggestions.slice(0, 3).map((item, index) => <li key={`${item}-${index}`} className="flex gap-2"><span className="font-black text-lime-700">0{index + 1}</span><span>{item}</span></li>)}</ul>{onRetry && <button type="button" onClick={onRetry} className="mt-4 rounded-lg bg-slate-950 text-white px-4 py-2 text-xs font-black">再练此题</button>}</div>;
export default RetryGoalCard;
