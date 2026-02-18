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
    <div className="bg-black px-4 pb-2 pt-2">
      <div className="max-w-4xl mx-auto relative">

        {/* iOS Settings Popover */}
        {settingsOpen && (
          <div className="absolute bottom-full left-0 right-0 mb-3 p-5 bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-2xl shadow-2xl z-20">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-[15px] font-semibold text-white flex items-center gap-2">
                <SlidersHorizontal size={14} className="text-[#007AFF]" /> Query Configuration
              </h3>
              <button
                onClick={() => setSettingsOpen(false)}
                className="text-[rgba(235,235,245,0.3)] hover:text-white bg-[#2C2C2E] p-1.5 rounded-lg transition-colors"
              >
                <X size={14} />
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[13px] text-[rgba(235,235,245,0.6)] font-medium">Context Depth</span>
                  <span className="text-[13px] font-mono text-[#007AFF]">{topK} chunks</span>
                </div>
                <input
                  type="range" min="5" max="50" value={topK}
                  onChange={(e) => onTopKChange(parseInt(e.target.value))}
                  className="w-full h-1.5 bg-[#3A3A3C] rounded-full appearance-none cursor-pointer accent-[#007AFF]"
                />
              </div>

              <div>
                <span className="text-[13px] text-[rgba(235,235,245,0.6)] font-medium block mb-2">Target Evidence Type</span>
                <select
                  value={docTypeFilter}
                  onChange={(e) => onDocTypeFilterChange(e.target.value)}
                  className="w-full bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] rounded-xl px-4 py-2 text-[13px] text-white focus:outline-none focus:ring-2 focus:ring-[#007AFF]/30 focus:border-[#007AFF]/50 transition-all"
                >
                  {DOC_TYPES.map(dt => (
                    <option key={dt.value} value={dt.value}>{dt.label}</option>
                  ))}
                </select>
              </div>

              <div>
                <span className="text-[13px] text-[rgba(235,235,245,0.6)] font-medium block mb-2">Filter by Person</span>
                <input
                  type="text"
                  value={personFilter}
                  onChange={(e) => onPersonFilterChange(e.target.value)}
                  placeholder="e.g. DOE, John"
                  className="w-full bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] rounded-xl px-4 py-2 text-[13px] text-white placeholder:text-[rgba(235,235,245,0.2)] focus:outline-none focus:ring-2 focus:ring-[#007AFF]/30 focus:border-[#007AFF]/50 transition-all"
                />
              </div>

              <div>
                <span className="text-[13px] text-[rgba(235,235,245,0.6)] font-medium block mb-2">Filter by Organization</span>
                <input
                  type="text"
                  value={orgFilter}
                  onChange={(e) => onOrgFilterChange(e.target.value)}
                  placeholder="e.g. ACME Corp"
                  className="w-full bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] rounded-xl px-4 py-2 text-[13px] text-white placeholder:text-[rgba(235,235,245,0.2)] focus:outline-none focus:ring-2 focus:ring-[#007AFF]/30 focus:border-[#007AFF]/50 transition-all"
                />
              </div>
            </div>
          </div>
        )}

        {/* Input Bar */}
        <div className="flex flex-col gap-2 bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-[22px] p-2 focus-within:border-[#007AFF]/40 transition-all">

          {hasFilters && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-1">
              {docTypeFilter && (
                <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-[#007AFF] bg-[#007AFF]/10 border border-[#007AFF]/20 px-2.5 py-1 rounded-full">
                  {DOC_TYPES.find(d => d.value === docTypeFilter)?.label}
                  <button onClick={() => onDocTypeFilterChange('')} className="hover:text-white transition-colors"><X size={10} /></button>
                </span>
              )}
              {personFilter && (
                <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-[#30D158] bg-[#30D158]/10 border border-[#30D158]/20 px-2.5 py-1 rounded-full">
                   {personFilter}
                  <button onClick={() => onPersonFilterChange('')} className="hover:text-white transition-colors"><X size={10} /></button>
                </span>
              )}
              {orgFilter && (
                <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-[#FF9F0A] bg-[#FF9F0A]/10 border border-[#FF9F0A]/20 px-2.5 py-1 rounded-full">
                  {orgFilter}
                  <button onClick={() => onOrgFilterChange('')} className="hover:text-white transition-colors"><X size={10} /></button>
                </span>
              )}
            </div>
          )}

          <div className="flex items-end gap-2 pr-1 pl-3">
            <button
              onClick={() => setSettingsOpen(!settingsOpen)}
              className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-all ${
                settingsOpen
                  ? 'bg-[#007AFF] text-white'
                  : 'hover:bg-[#2C2C2E] text-[rgba(235,235,245,0.3)] hover:text-[rgba(235,235,245,0.6)]'
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
              className="flex-1 bg-transparent text-[15px] text-white placeholder:text-[rgba(235,235,245,0.2)] resize-none focus:outline-none min-h-[36px] max-h-[160px] py-2"
            />

            <button
              onClick={onSend}
              disabled={!value.trim() || isStreaming}
              className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition-all ${
                value.trim() && !isStreaming
                  ? 'bg-[#007AFF] text-white active:scale-90'
                  : 'bg-[#3A3A3C] text-[rgba(235,235,245,0.2)] cursor-not-allowed'
              }`}
            >
              <ArrowUp size={18} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
