import React from 'react';
import type { PhaseDef } from '../types';

const StageNavigator: React.FC<{ phases: PhaseDef[]; currentIndex: number }> = ({ phases, currentIndex }) => (
  <div className="flex gap-1.5 overflow-x-auto pb-3 scrollbar-hide" aria-label="面试阶段导航">
    {phases.map((item, index) => <div key={item.id} className={`shrink-0 px-3 py-1.5 rounded-lg text-[11px] font-black transition-colors ${index === currentIndex ? 'bg-[#dfff00] text-slate-950' : index < currentIndex ? 'bg-slate-200 text-slate-600' : 'bg-white text-slate-500'}`}>{item.label}</div>)}
  </div>
);

export default StageNavigator;
