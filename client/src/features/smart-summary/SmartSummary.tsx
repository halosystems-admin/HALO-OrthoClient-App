import React, { useState } from 'react';
import { Sparkles, Loader2, ChevronDown, ChevronUp, Info } from 'lucide-react';

interface Props {
  summary: string[];
  loading: boolean;
}

export const SmartSummary: React.FC<Props> = ({ summary, loading }) => {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="bg-sky-50 border border-sky-100 rounded-lg shadow-sm overflow-hidden">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center justify-between gap-2 p-4 hover:bg-sky-100/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-sky-600" />
          <h3 className="font-semibold text-sky-900">HALO Smart Summary</h3>
        </div>
        {collapsed ? (
          <ChevronDown className="w-4 h-4 text-sky-600" />
        ) : (
          <ChevronUp className="w-4 h-4 text-sky-600" />
        )}
      </button>

      {!collapsed && (
        <div className="px-4 pb-4">
          {loading ? (
            <div className="flex items-center gap-2 text-sky-700 py-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="text-sm">Analyzing patient history...</span>
            </div>
          ) : summary.length > 0 ? (
            <>
              <ul className="space-y-2">
                {summary.map((item, idx) => (
                  <li key={idx} className="flex items-start gap-2 text-sm text-slate-700">
                    <span className="block w-1.5 h-1.5 mt-1.5 rounded-full bg-sky-400 shrink-0" />
                    {item}
                  </li>
                ))}
              </ul>
              <div className="flex items-center gap-1.5 mt-3 pt-2.5 border-t border-sky-100">
                <Info className="w-3 h-3 text-sky-400 shrink-0" />
                <span className="text-[10px] text-sky-500">AI-generated from available records — verify against source documents.</span>
              </div>
            </>
          ) : (
            <p className="text-sm text-slate-500 italic">No summary available.</p>
          )}
        </div>
      )}
    </div>
  );
};
