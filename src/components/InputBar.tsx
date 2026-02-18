import { useState, useRef, useEffect } from 'react';
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
  const [showConfig, setShowConfig] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
    <div className="border-t border-[#4169E1] bg-[#050510] p-2 font-mono text-sm shrink-0">
      <div className="max-w-4xl mx-auto flex flex-col gap-2">
        
        {/* Command Flags / Configuration */}
        <div className="flex flex-wrap items-center gap-2 text-xs text-[#2b4a9c]">
           <button 
             onClick={() => setShowConfig(!showConfig)}
             className={`px-1 border ${showConfig ? 'border-[#4169E1] text-[#4169E1]' : 'border-transparent hover:border-[#2b4a9c]'}`}
           >
             [CONFIG]
           </button>
           
           {/* Active Flags Display */}
           {!showConfig && (
             <>
               <span>--top-k={topK}</span>
               {docTypeFilter && <span>--type={docTypeFilter}</span>}
               {personFilter && <span>--person="{personFilter}"</span>}
               {orgFilter && <span>--org="{orgFilter}"</span>}
             </>
           )}
        </div>

        {/* Configuration Panel (Terminal Style) */}
        {showConfig && (
          <div className="border border-[#2b4a9c] p-2 grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
            <div>
              <label className="block text-[#4169E1] mb-1">--top-k (CONTEXT_DEPTH)</label>
              <div className="flex items-center gap-2">
                <input 
                  type="range" min="5" max="50" value={topK} 
                  onChange={(e) => onTopKChange(parseInt(e.target.value))}
                  className="accent-[#4169E1] w-full"
                />
                <span className="text-[#a4b9ef] w-6">{topK}</span>
              </div>
            </div>

            <div>
               <label className="block text-[#4169E1] mb-1">--doc-type</label>
               <select 
                 value={docTypeFilter} 
                 onChange={(e) => onDocTypeFilterChange(e.target.value)}
                 className="bg-[#050510] border border-[#2b4a9c] text-[#a4b9ef] w-full p-1 focus:outline-none focus:border-[#4169E1]"
               >
                 <option value="">* (ALL)</option>
                 {DOC_TYPES.map(dt => (
                   <option key={dt.value} value={dt.value}>{dt.label}</option>
                 ))}
               </select>
            </div>

            <div>
              <label className="block text-[#4169E1] mb-1">--person-filter</label>
              <input 
                type="text" 
                value={personFilter} 
                onChange={(e) => onPersonFilterChange(e.target.value)}
                placeholder="e.g. DOE, JOHN"
                className="bg-[#050510] border border-[#2b4a9c] text-[#a4b9ef] w-full p-1 focus:outline-none focus:border-[#4169E1] placeholder-[#2b4a9c]"
              />
            </div>

            <div>
              <label className="block text-[#4169E1] mb-1">--org-filter</label>
              <input 
                type="text" 
                value={orgFilter} 
                onChange={(e) => onOrgFilterChange(e.target.value)}
                placeholder="e.g. CORP_X"
                className="bg-[#050510] border border-[#2b4a9c] text-[#a4b9ef] w-full p-1 focus:outline-none focus:border-[#4169E1] placeholder-[#2b4a9c]"
              />
            </div>
          </div>
        )}

        {/* Command Input */}
        <div className="flex items-start gap-2">
          <span className="text-[#00ffff] py-2 mt-0.5 pointer-events-none select-none animate-pulse">{`>`}</span>
          <textarea
            ref={textareaRef}
            rows={1}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="ENTER_QUERY..."
            autoFocus
            className="flex-1 bg-transparent text-[#a4b9ef] placeholder-[#2b4a9c] resize-none focus:outline-none min-h-[40px] py-2 caret-[#00ffff]"
          />
          <button
            onClick={onSend}
            disabled={!value.trim() || isStreaming}
            className={`px-3 py-2 border ${
              value.trim() && !isStreaming
                ? 'border-[#4169E1] text-[#4169E1] hover:bg-[#4169E1] hover:text-[#050510]'
                : 'border-[#2b4a9c] text-[#2b4a9c] cursor-not-allowed opacity-50'
            } transition-colors uppercase text-xs font-bold tracking-wider`}
          >
            {isStreaming ? 'PROC...' : 'EXEC'}
          </button>
        </div>
      </div>
    </div>
  );
}
