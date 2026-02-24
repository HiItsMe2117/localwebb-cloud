import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Search, Plus, Lock, Unlock, Trash2, Loader2, Database } from 'lucide-react';
import InvestigationSteps from './InvestigationSteps';
import type { Case, CaseEvidence, InvestigationStep } from '../types';
import { CASE_CATEGORIES } from '../types';
import axios from 'axios';

interface CaseDetailProps {
  caseId: string;
  onBack: () => void;
  onStatusChange: (caseId: string, status: string) => void;
  onDelete: (caseId: string) => void;
}

export default function CaseDetail({ caseId, onBack, onStatusChange, onDelete }: CaseDetailProps) {
  const [caseData, setCaseData] = useState<Case | null>(null);
  const [evidence, setEvidence] = useState<CaseEvidence[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isInvestigating, setIsInvestigating] = useState(false);
  const [investigationSteps, setInvestigationSteps] = useState<InvestigationStep[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [noteText, setNoteText] = useState('');
  const [isAddingNote, setIsAddingNote] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadCase();
  }, [caseId]);

  useEffect(() => {
    if (isInvestigating) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [streamingText, investigationSteps]);

  const loadCase = async () => {
    setIsLoading(true);
    try {
      const res = await axios.get(`/api/cases/${caseId}`);
      setCaseData(res.data.case);
      setEvidence(res.data.evidence || []);
    } catch (err) {
      console.error('Failed to load case:', err);
    } finally {
      setIsLoading(false);
    }
  };

  const runInvestigation = async () => {
    if (isInvestigating) return;
    setIsInvestigating(true);
    setInvestigationSteps([]);
    setStreamingText('');

    try {
      const res = await fetch(`/api/cases/${caseId}/investigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';
      let finalSources: any[] = [];
      const stepsMap = new Map<string, InvestigationStep>();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            const eventType = data.type;

            if (eventType === 'step_status') {
              stepsMap.set(data.step, { step: data.step, label: data.label, status: data.status, detail: data.detail });
              setInvestigationSteps(Array.from(stepsMap.values()));
            } else if (eventType === 'text' || (!eventType && data.text)) {
              fullText += data.text;
              setStreamingText(fullText);
            } else if (eventType === 'sources' || (!eventType && data.sources)) {
              finalSources = data.sources;
            }
          } catch {
            // skip malformed
          }
        }
      }

      // Flush remaining buffer
      if (buffer.trim()) {
        for (const line of buffer.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'text' || (!data.type && data.text)) {
              fullText += data.text;
            } else if (data.type === 'sources') {
              finalSources = data.sources;
            }
          } catch {}
        }
      }

      // Reload case to get saved evidence
      await loadCase();
    } catch (err) {
      console.error('Investigation failed:', err);
    } finally {
      setIsInvestigating(false);
      setStreamingText('');
      setInvestigationSteps([]);
    }
  };

  const addNote = async () => {
    if (!noteText.trim() || isAddingNote) return;
    setIsAddingNote(true);
    try {
      const res = await axios.post(`/api/cases/${caseId}/notes`, { content: noteText.trim() });
      setEvidence(prev => [res.data.evidence, ...prev]);
      setNoteText('');
    } catch (err) {
      console.error('Failed to add note:', err);
    } finally {
      setIsAddingNote(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 size={32} className="text-[#007AFF] animate-spin" />
      </div>
    );
  }

  if (!caseData) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center">
        <p className="text-[rgba(235,235,245,0.6)]">Case not found</p>
        <button onClick={onBack} className="mt-4 text-[#007AFF]">Go back</button>
      </div>
    );
  }

  const config = CASE_CATEGORIES[caseData.category] || CASE_CATEGORIES.other;
  const isClosed = caseData.status === 'closed';
  const confidencePct = Math.round((caseData.confidence || 0) * 100);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <header className="shrink-0 px-5 pt-4 pb-3 bg-black border-b border-[rgba(84,84,88,0.65)]">
        <div className="flex items-center gap-3 mb-3">
          <button
            onClick={onBack}
            className="w-8 h-8 rounded-full bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] flex items-center justify-center hover:bg-[#2C2C2E] transition-colors"
          >
            <ArrowLeft size={16} className="text-[rgba(235,235,245,0.6)]" />
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-[20px] font-bold text-white truncate">{caseData.title}</h1>
            <div className="flex items-center gap-2 mt-1">
              <span
                className="text-[11px] font-semibold px-2 py-0.5 rounded-full"
                style={{ backgroundColor: config.color + '20', color: config.color }}
              >
                {config.label}
              </span>
              <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                isClosed ? 'bg-[#8E8E93]/20 text-[#8E8E93]' : 'bg-[#30D158]/20 text-[#30D158]'
              }`}>
                {isClosed ? 'Closed' : 'Active'}
              </span>
              <span className="text-[11px] text-[rgba(235,235,245,0.3)] font-mono">{confidencePct}% confidence</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={runInvestigation}
            disabled={isInvestigating}
            className="flex-1 flex items-center justify-center gap-2 bg-[#007AFF] hover:bg-[#0071E3] disabled:opacity-50 px-4 py-2 rounded-xl text-[13px] font-semibold transition-colors"
          >
            {isInvestigating ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Search size={14} />
            )}
            {isInvestigating ? 'Investigating...' : 'Investigate Further'}
          </button>
          <button
            onClick={() => onStatusChange(caseId, isClosed ? 'active' : 'closed')}
            className="w-10 h-10 rounded-xl bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] flex items-center justify-center hover:bg-[#2C2C2E] transition-colors"
            title={isClosed ? 'Reopen Case' : 'Close Case'}
          >
            {isClosed ? (
              <Unlock size={16} className="text-[#30D158]" />
            ) : (
              <Lock size={16} className="text-[rgba(235,235,245,0.4)]" />
            )}
          </button>
          <button
            onClick={() => { if (confirm('Delete this case and all evidence?')) onDelete(caseId); }}
            className="w-10 h-10 rounded-xl bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] flex items-center justify-center hover:bg-[#FF453A]/20 transition-colors"
            title="Delete Case"
          >
            <Trash2 size={16} className="text-[#FF453A]" />
          </button>
        </div>
      </header>

      {/* Evidence list */}
      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {/* Case summary */}
        <div className="bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-2xl p-4">
          <h3 className="text-[11px] font-semibold text-[rgba(235,235,245,0.4)] uppercase tracking-wider mb-2">Summary</h3>
          <p className="text-[13px] text-[rgba(235,235,245,0.6)] leading-relaxed">{caseData.summary}</p>
          {caseData.entities && caseData.entities.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-3">
              {caseData.entities.map((e) => (
                <span key={e} className="text-[11px] bg-[#2C2C2E] text-[rgba(235,235,245,0.5)] px-2 py-0.5 rounded-lg">
                  {e.replace(/_/g, ' ')}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Active investigation stream */}
        {isInvestigating && (
          <div className="bg-[#1C1C1E] border border-[#007AFF]/30 rounded-2xl p-4 space-y-3">
            <div className="flex items-center gap-2">
              <Loader2 size={14} className="text-[#007AFF] animate-spin" />
              <span className="text-[13px] font-semibold text-[#007AFF]">Investigation in Progress</span>
            </div>
            {investigationSteps.length > 0 && (
              <InvestigationSteps steps={investigationSteps} />
            )}
            {streamingText && (
              <div className="text-[13px] text-[rgba(235,235,245,0.6)] whitespace-pre-wrap leading-relaxed max-h-[400px] overflow-y-auto">
                {streamingText}
              </div>
            )}
          </div>
        )}

        {/* Note input */}
        <div className="flex gap-2">
          <input
            type="text"
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addNote(); }}
            placeholder="Add a note..."
            className="flex-1 bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-xl px-4 py-2.5 text-[13px] text-white focus:outline-none focus:border-[#007AFF] transition-colors placeholder:text-[rgba(235,235,245,0.2)]"
          />
          <button
            onClick={addNote}
            disabled={!noteText.trim() || isAddingNote}
            className="w-10 h-10 rounded-xl bg-[#007AFF] disabled:opacity-30 flex items-center justify-center transition-colors"
          >
            <Plus size={18} />
          </button>
        </div>

        {/* Evidence entries */}
        {evidence.map((ev) => (
          <div key={ev.id} className="bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                ev.type === 'investigation'
                  ? 'bg-[#007AFF]/20 text-[#007AFF]'
                  : ev.type === 'note'
                    ? 'bg-[#FF9F0A]/20 text-[#FF9F0A]'
                    : 'bg-[#AF52DE]/20 text-[#AF52DE]'
              }`}>
                {ev.type === 'investigation' ? 'Investigation' : ev.type === 'note' ? 'Note' : 'Fact Check'}
              </span>
              <span className="text-[11px] text-[rgba(235,235,245,0.3)]">
                {new Date(ev.created_at).toLocaleString()}
              </span>
            </div>
            <div className={`text-[13px] leading-relaxed ${
              ev.type === 'note'
                ? 'text-[rgba(235,235,245,0.8)]'
                : 'text-[rgba(235,235,245,0.6)] whitespace-pre-wrap'
            }`}>
              {ev.content.length > 2000 ? ev.content.slice(0, 2000) + '...' : ev.content}
            </div>

            {ev.sources && ev.sources.length > 0 && (
              <div className="mt-3 pt-3 border-t border-[rgba(84,84,88,0.65)]">
                <span className="text-[11px] font-semibold text-[rgba(235,235,245,0.4)] flex items-center gap-1.5 mb-1.5">
                  <Database size={10} /> Sources
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {ev.sources.map((s, i) => (
                    <span key={i} className="text-[11px] bg-[#2C2C2E] text-[rgba(235,235,245,0.5)] px-2 py-0.5 rounded-lg">
                      {s.filename} p.{s.page}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}

        {evidence.length === 0 && !isInvestigating && (
          <div className="text-center py-10">
            <p className="text-[rgba(235,235,245,0.3)] text-[13px]">
              No evidence yet. Click "Investigate Further" to start.
            </p>
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}
