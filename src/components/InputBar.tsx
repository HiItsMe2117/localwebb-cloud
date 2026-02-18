import { useState, useRef, useEffect } from 'react';
import { ArrowUp, Settings2, X, SlidersHorizontal } from 'lucide-react';
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
    <div className="bg-[#09090b] px-8 pb-8 pt-4">
      <div className="max-w-4xl mx-auto relative">
        
        {/* Modern Settings Popover */}
        {settingsOpen && (
          <div className="absolute bottom-full left-0 right-0 mb-4 p-6 bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl z-20 overflow-hidden ring-1 ring-white/5">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-sm font-bold text-white uppercase tracking-widest flex items-center gap-2">
                <SlidersHorizontal size={14} className="text-blue-500" /> Query Configuration
              </h3>
              <button 
                onClick={() => setSettingsOpen(false)} 
                className="text-zinc-500 hover:text-white bg-zinc-800 p-1 rounded-md transition-colors"
              >
                <X size={14} />
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Context Depth</span>
                  <span className="text-xs font-mono text-blue-400">{topK} chunks</span>
                </div>
                <input
                  type="range" min="5" max="50" value={topK}
                  onChange={(e) => onTopKChange(parseInt(e.target.value))}
                  className="w-full h-1.5 bg-zinc-800 rounded-full appearance-none cursor-pointer accent-blue-500 hover:accent-blue-400"
                />
              </div>

              <div>
                <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider block mb-2">Target Evidence Type</span>
                <select
                  value={docTypeFilter}
                  onChange={(e) => onDocTypeFilterChange(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2 text-xs text-zinc-300 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500/50 transition-all"
                >
                  {DOC_TYPES.map(dt => (
                    <option key={dt.value} value={dt.value}>{dt.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider block mb-2">Filter by Person</span>
                <input
                  type="text"
                  value={personFilter}
                  onChange={(e) => onPersonFilterChange(e.target.value)}
                  placeholder="e.g. DOE, John"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2 text-xs text-zinc-300 placeholder:text-zinc-700 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500/50 transition-all"
                />
              </div>

              <div>
                <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider block mb-2">Filter by Organization</span>
                <input
                  type="text"
                  value={orgFilter}
                  onChange={(e) => onOrgFilterChange(e.target.value)}
                  placeholder="e.g. ACME Corp"
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2 text-xs text-zinc-300 placeholder:text-zinc-700 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500/50 transition-all"
                />
              </div>
            </div>
          </div>
        )}

        {/* Input Bar */}
        <div className="flex flex-col gap-3 bg-zinc-900/50 border border-zinc-800/80 rounded-[28px] p-2.5 shadow-xl shadow-black/20 focus-within:border-zinc-700 focus-within:ring-4 focus-within:ring-blue-500/5 transition-all">
          
          {hasFilters && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-1">
              {docTypeFilter && (
                <span className="inline-flex items-center gap-1.5 text-[10px] font-bold text-blue-400 bg-blue-500/5 border border-blue-500/20 px-2.5 py-1 rounded-full uppercase tracking-widest">
                  {DOC_TYPES.find(d => d.value === docTypeFilter)?.label}
                  <button onClick={() => onDocTypeFilterChange('')} className="hover:text-white transition-colors"><X size={10} /></button>
                </span>
              )}
              {personFilter && (
                <span className="inline-flex items-center gap-1.5 text-[10px] font-bold text-emerald-400 bg-emerald-500/5 border border-emerald-500/20 px-2.5 py-1 rounded-full uppercase tracking-widest">
                   {personFilter}
                  <button onClick={() => onPersonFilterChange('')} className="hover:text-white transition-colors"><X size={10} /></button>
                </span>
              )}
              {orgFilter && (
                <span className="inline-flex items-center gap-1.5 text-[10px] font-bold text-amber-400 bg-amber-500/5 border border-amber-500/20 px-2.5 py-1 rounded-full uppercase tracking-widest">
                  {orgFilter}
                  <button onClick={() => onOrgFilterChange('')} className="hover:text-white transition-colors"><X size={10} /></button>
                </span>
              )}
            </div>
          )}

          <div className="flex items-end gap-2 pr-1 pl-3">
            <button
              onClick={() => setSettingsOpen(!settingsOpen)}
              className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center transition-all ${
                settingsOpen 
                  ? 'bg-blue-600 text-white' 
                  : 'hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300'
              }`}
              title="Query Configuration"
            >
              <Settings2 size={18} />
            </button>

            <textarea
              ref={textareaRef}
              rows={1}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Start an investigation..."
              className="flex-1 bg-transparent text-sm text-zinc-200 placeholder:text-zinc-600 resize-none focus:outline-none min-h-[36px] max-h-[160px] py-2"
            />

            <button
              onClick={onSend}
              disabled={!value.trim() || isStreaming}
              className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center transition-all ${
                value.trim() && !isStreaming
                  ? 'bg-blue-600 text-white hover:bg-blue-500 shadow-lg shadow-blue-500/20 active:scale-90'
                  : 'bg-zinc-800 text-zinc-700 cursor-not-allowed'
              }`}
            >
              <ArrowUp size={18} />
            </button>
          </div>
        </div>

        <div className="text-center mt-3">
          <span className="text-[10px] font-bold text-zinc-700 uppercase tracking-[0.2em]">Engine v2.5 // PRO+ GraphRAG</span>
        </div>
      </div>
    </div>
  );
}
