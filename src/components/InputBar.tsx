import { useState, useRef, useEffect } from 'react';
import { ArrowUp, Settings2, X } from 'lucide-react';
import { DOC_TYPES } from '../types';

interface InputBarProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  isStreaming: boolean;
  topK: number;
  onTopKChange: (v: number) => void;
  docTypeFilter: string;
  onDocTypeFilterChange: (v: string) => void;
  personFilter: string;
  onPersonFilterChange: (v: string) => void;
  orgFilter: string;
  onOrgFilterChange: (v: string) => void;
}

export default function InputBar({
  value, onChange, onSend, isStreaming,
  topK, onTopKChange,
  docTypeFilter, onDocTypeFilterChange,
  personFilter, onPersonFilterChange,
  orgFilter, onOrgFilterChange,
}: InputBarProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const hasFilters = docTypeFilter || personFilter || orgFilter;

  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 160) + 'px';
    }
  }, [value]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (value.trim() && !isStreaming) onSend();
    }
  };

  return (
    <div className="border-t border-white/5 bg-[#0a0a0c]">
      <div className="max-w-3xl mx-auto px-4 py-3 relative">
        {/* Settings popover */}
        {settingsOpen && (
          <div className="absolute bottom-full left-4 right-4 mb-2 p-4 bg-[#111114] rounded-xl border border-white/10 shadow-2xl flex flex-col gap-3 z-20">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-zinc-400 font-bold uppercase tracking-wider">Query Settings</span>
              <button onClick={() => setSettingsOpen(false)} className="text-zinc-500 hover:text-white">
                <X size={14} />
              </button>
            </div>

            <div>
              <div className="flex items-center justify-between">
                <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Context Depth (top_k)</span>
                <span className="text-xs font-mono text-blue-400">{topK}</span>
              </div>
              <input
                type="range" min="5" max="50" value={topK}
                onChange={(e) => onTopKChange(parseInt(e.target.value))}
                className="w-full h-1 mt-2 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-blue-500"
              />
            </div>

            <div>
              <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Document Type</span>
              <select
                value={docTypeFilter}
                onChange={(e) => onDocTypeFilterChange(e.target.value)}
                className="w-full mt-1 bg-zinc-800 border border-white/5 rounded-lg px-3 py-1.5 text-xs text-zinc-300 focus:outline-none focus:ring-1 focus:ring-blue-500/30"
              >
                {DOC_TYPES.map(dt => (
                  <option key={dt.value} value={dt.value}>{dt.label}</option>
                ))}
              </select>
            </div>

            <div>
              <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Person Filter</span>
              <input
                type="text"
                value={personFilter}
                onChange={(e) => onPersonFilterChange(e.target.value)}
                placeholder="e.g. Jeffrey Epstein"
                className="w-full mt-1 bg-zinc-800 border border-white/5 rounded-lg px-3 py-1.5 text-xs text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500/30"
              />
            </div>

            <div>
              <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Organization Filter</span>
              <input
                type="text"
                value={orgFilter}
                onChange={(e) => onOrgFilterChange(e.target.value)}
                placeholder="e.g. JPMorgan Chase"
                className="w-full mt-1 bg-zinc-800 border border-white/5 rounded-lg px-3 py-1.5 text-xs text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-blue-500/30"
              />
            </div>

            <p className="text-[9px] text-zinc-600">Filters narrow search to matching document chunks only</p>
          </div>
        )}

        {/* Active filter chips */}
        {hasFilters && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {docTypeFilter && (
              <span className="inline-flex items-center gap-1 text-[11px] text-blue-300 bg-blue-500/10 border border-blue-500/20 px-2 py-0.5 rounded-full">
                {DOC_TYPES.find(d => d.value === docTypeFilter)?.label}
                <button onClick={() => onDocTypeFilterChange('')} className="hover:text-white"><X size={10} /></button>
              </span>
            )}
            {personFilter && (
              <span className="inline-flex items-center gap-1 text-[11px] text-emerald-300 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full">
                Person: {personFilter}
                <button onClick={() => onPersonFilterChange('')} className="hover:text-white"><X size={10} /></button>
              </span>
            )}
            {orgFilter && (
              <span className="inline-flex items-center gap-1 text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded-full">
                Org: {orgFilter}
                <button onClick={() => onOrgFilterChange('')} className="hover:text-white"><X size={10} /></button>
              </span>
            )}
          </div>
        )}

        {/* Input row */}
        <div className="flex items-end gap-2 bg-zinc-900/60 border border-white/5 rounded-xl px-3 py-2">
          <button
            onClick={() => setSettingsOpen(!settingsOpen)}
            className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-all ${
              settingsOpen ? 'bg-blue-600 text-white' : 'hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300'
            }`}
            title="Query settings"
          >
            <Settings2 size={16} />
          </button>

          <textarea
            ref={textareaRef}
            rows={1}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about connections, financial trails, or hidden patterns..."
            className="flex-1 bg-transparent text-sm text-zinc-200 placeholder:text-zinc-600 resize-none focus:outline-none min-h-[32px] max-h-[160px] py-1"
          />

          <button
            onClick={onSend}
            disabled={!value.trim() || isStreaming}
            className={`shrink-0 w-8 h-8 rounded-lg flex items-center justify-center transition-all ${
              value.trim() && !isStreaming
                ? 'bg-white text-black hover:bg-zinc-200'
                : 'bg-zinc-800 text-zinc-600 cursor-not-allowed'
            }`}
          >
            <ArrowUp size={16} />
          </button>
        </div>

        <div className="text-center mt-1.5">
          <span className="text-[9px] font-mono text-zinc-600 tracking-wider">GEMINI 2.5 PRO + GraphRAG</span>
        </div>
      </div>
    </div>
  );
}
