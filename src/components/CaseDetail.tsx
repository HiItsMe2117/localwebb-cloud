import { useState, useEffect, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import { ArrowLeft, Search, Plus, Lock, Unlock, Trash2, Loader2, Database, Wand2, Share2, FileText, Copy, CheckSquare, Square, X, Pencil, Check, FlaskConical, Globe, Network, Calendar, ChevronRight, FolderOpen, Lightbulb } from 'lucide-react';
import InvestigationSteps from './InvestigationSteps';
import CaseNetworkMap from './CaseNetworkMap';
import CaseTimeline from './CaseTimeline';
import type { Case, CaseEvidence, InvestigationStep } from '../types';
import { CASE_CATEGORIES } from '../types';
import axios from 'axios';
import { getFileUrl } from '../utils/files';

interface BreadcrumbItem {
  id: string;
  title: string;
}

interface CaseChild {
  id: string;
  title: string;
  category: string;
  summary: string;
  status: string;
  depth: number;
  entity_count: number;
  evidence_count: number;
  timeline_count: number;
}

interface CaseDetailProps {
  caseId: string;
  onBack: (navigateToCaseId?: string) => void;
  onStatusChange: (caseId: string, status: string) => void;
  onUpdate: (caseId: string, fields: Partial<Pick<Case, 'title' | 'category' | 'summary' | 'is_public'>>) => Promise<void>;
  onDelete: (caseId: string) => void;
  onTheoryInvestigate?: (theory: string, mode: 'files_only' | 'files_web') => void;
  isTestingTheory?: boolean;
  theorySteps?: InvestigationStep[];
  theoryReportText?: string;
  readOnly?: boolean;
}

function EvidenceText({ content }: { content: string }) {
  // Regex to match [Source: EFTA02731069.pdf, Page: 6]
  const sourceRegex = /\[Source:\s*([^,]+),\s*Page:\s*([^\]]+)\]/g;
  const parts = [];
  let lastIndex = 0;
  let match;

  while ((match = sourceRegex.exec(content)) !== null) {
    // Add text before match
    if (match.index > lastIndex) {
      parts.push(content.substring(lastIndex, match.index));
    }

    const filename = match[1].trim();
    const page = match[2].trim();
    const url = getFileUrl(filename, page);

    parts.push(
      <a
        key={match.index}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[#007AFF]/10 text-[#007AFF] hover:bg-[#007AFF]/20 transition-colors font-medium border border-[#007AFF]/20 mx-0.5"
      >
        <Database size={10} />
        {filename} (p.{page})
      </a>
    );

    lastIndex = sourceRegex.lastIndex;
  }

  // Add remaining text
  if (lastIndex < content.length) {
    parts.push(content.substring(lastIndex));
  }

  return (
    <div className="whitespace-pre-wrap leading-relaxed">
      {parts.length > 0 ? parts : content}
    </div>
  );
}

export default function CaseDetail({ caseId, onBack, onStatusChange, onUpdate, onDelete, onTheoryInvestigate, isTestingTheory = false, theorySteps = [], theoryReportText = '', readOnly = false }: CaseDetailProps) {
  const [caseData, setCaseData] = useState<Case | null>(null);
  const [evidence, setEvidence] = useState<CaseEvidence[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isInvestigating, setIsInvestigating] = useState(false);
  const [investigationSteps, setInvestigationSteps] = useState<InvestigationStep[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [noteText, setNoteText] = useState('');
  const [isAddingNote, setIsAddingNote] = useState(false);
  const [isConsolidating, setIsConsolidating] = useState(false);
  const [isRefreshingBP, setIsRefreshingBP] = useState(false);
  const [detailTab, setDetailTab] = useState<'evidence' | 'timeline' | 'network'>('evidence');
  const [selectedCards, setSelectedCards] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [editingNoteText, setEditingNoteText] = useState('');
  const [isSavingNote, setIsSavingNote] = useState(false);
  const [isEditingCase, setIsEditingCase] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [editSummary, setEditSummary] = useState('');
  const [isSavingCase, setIsSavingCase] = useState(false);
  const [showTheoryForm, setShowTheoryForm] = useState(false);
  const [theoryText, setTheoryText] = useState('');
  const [theoryMode, setTheoryMode] = useState<'files_only' | 'files_web'>('files_only');
  const [discoveredHubs, setDiscoveredHubs] = useState<any[]>([]);
  const [breadcrumb, setBreadcrumb] = useState<BreadcrumbItem[]>([]);
  const [children, setChildren] = useState<CaseChild[]>([]);
  const [evidenceLimit, setEvidenceLimit] = useState(10);
  const bottomRef = useRef<HTMLDivElement>(null);

  const autoResize = useCallback((el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }, []);

  useEffect(() => {
    loadCase();
  }, [caseId]);

  useEffect(() => {
    if (isInvestigating && streamingText.length % 50 === 0) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [streamingText, investigationSteps, isInvestigating]);

  const loadCase = async () => {
    setIsLoading(true);
    try {
      const res = await axios.get(`/api/cases/${caseId}`);
      setCaseData(res.data.case);
      setEvidence(res.data.evidence || []);
      setBreadcrumb(res.data.breadcrumb || []);
      setChildren(res.data.children || []);
      setEvidenceLimit(10);
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

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180_000);
    try {
      const res = await fetch(`/api/cases/${caseId}/investigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(axios.defaults.headers.common['Authorization'] ? { Authorization: axios.defaults.headers.common['Authorization'] as string } : {}) },
        signal: controller.signal,
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';
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
            } else if (eventType === 'structural_hubs_discovered') {
              setDiscoveredHubs(data.hubs || []);
            } else if (eventType === 'text' || (!eventType && data.text)) {
              fullText += data.text;
              setStreamingText(fullText);
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
            }
          } catch {}
        }
      }

      // Reload case to get saved evidence
      await loadCase();
    } catch (err: any) {
      console.error('Investigation failed:', err);
      toast.error(err.name === 'AbortError' ? 'Investigation timed out' : 'Investigation failed');
    } finally {
      clearTimeout(timeout);
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
      toast.error('Failed to add note');
    } finally {
      setIsAddingNote(false);
    }
  };

  const saveNote = async (evidenceId: string) => {
    if (!editingNoteText.trim() || isSavingNote) return;
    setIsSavingNote(true);
    try {
      const res = await axios.patch(`/api/cases/${caseId}/evidence/${evidenceId}`, { content: editingNoteText.trim() });
      setEvidence(prev => prev.map(ev => ev.id === evidenceId ? res.data.evidence : ev));
      setEditingNoteId(null);
      setEditingNoteText('');
    } catch (err) {
      console.error('Failed to save note:', err);
      toast.error('Failed to save note');
    } finally {
      setIsSavingNote(false);
    }
  };

  const consolidateEvidence = async () => {
    if (isConsolidating || evidence.length < 2) return;
    setIsConsolidating(true);
    try {
      const res = await axios.post(`/api/cases/${caseId}/consolidate`);
      setEvidence(prev => [res.data.evidence, ...prev]);
      // Scroll to top of list
    } catch (err) {
      console.error('Consolidation failed:', err);
      toast.error('Report synthesis failed');
    } finally {
      setIsConsolidating(false);
    }
  };

  const refreshBiggerPicture = async () => {
    setIsRefreshingBP(true);
    try {
      const res = await axios.post('/api/cases/bigger-picture/synthesize');
      setEvidence(prev => [res.data.evidence, ...prev]);
      toast.success('Bigger picture updated');
    } catch (err) {
      console.error('Refresh failed:', err);
      toast.error('Synthesis failed');
    } finally {
      setIsRefreshingBP(false);
    }
  };

  const startEditingCase = () => {
    if (!caseData) return;
    setEditTitle(caseData.title);
    setEditCategory(caseData.category);
    setEditSummary(caseData.summary || '');
    setIsEditingCase(true);
  };

  const saveCase = async () => {
    if (!caseData || isSavingCase) return;
    const fields: Partial<Pick<Case, 'title' | 'category' | 'summary'>> = {};
    if (editTitle.trim() && editTitle.trim() !== caseData.title) fields.title = editTitle.trim();
    if (editCategory !== caseData.category) fields.category = editCategory;
    if (editSummary.trim() !== (caseData.summary || '')) fields.summary = editSummary.trim();
    if (Object.keys(fields).length === 0) {
      setIsEditingCase(false);
      return;
    }
    setIsSavingCase(true);
    try {
      await onUpdate(caseId, fields);
      setCaseData(prev => prev ? { ...prev, ...fields } : prev);
      setIsEditingCase(false);
    } catch (err) {
      console.error('Failed to save case:', err);
      toast.error('Failed to save case');
    } finally {
      setIsSavingCase(false);
    }
  };

  const toggleCard = (id: string) => {
    setSelectedCards(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setCopied(false);
  };

  const copySelected = async () => {
    const selected = evidence.filter(ev => selectedCards.has(ev.id));
    const text = selected.map(ev => {
      const typeLabel = ev.type === 'investigation' ? 'Investigation' : ev.type === 'note' ? 'Note' : 'Consolidated Report';
      const date = new Date(ev.created_at).toLocaleString();
      return `[${typeLabel} — ${date}]\n${ev.content}`;
    }).join('\n\n---\n\n');
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
        <button onClick={() => onBack()} className="mt-4 text-[#007AFF]">Go back</button>
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
            onClick={() => onBack()}
            className="w-8 h-8 rounded-full bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] flex items-center justify-center hover:bg-[#2C2C2E] transition-colors"
          >
            <ArrowLeft size={16} className="text-[rgba(235,235,245,0.6)]" />
          </button>
          <div className="flex-1 min-w-0">
            {isEditingCase ? (
              <div className="space-y-2">
                <input
                  type="text"
                  value={editTitle}
                  onChange={e => setEditTitle(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') saveCase(); if (e.key === 'Escape') setIsEditingCase(false); }}
                  autoFocus
                  className="w-full bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] rounded-lg px-3 py-1.5 text-[18px] font-bold text-white focus:outline-none focus:border-[#007AFF] transition-colors"
                />
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(CASE_CATEGORIES).map(([key, cfg]) => (
                    <button
                      key={key}
                      onClick={() => setEditCategory(key)}
                      className={`text-[11px] font-semibold px-2.5 py-1 rounded-full transition-colors ${
                        editCategory === key
                          ? 'ring-2 ring-offset-1 ring-offset-black'
                          : 'opacity-50 hover:opacity-80'
                      }`}
                      style={{
                        backgroundColor: cfg.color + '20',
                        color: cfg.color,
                      }}
                    >
                      {cfg.label}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setIsEditingCase(false)}
                    className="px-3 py-1.5 rounded-lg text-[12px] text-[rgba(235,235,245,0.4)] hover:text-[rgba(235,235,245,0.6)] hover:bg-[#2C2C2E] transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={saveCase}
                    disabled={!editTitle.trim() || isSavingCase}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-[#007AFF] hover:bg-[#0071E3] disabled:opacity-30 text-[12px] font-semibold transition-colors"
                  >
                    {isSavingCase ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                    Save
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <h1 className="text-[20px] font-bold text-white truncate">{caseData.title}</h1>
                  {!readOnly && (
                    <button
                      onClick={startEditingCase}
                      className="shrink-0 p-1 rounded-lg hover:bg-[#2C2C2E] transition-colors"
                      title="Edit case"
                    >
                      <Pencil size={14} className="text-[rgba(235,235,245,0.3)] hover:text-[rgba(235,235,245,0.6)]" />
                    </button>
                  )}
                </div>
                {breadcrumb.length > 1 && (
                  <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                    {breadcrumb.slice(0, -1).map((crumb) => (
                      <span key={crumb.id} className="flex items-center gap-1">
                        <button
                          onClick={() => onBack(crumb.id)}
                          className="text-[11px] text-[#007AFF] hover:underline truncate max-w-[120px]"
                          title={crumb.title}
                        >
                          {crumb.title}
                        </button>
                        <ChevronRight size={10} className="text-[rgba(235,235,245,0.2)]" />
                      </span>
                    ))}
                    <span className="text-[11px] text-[rgba(235,235,245,0.3)] truncate max-w-[120px]">
                      {breadcrumb[breadcrumb.length - 1].title}
                    </span>
                  </div>
                )}
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
              </>
            )}
          </div>
        </div>

        {!readOnly && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={runInvestigation}
              disabled={isInvestigating || isConsolidating || isTestingTheory}
              className="flex-1 min-w-0 flex items-center justify-center gap-2 bg-[#007AFF] hover:bg-[#0071E3] disabled:opacity-50 px-4 py-2 rounded-xl text-[13px] font-semibold transition-colors"
            >
              {isInvestigating ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Search size={14} />
              )}
              <span className="hidden sm:inline">{isInvestigating ? 'Investigating...' : 'Investigate Further'}</span>
            </button>

            <button
              onClick={consolidateEvidence}
              disabled={isConsolidating || isInvestigating || isTestingTheory || evidence.length < 2}
              className="flex items-center justify-center gap-2 bg-[#AF52DE] hover:bg-[#9642C0] disabled:opacity-30 px-4 py-2 rounded-xl text-[13px] font-semibold transition-colors text-white"
              title="Synthesize all findings into one master report"
            >
              {isConsolidating ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Wand2 size={14} />
              )}
              <span className="hidden sm:inline">{isConsolidating ? 'Synthesizing...' : 'Synthesize Report'}</span>
            </button>

            {caseData?.category === 'bigger_picture' && (
              <button
                onClick={refreshBiggerPicture}
                disabled={isRefreshingBP || isInvestigating}
                className="flex items-center justify-center gap-2 bg-[#FFD60A] hover:bg-[#FFD60A]/80 text-black px-4 py-2 rounded-xl text-[13px] font-semibold transition-colors disabled:opacity-30"
                title="Re-synthesize findings from all your active cases"
              >
                {isRefreshingBP ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Lightbulb size={14} />
                )}
                <span className="hidden sm:inline">{isRefreshingBP ? 'Refreshing...' : 'Refresh Synthesis'}</span>
              </button>
            )}

            {onTheoryInvestigate && (
              <button
                onClick={() => setShowTheoryForm(v => !v)}
                disabled={isInvestigating || isConsolidating || isTestingTheory}
                className={`flex items-center justify-center gap-2 px-4 py-2 rounded-xl text-[13px] font-semibold transition-colors disabled:opacity-30 ${
                  showTheoryForm
                    ? 'bg-[#FF9F0A] text-white'
                    : 'bg-[#FF9F0A]/20 text-[#FF9F0A] hover:bg-[#FF9F0A]/30'
                }`}
                title="Test a theory against the evidence corpus"
              >
                {isTestingTheory ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <FlaskConical size={14} />
                )}
                <span className="hidden sm:inline">{isTestingTheory ? 'Testing...' : 'Test Theory'}</span>
              </button>
            )}

            <button
              onClick={() => onUpdate(caseId, { is_public: !caseData.is_public })}
              className={`w-10 h-10 rounded-xl border flex items-center justify-center transition-colors ${
                caseData.is_public 
                  ? 'bg-[#30D158]/10 border-[#30D158]/30 text-[#30D158]' 
                  : 'bg-[#1C1C1E] border-[rgba(84,84,88,0.65)] text-[rgba(235,235,245,0.4)] hover:bg-[#2C2C2E]'
              }`}
              title={caseData.is_public ? 'Make Private' : 'Make Public'}
            >
              <Globe size={16} />
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
        )}
      </header>

      {/* Tab bar */}
      <div className="shrink-0 flex bg-black border-b border-[rgba(84,84,88,0.65)]">
        <button
          onClick={() => setDetailTab('evidence')}
          className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-[13px] font-semibold transition-colors relative ${
            detailTab === 'evidence'
              ? 'text-[#007AFF]'
              : 'text-[rgba(235,235,245,0.4)] hover:text-[rgba(235,235,245,0.6)]'
          }`}
        >
          <FileText size={14} />
          Evidence
          {detailTab === 'evidence' && (
            <div className="absolute bottom-0 left-4 right-4 h-[2px] bg-[#007AFF] rounded-full" />
          )}
        </button>
        <button
          onClick={() => setDetailTab('timeline')}
          className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-[13px] font-semibold transition-colors relative ${
            detailTab === 'timeline'
              ? 'text-[#007AFF]'
              : 'text-[rgba(235,235,245,0.4)] hover:text-[rgba(235,235,245,0.6)]'
          }`}
        >
          <Calendar size={14} />
          Timeline
          {detailTab === 'timeline' && (
            <div className="absolute bottom-0 left-4 right-4 h-[2px] bg-[#007AFF] rounded-full" />
          )}
        </button>
        <button
          onClick={() => setDetailTab('network')}
          className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-[13px] font-semibold transition-colors relative ${
            detailTab === 'network'
              ? 'text-[#007AFF]'
              : 'text-[rgba(235,235,245,0.4)] hover:text-[rgba(235,235,245,0.6)]'
          }`}
        >
          <Share2 size={14} />
          Network
          {detailTab === 'network' && (
            <div className="absolute bottom-0 left-4 right-4 h-[2px] bg-[#007AFF] rounded-full" />
          )}
        </button>
      </div>

      {/* Tab content */}
      {detailTab === 'network' ? (
        <CaseNetworkMap caseId={caseId} caseEntities={caseData.entities || []} readOnly={readOnly} />
      ) : detailTab === 'timeline' ? (
        <CaseTimeline caseId={caseId} readOnly={readOnly} />
      ) : (
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 pb-32">
          {/* Case summary */}
          <div className="bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-2xl p-4">
            <h3 className="text-[11px] font-semibold text-[rgba(235,235,245,0.4)] uppercase tracking-wider mb-2">Summary</h3>
            {isEditingCase ? (
              <textarea
                value={editSummary}
                onChange={e => setEditSummary(e.target.value)}
                rows={4}
                className="w-full bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] rounded-xl px-3 py-2 text-[13px] text-white focus:outline-none focus:border-[#007AFF] transition-colors resize-none leading-relaxed"
                placeholder="Case summary..."
              />
            ) : (
              <p className="text-[13px] text-[rgba(235,235,245,0.6)] leading-relaxed">{caseData.summary}</p>
            )}
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

          {/* Sub-cases */}
          {children.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-[11px] font-semibold text-[rgba(235,235,245,0.4)] uppercase tracking-wider flex items-center gap-1.5">
                <FolderOpen size={12} />
                Sub-cases ({children.length})
              </h3>
              <div className="grid gap-2">
                {children.map((child) => {
                  const childConfig = CASE_CATEGORIES[child.category] || CASE_CATEGORIES.other;
                  return (
                    <button
                      key={child.id}
                      onClick={() => onBack(child.id)}
                      className="w-full text-left bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-xl p-3 hover:bg-[#2C2C2E] hover:border-[rgba(84,84,88,0.9)] transition-all group"
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <span
                          className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                          style={{ backgroundColor: childConfig.color + '20', color: childConfig.color }}
                        >
                          {childConfig.label}
                        </span>
                        <span className="text-[13px] font-semibold text-white group-hover:text-[#007AFF] transition-colors truncate">
                          {child.title}
                        </span>
                        <ChevronRight size={14} className="ml-auto shrink-0 text-[rgba(235,235,245,0.2)] group-hover:text-[#007AFF] transition-colors" />
                      </div>
                      {child.summary && (
                        <p className="text-[11px] text-[rgba(235,235,245,0.4)] line-clamp-2 mb-1.5">{child.summary}</p>
                      )}
                      <div className="flex items-center gap-3 text-[10px] text-[rgba(235,235,245,0.3)]">
                        <span>{child.entity_count} entities</span>
                        <span>{child.evidence_count} evidence</span>
                        <span>{child.timeline_count} events</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

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
                <div className="text-[13px] text-[rgba(235,235,245,0.6)] whitespace-pre-wrap leading-relaxed">
                  {streamingText}
                </div>
              )}
            </div>
          )}

          {/* Discovered Structural Hubs */}
          {discoveredHubs.length > 0 && (
            <div className="bg-[#1C1C1E] border border-[#AF52DE]/30 rounded-2xl p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Network size={14} className="text-[#AF52DE]" />
                <span className="text-[13px] font-semibold text-[#AF52DE]">Structural Hubs Discovered</span>
              </div>
              <p className="text-[11px] text-[rgba(235,235,245,0.4)]">
                The investigation identified these entities as potential 'infrastructures of protection' (banks, law firms, locations) connecting multiple actors in this case.
              </p>
              <div className="flex flex-wrap gap-2">
                {discoveredHubs.map((hub: any, idx: number) => (
                  <div key={idx} className="bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] rounded-xl p-3 flex flex-col gap-1 w-full sm:w-[calc(50%-0.25rem)]">
                    <div className="flex items-center justify-between">
                      <span className="text-[13px] font-semibold text-white truncate">{hub.label || hub.id}</span>
                      <span className="text-[10px] uppercase tracking-wider font-bold text-[#AF52DE] bg-[#AF52DE]/10 px-1.5 py-0.5 rounded-md">
                        {hub.type || 'ORGANIZATION'}
                      </span>
                    </div>
                    {hub.connected_start_nodes && hub.connected_start_nodes.length > 0 && (
                      <div className="text-[11px] text-[rgba(235,235,245,0.4)] mt-1">
                        <span className="font-medium text-[rgba(235,235,245,0.6)]">Connects:</span> {hub.connected_start_nodes.map((n: any) => n.replace(/_/g, ' ')).join(', ')}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Theory form */}
          {showTheoryForm && !isTestingTheory && onTheoryInvestigate && (
            <div className="bg-[#1C1C1E] border border-[#FF9F0A]/30 rounded-2xl p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-[13px] font-semibold text-white flex items-center gap-2">
                  <FlaskConical size={14} className="text-[#FF9F0A]" />
                  Test a Theory
                </h3>
                <button onClick={() => setShowTheoryForm(false)} className="p-1 hover:bg-[#2C2C2E] rounded-lg">
                  <X size={14} className="text-[rgba(235,235,245,0.4)]" />
                </button>
              </div>
              <p className="text-[11px] text-[rgba(235,235,245,0.4)]">
                Describe a theory to test against the evidence corpus. This case's data will be cross-referenced automatically.
              </p>

              {/* Mode Toggle */}
              <div className="flex items-center gap-3">
                <p className="text-[11px] text-[rgba(235,235,245,0.4)] font-medium">Source Scope</p>
                <div className="inline-flex bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] rounded-lg p-0.5">
                  <button
                    onClick={() => setTheoryMode('files_only')}
                    className={`flex items-center gap-1 px-3 py-0.5 rounded-md text-[10px] font-medium transition-all ${
                      theoryMode === 'files_only'
                        ? 'bg-[#3A3A3C] text-white shadow-sm'
                        : 'text-[rgba(235,235,245,0.4)] hover:text-[rgba(235,235,245,0.6)]'
                    }`}
                  >
                    <Database size={12} />
                    Files Only
                  </button>
                  <button
                    onClick={() => setTheoryMode('files_web')}
                    className={`flex items-center gap-1 px-3 py-0.5 rounded-md text-[10px] font-medium transition-all ${
                      theoryMode === 'files_web'
                        ? 'bg-[#FF9F0A]/20 text-[#FF9F0A] shadow-sm'
                        : 'text-[rgba(235,235,245,0.4)] hover:text-[rgba(235,235,245,0.6)]'
                    }`}
                  >
                    <Globe size={12} />
                    Files + Web
                  </button>
                </div>
              </div>

              <textarea
                value={theoryText}
                onChange={e => setTheoryText(e.target.value)}
                placeholder="e.g., 'Epstein was funneling money through Deutsche Bank to fund VI properties'"
                rows={3}
                className="w-full bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] rounded-xl px-4 py-2.5 text-[13px] text-white focus:outline-none focus:border-[#FF9F0A] transition-colors placeholder:text-[rgba(235,235,245,0.2)] resize-none"
              />
              <button
                onClick={() => {
                  if (theoryText.trim()) {
                    onTheoryInvestigate(theoryText.trim(), theoryMode);
                    setShowTheoryForm(false);
                    setTheoryText('');
                  }
                }}
                disabled={!theoryText.trim()}
                className="w-full flex items-center justify-center gap-2 bg-[#FF9F0A] hover:bg-[#E08E09] disabled:opacity-30 px-4 py-2.5 rounded-xl text-[13px] font-semibold text-black transition-colors"
              >
                <FlaskConical size={14} />
                Investigate Theory
              </button>
            </div>
          )}

          {/* Theory investigation progress */}
          {isTestingTheory && (
            <div className="bg-[#1C1C1E] border border-[#FF9F0A]/30 rounded-2xl p-4 space-y-3">
              <div className="flex items-center gap-2">
                <Loader2 size={14} className="text-[#FF9F0A] animate-spin" />
                <span className="text-[13px] font-semibold text-[#FF9F0A]">Theory Investigation in Progress</span>
              </div>
              {theorySteps.length > 0 && (
                <InvestigationSteps steps={theorySteps} />
              )}
              {theoryReportText && (
                <div className="text-[13px] text-[rgba(235,235,245,0.6)] whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto mt-3 border-t border-[rgba(84,84,88,0.35)] pt-3">
                  {theoryReportText}
                </div>
              )}
            </div>
          )}

          {/* Note input */}
          {!readOnly && (
            <div className="flex items-end gap-2">
              <textarea
                value={noteText}
                onChange={(e) => { setNoteText(e.target.value); autoResize(e.target); }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addNote(); } }}
                placeholder="Add a note..."
                rows={1}
                ref={(el) => { if (el) autoResize(el); }}
                className="flex-1 bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-xl px-4 py-2.5 text-[13px] text-white focus:outline-none focus:border-[#007AFF] transition-colors placeholder:text-[rgba(235,235,245,0.2)] resize-none overflow-hidden"
              />
              <button
                onClick={addNote}
                disabled={!noteText.trim() || isAddingNote}
                className="w-10 h-10 shrink-0 rounded-xl bg-[#007AFF] disabled:opacity-30 flex items-center justify-center transition-colors"
              >
                <Plus size={18} />
              </button>
            </div>
          )}

          {/* Evidence entries (paginated) */}
          {evidence.slice(0, evidenceLimit).map((ev) => {
            const isSelected = selectedCards.has(ev.id);
            return (
              <div
                key={ev.id}
                className={`bg-[#1C1C1E] border rounded-2xl p-4 transition-all ${
                  isSelected
                    ? 'border-[#007AFF] ring-1 ring-[#007AFF]/30'
                    : ev.type === 'fact_check'
                      ? 'border-[#AF52DE]/50 ring-1 ring-[#AF52DE]/20'
                      : 'border-[rgba(84,84,88,0.65)]'
                }`}
              >
                <div className="flex items-center gap-2 mb-2">
                  <button
                    onClick={() => toggleCard(ev.id)}
                    className="shrink-0 p-0.5 rounded hover:bg-[#2C2C2E] transition-colors"
                  >
                    {isSelected
                      ? <CheckSquare size={16} className="text-[#007AFF]" />
                      : <Square size={16} className="text-[rgba(235,235,245,0.2)] hover:text-[rgba(235,235,245,0.4)]" />
                    }
                  </button>
                  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
                    ev.type === 'investigation'
                      ? 'bg-[#007AFF]/20 text-[#007AFF]'
                      : ev.type === 'note'
                        ? 'bg-[#FF9F0A]/20 text-[#FF9F0A]'
                        : 'bg-[#AF52DE]/20 text-[#AF52DE]'
                  }`}>
                    {ev.type === 'investigation' ? 'Investigation' : ev.type === 'note' ? 'Note' : 'Consolidated Report'}
                  </span>
                  <span className="text-[11px] text-[rgba(235,235,245,0.3)]">
                    {new Date(ev.created_at).toLocaleString()}
                  </span>
                  <div className="flex-1" />
                  {ev.type === 'note' && editingNoteId !== ev.id && (
                    <button
                      onClick={() => { setEditingNoteId(ev.id); setEditingNoteText(ev.content); }}
                      className="p-1 rounded hover:bg-[#2C2C2E] transition-colors"
                      title="Edit note"
                    >
                      <Pencil size={12} className="text-[rgba(235,235,245,0.3)] hover:text-[rgba(235,235,245,0.6)]" />
                    </button>
                  )}
                </div>
                {editingNoteId === ev.id ? (
                  <div className="space-y-2">
                    <textarea
                      value={editingNoteText}
                      onChange={(e) => { setEditingNoteText(e.target.value); autoResize(e.target); }}
                      ref={(el) => { if (el) { el.focus(); autoResize(el); } }}
                      className="w-full bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] rounded-xl px-3 py-2 text-[13px] text-white focus:outline-none focus:border-[#007AFF] transition-colors resize-none overflow-hidden"
                      rows={1}
                      onKeyDown={(e) => { if (e.key === 'Enter' && e.metaKey) saveNote(ev.id); }}
                    />
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => { setEditingNoteId(null); setEditingNoteText(''); }}
                        className="px-3 py-1 rounded-lg text-[12px] text-[rgba(235,235,245,0.4)] hover:text-[rgba(235,235,245,0.6)] hover:bg-[#2C2C2E] transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={() => saveNote(ev.id)}
                        disabled={!editingNoteText.trim() || isSavingNote}
                        className="flex items-center gap-1 px-3 py-1 rounded-lg bg-[#007AFF] hover:bg-[#0071E3] disabled:opacity-30 text-[12px] font-semibold transition-colors"
                      >
                        {isSavingNote ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                        Save
                      </button>
                    </div>
                  </div>
                ) : (
                <div className={`text-[13px] ${
                  ev.type === 'note'
                    ? 'text-[rgba(235,235,245,0.8)]'
                    : 'text-[rgba(235,235,245,0.6)]'
                }`}>
                  <EvidenceText content={ev.content} />
                </div>
                )}
                {ev.sources && ev.sources.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2 pt-2 border-t border-[rgba(84,84,88,0.35)]">
                    <span className="text-[10px] font-semibold text-[rgba(235,235,245,0.3)] uppercase tracking-wider flex items-center gap-1 w-full mb-0.5">
                      <FileText size={10} /> Sources
                    </span>
                    {ev.sources.map((s: { filename?: string; page?: number | string; score?: number; uri?: string; title?: string; domain?: string }, idx: number) => {
                      if (s.uri) {
                        return (
                          <a
                            key={idx}
                            href={s.uri}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[11px] bg-[#30D158]/10 hover:bg-[#30D158]/20 text-[#30D158] px-2 py-0.5 rounded-lg transition-colors hover:underline inline-flex items-center gap-1 border border-[#30D158]/20 max-w-full"
                            title={s.title || s.uri}
                          >
                            <Globe size={9} className="shrink-0" />
                            <span className="truncate max-w-[220px]">{s.domain || s.title || s.uri}</span>
                          </a>
                        );
                      }
                      return (
                        <a
                          key={idx}
                          href={getFileUrl(s.filename!, s.page!)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[11px] bg-[#007AFF]/10 hover:bg-[#007AFF]/20 text-[#007AFF] px-2 py-0.5 rounded-lg transition-colors hover:underline inline-flex items-center gap-1 border border-[#007AFF]/20"
                        >
                          <Database size={9} />
                          {s.filename} (p.{s.page})
                        </a>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          {evidence.length > evidenceLimit && (
            <button
              onClick={() => setEvidenceLimit(prev => prev + 10)}
              className="w-full py-2.5 rounded-xl border border-[rgba(84,84,88,0.65)] text-[13px] text-[#007AFF] font-medium hover:bg-[#1C1C1E] transition-colors"
            >
              Show more ({evidence.length - evidenceLimit} remaining)
            </button>
          )}

          {evidence.length === 0 && !isInvestigating && (
            <div className="text-center py-10">
              <p className="text-[rgba(235,235,245,0.3)] text-[13px]">
                No evidence yet. Click "Investigate Further" to start.
              </p>
            </div>
          )}

          <div ref={bottomRef} />

          {/* Floating copy bar */}
          {selectedCards.size > 0 && (
            <div className="fixed left-1/2 -translate-x-1/2 flex items-center gap-2 bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-2xl px-4 py-2.5 shadow-2xl z-50" style={{ bottom: 'calc(24px + env(safe-area-inset-bottom, 0px))' }}>
              <span className="text-[13px] text-[rgba(235,235,245,0.6)] font-medium">
                {selectedCards.size} selected
              </span>
              <button
                onClick={copySelected}
                className="flex items-center gap-1.5 bg-[#007AFF] hover:bg-[#0071E3] px-3 py-1.5 rounded-xl text-[13px] font-semibold transition-colors"
              >
                <Copy size={13} />
                {copied ? 'Copied!' : 'Copy'}
              </button>
              <button
                onClick={() => { setSelectedCards(new Set()); setCopied(false); }}
                className="p-1.5 hover:bg-[#2C2C2E] rounded-lg transition-colors"
              >
                <X size={14} className="text-[rgba(235,235,245,0.4)]" />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
