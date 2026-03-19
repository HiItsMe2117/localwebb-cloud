import { useState, useRef, useEffect } from 'react';
import { Shield, Loader2, Check, X, Search, ChevronRight, Database, Plus, FlaskConical, ChevronDown, AlertTriangle, HelpCircle, Heart, Globe } from 'lucide-react';
import type { Case, ScanFinding, TheoryResult } from '../types';
import { CASE_CATEGORIES } from '../types';
import InvestigationSteps from './InvestigationSteps';
import axios from 'axios';

interface CasesPanelProps {
  cases: Case[];
  scanFindings: ScanFinding[];
  isScanning: boolean;
  onScan: () => void;
  onAccept: (finding: ScanFinding) => void;
  onDismiss: (finding: ScanFinding) => void;
  onAcceptAll: () => void;
  onOpenCase: (caseId: string) => void;
  onCreateCase: (title: string, category: string) => void;
  onTheoryInvestigate: (theory: string, caseIds: string[], mode: 'files_only' | 'files_web') => void;
  isTestingTheory: boolean;
  theoryResult: TheoryResult | null;
  onAcceptTheory: () => void;
  onDismissTheory: () => void;
  readOnly?: boolean;
}

function CategoryBadge({ category }: { category: string }) {
  const config = CASE_CATEGORIES[category] || CASE_CATEGORIES.other;
  return (
    <span
      className="text-[11px] font-semibold px-2 py-0.5 rounded-full"
      style={{ backgroundColor: config.color + '20', color: config.color }}
    >
      {config.label}
    </span>
  );
}

function ConfidenceBar({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  const color = confidence >= 0.7 ? '#FF453A' : confidence >= 0.4 ? '#FF9F0A' : '#8E8E93';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-[#2C2C2E] rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <span className="text-[11px] font-mono" style={{ color }}>{pct}%</span>
    </div>
  );
}

function FindingCard({ finding, onAccept, onDismiss }: {
  finding: ScanFinding;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-2xl p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <h3 className="text-[15px] font-semibold text-white truncate">{finding.title}</h3>
          <div className="mt-1">
            <CategoryBadge category={finding.category} />
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={onDismiss}
            className="w-8 h-8 rounded-full bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] flex items-center justify-center hover:bg-[#3A3A3C] transition-colors"
          >
            <X size={14} className="text-[rgba(235,235,245,0.4)]" />
          </button>
          <button
            onClick={onAccept}
            className="w-8 h-8 rounded-full bg-[#30D158]/20 border border-[#30D158]/30 flex items-center justify-center hover:bg-[#30D158]/30 transition-colors"
          >
            <Check size={14} className="text-[#30D158]" />
          </button>
        </div>
      </div>

      <ConfidenceBar confidence={finding.confidence} />

      <p className="text-[13px] text-[rgba(235,235,245,0.6)] leading-relaxed">
        {finding.summary}
      </p>

      {finding.entity_ids.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {finding.entity_ids.slice(0, 6).map((eid) => (
            <span key={eid} className="text-[11px] bg-[#2C2C2E] text-[rgba(235,235,245,0.5)] px-2 py-0.5 rounded-lg">
              {eid.replace(/_/g, ' ')}
            </span>
          ))}
          {finding.entity_ids.length > 6 && (
            <span className="text-[11px] text-[rgba(235,235,245,0.3)]">
              +{finding.entity_ids.length - 6} more
            </span>
          )}
        </div>
      )}

      {finding.sources && finding.sources.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {finding.sources.slice(0, 3).map((s, i) => (
            <span key={i} className="text-[10px] text-[rgba(235,235,245,0.3)] flex items-center gap-1">
              <Database size={10} />
              {s.filename} (p.{s.page})
            </span>
          ))}
          {finding.sources.length > 3 && (
            <span className="text-[10px] text-[rgba(235,235,245,0.2)]">
              +{finding.sources.length - 3} more sources
            </span>
          )}
        </div>
      )}
    </div>
  );
}

const VERDICT_CONFIG: Record<string, { label: string; color: string; icon: typeof Check }> = {
  supported:           { label: 'Supported',           color: '#30D158', icon: Check },
  partially_supported: { label: 'Partially Supported', color: '#FF9F0A', icon: AlertTriangle },
  inconclusive:        { label: 'Inconclusive',        color: '#8E8E93', icon: HelpCircle },
  contradicted:        { label: 'Contradicted',        color: '#FF453A', icon: X },
};

function TheoryResultCard({ result, onAccept, onDismiss }: {
  result: TheoryResult;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const verdict = result.verdict;
  if (!verdict) return null;

  const config = VERDICT_CONFIG[verdict.verdict] || VERDICT_CONFIG.inconclusive;
  const VerdictIcon = config.icon;
  const pct = Math.round(verdict.confidence * 100);

  return (
    <div className="bg-[#1C1C1E] border border-[#AF52DE]/30 rounded-2xl p-4 space-y-3 mt-4 max-w-2xl mx-auto">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span
              className="flex items-center gap-1 text-[13px] font-bold px-2.5 py-0.5 rounded-full"
              style={{ backgroundColor: config.color + '20', color: config.color }}
            >
              <VerdictIcon size={12} />
              {config.label}
            </span>
            <span className="text-[11px] font-mono" style={{ color: config.color }}>{pct}%</span>
          </div>
          <p className="text-[13px] text-[rgba(235,235,245,0.6)] leading-relaxed line-clamp-3">
            {result.theory}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={onDismiss}
            className="w-8 h-8 rounded-full bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] flex items-center justify-center hover:bg-[#3A3A3C] transition-colors"
          >
            <X size={14} className="text-[rgba(235,235,245,0.4)]" />
          </button>
          <button
            onClick={onAccept}
            className="w-8 h-8 rounded-full bg-[#30D158]/20 border border-[#30D158]/30 flex items-center justify-center hover:bg-[#30D158]/30 transition-colors"
          >
            <Check size={14} className="text-[#30D158]" />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-[#30D158] font-medium">{verdict.supporting_count}</span>
          <span className="text-[10px] text-[rgba(235,235,245,0.3)]">supporting</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-[#FF453A] font-medium">{verdict.contradicting_count}</span>
          <span className="text-[10px] text-[rgba(235,235,245,0.3)]">contradicting</span>
        </div>
      </div>

      {verdict.entities.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {verdict.entities.slice(0, 8).map((ent) => (
            <span key={ent} className="text-[11px] bg-[#2C2C2E] text-[rgba(235,235,245,0.5)] px-2 py-0.5 rounded-lg">
              {ent}
            </span>
          ))}
        </div>
      )}

      {verdict.claims.length > 0 && (
        <div className="space-y-1.5">
          {verdict.claims.slice(0, 5).map((claim, i) => {
            const claimConfig = VERDICT_CONFIG[claim.finding] || VERDICT_CONFIG.inconclusive;
            return (
              <div key={i} className="flex items-center gap-2 text-[11px]">
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: claimConfig.color }} />
                <span className="text-[rgba(235,235,245,0.5)] truncate flex-1">{claim.text}</span>
                <span className="text-[rgba(235,235,245,0.3)] shrink-0">{claim.strength}</span>
              </div>
            );
          })}
        </div>
      )}

      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-[11px] text-[rgba(235,235,245,0.3)] hover:text-[rgba(235,235,245,0.5)] transition-colors"
      >
        <ChevronDown size={10} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
        {expanded ? 'Hide report' : 'Show full report'}
      </button>

      {expanded && (
        <div className="border-t border-[rgba(84,84,88,0.35)] pt-3 mt-2">
          <div className="text-[13px] text-[rgba(235,235,245,0.6)] leading-relaxed whitespace-pre-wrap max-h-96 overflow-y-auto">
            {result.reportText}
          </div>
        </div>
      )}
    </div>
  );
}

function CaseCard({ caseData, onOpen }: { 
  caseData: Case & { liked?: boolean, likes_count?: number, owner_username?: string }; 
  onOpen: () => void;
}) {
  const [liked, setLiked] = useState(caseData.liked || false);
  const [likesCount, setLikesCount] = useState(caseData.likes_count || 0);

  const handleLike = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      if (liked) {
        await axios.delete(`/api/cases/like/${caseData.id}`);
        setLiked(false);
        setLikesCount(prev => prev - 1);
      } else {
        await axios.post('/api/cases/like', { case_id: caseData.id });
        setLiked(true);
        setLikesCount(prev => prev + 1);
      }
    } catch (err) {
      console.error('Failed to toggle like:', err);
    }
  };

  return (
    <button
      onClick={onOpen}
      className="w-full bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-2xl p-4 text-left hover:bg-[#2C2C2E] transition-colors active:scale-[0.99] flex items-center justify-between"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <h3 className="text-[15px] font-semibold text-white truncate">{caseData.title}</h3>
          {caseData.is_public && <Globe size={12} className="text-[rgba(235,235,245,0.3)]" />}
        </div>
        <div className="flex items-center gap-2">
          <CategoryBadge category={caseData.category} />
          <span className="text-[11px] text-[rgba(235,235,245,0.3)]">
            {caseData.owner_username ? `@${caseData.owner_username} • ` : ''}
            {new Date(caseData.updated_at).toLocaleDateString()}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-4 shrink-0">
        <div 
          onClick={handleLike}
          className={`flex items-center gap-1.5 transition-colors cursor-pointer ${liked ? 'text-[#FF2D55]' : 'text-[rgba(235,235,245,0.3)] hover:text-white'}`}
        >
          <Heart size={16} fill={liked ? 'currentColor' : 'none'} />
          <span className="text-[12px] font-mono">{likesCount}</span>
        </div>
        <ChevronRight size={18} className="text-[rgba(235,235,245,0.2)]" />
      </div>
    </button>
  );
}

export default function CasesPanel({
  cases, scanFindings, isScanning,
  onScan, onAccept, onDismiss, onAcceptAll, onOpenCase, onCreateCase,
  onTheoryInvestigate, isTestingTheory, theoryResult, onAcceptTheory, onDismissTheory,
  readOnly = false,
}: CasesPanelProps) {
  const [activeTab, setActiveTab] = useState<'my-cases' | 'explore'>('my-cases');
  const [exploreCases, setExploreCases] = useState<Case[]>([]);
  const [isExploreLoading, setIsExploreLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newCategory, setNewCategory] = useState('other');
  const [isCreating, setIsCreating] = useState(false);
  const [showTheoryForm, setShowTheoryForm] = useState(false);
  const [theoryText, setTheoryText] = useState('');
  const [theoryMode, setTheoryMode] = useState<'files_only' | 'files_web'>('files_only');
  const [selectedCaseIds, setSelectedCaseIds] = useState<string[]>([]);
  const theoryTextareaRef = useRef<HTMLTextAreaElement>(null);

  const loadExploreCases = async (query = '') => {
    setIsExploreLoading(true);
    try {
      const res = await axios.get(`/api/cases/trending${query ? `?q=${encodeURIComponent(query)}` : ''}`);
      setExploreCases(res.data.cases || []);
    } catch (err) {
      console.error('Failed to load explore cases:', err);
    } finally {
      setIsExploreLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'explore') {
      loadExploreCases(searchQuery);
    }
  }, [activeTab, searchQuery]);

  const activeCases = cases.filter(c => c.status === 'active');
  const closedCases = cases.filter(c => c.status === 'closed');
  const hasFindings = scanFindings.length > 0;
  const hasCases = cases.length > 0;

  const handleCreate = async () => {
    if (!newTitle.trim() || isCreating) return;
    setIsCreating(true);
    await onCreateCase(newTitle.trim(), newCategory);
    setNewTitle('');
    setNewCategory('other');
    setShowCreateForm(false);
    setIsCreating(false);
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="shrink-0 px-5 pt-4 pb-2 bg-black">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-[28px] font-bold tracking-tight text-white">Cases</h1>
          {!readOnly && <div className="flex items-center gap-2">
            <button
              onClick={() => { setShowTheoryForm(v => !v); setShowCreateForm(false); }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[13px] font-semibold transition-colors ${
                showTheoryForm ? 'bg-[#AF52DE] text-white' : 'bg-[#AF52DE]/20 text-[#AF52DE] hover:bg-[#AF52DE]/30'
              }`}
            >
              <FlaskConical size={14} />
              Theory
            </button>
            <button
              onClick={() => { setShowCreateForm(v => !v); setShowTheoryForm(false); }}
              className="flex items-center gap-1.5 bg-[#007AFF] hover:bg-[#0071E3] px-3 py-1.5 rounded-full text-[13px] font-semibold transition-colors"
            >
              <Plus size={14} />
              New Case
            </button>
            {hasCases && (
              <button
                onClick={onScan}
                disabled={isScanning}
                className="flex items-center gap-2 bg-[#1C1C1E] px-3 py-1.5 rounded-full text-[13px] font-medium border border-[rgba(84,84,88,0.65)] hover:bg-[#2C2C2E] transition-colors disabled:opacity-50"
              >
                {isScanning ? (
                  <Loader2 size={12} className="animate-spin text-[#FF9F0A]" />
                ) : (
                  <Search size={12} className="text-[rgba(235,235,245,0.4)]" />
                )}
                <span className="text-[rgba(235,235,245,0.6)]">
                  {isScanning ? 'Scanning...' : 'Scan'}
                </span>
              </button>
            )}
          </div>}
        </div>

        {/* Tab Switcher */}
        <div className="flex items-center gap-6 border-b border-white/5">
          <button 
            onClick={() => setActiveTab('my-cases')}
            className={`pb-2 text-[13px] font-bold transition-colors relative ${activeTab === 'my-cases' ? 'text-white' : 'text-[rgba(235,235,245,0.4)] hover:text-[rgba(235,235,245,0.6)]'}`}
          >
            My Cases
            {activeTab === 'my-cases' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#007AFF] rounded-full" />}
          </button>
          <button 
            onClick={() => setActiveTab('explore')}
            className={`pb-2 text-[13px] font-bold transition-colors relative ${activeTab === 'explore' ? 'text-white' : 'text-[rgba(235,235,245,0.4)] hover:text-[rgba(235,235,245,0.6)]'}`}
          >
            Explore Community
            {activeTab === 'explore' && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[#007AFF] rounded-full" />}
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-5 pb-6">
        {/* Create case form */}
        {showCreateForm && (
          <div className="bg-[#1C1C1E] border border-[#007AFF]/30 rounded-2xl p-4 space-y-3 mt-4 max-w-2xl mx-auto">
            <div className="flex items-center justify-between">
              <h3 className="text-[13px] font-semibold text-white">New Case</h3>
              <button onClick={() => setShowCreateForm(false)} className="p-1 hover:bg-[#2C2C2E] rounded-lg">
                <X size={14} className="text-[rgba(235,235,245,0.4)]" />
              </button>
            </div>
            <input
              type="text"
              value={newTitle}
              onChange={e => setNewTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleCreate(); }}
              placeholder="Case title..."
              autoFocus
              className="w-full bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] rounded-xl px-4 py-2.5 text-[13px] text-white focus:outline-none focus:border-[#007AFF] transition-colors placeholder:text-[rgba(235,235,245,0.2)]"
            />
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(CASE_CATEGORIES).map(([key, cfg]) => (
                <button
                  key={key}
                  onClick={() => setNewCategory(key)}
                  className={`text-[11px] font-semibold px-2.5 py-1 rounded-full transition-colors ${
                    newCategory === key
                      ? 'ring-2 ring-offset-1 ring-offset-[#1C1C1E]'
                      : 'opacity-50 hover:opacity-80'
                  }`}
                  style={{
                    backgroundColor: cfg.color + '20',
                    color: cfg.color,
                    ...(newCategory === key ? { ringColor: cfg.color } : {}),
                  }}
                >
                  {cfg.label}
                </button>
              ))}
            </div>
            <button
              onClick={handleCreate}
              disabled={!newTitle.trim() || isCreating}
              className="w-full flex items-center justify-center gap-2 bg-[#007AFF] hover:bg-[#0071E3] disabled:opacity-30 px-4 py-2.5 rounded-xl text-[13px] font-semibold transition-colors"
            >
              {isCreating ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              Create Case
            </button>
          </div>
        )}

        {/* Theory form */}
        {showTheoryForm && !isTestingTheory && !theoryResult && (
          <div className="bg-[#1C1C1E] border border-[#AF52DE]/30 rounded-2xl p-4 space-y-3 mt-4 max-w-2xl mx-auto">
            <div className="flex items-center justify-between">
              <h3 className="text-[13px] font-semibold text-white flex items-center gap-2">
                <FlaskConical size={14} className="text-[#AF52DE]" />
                Test a Theory
              </h3>
              <button onClick={() => setShowTheoryForm(false)} className="p-1 hover:bg-[#2C2C2E] rounded-lg">
                <X size={14} className="text-[rgba(235,235,245,0.4)]" />
              </button>
            </div>

            {/* Mode Toggle */}
            <div className="flex items-center gap-3 mb-2">
              <p className="text-[11px] text-[rgba(235,235,245,0.4)] font-medium">Source Scope</p>
              <div className="inline-flex bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] rounded-lg p-0.5">
                <button
                  onClick={() => setTheoryMode('files_only')}
                  className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-[11px] font-medium transition-all ${
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
                  className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-[11px] font-medium transition-all ${
                    theoryMode === 'files_web'
                      ? 'bg-[#AF52DE]/20 text-[#AF52DE] shadow-sm'
                      : 'text-[rgba(235,235,245,0.4)] hover:text-[rgba(235,235,245,0.6)]'
                  }`}
                >
                  <Globe size={12} />
                  Files + Web
                </button>
              </div>
            </div>

            <textarea
              ref={theoryTextareaRef}
              value={theoryText}
              onChange={e => setTheoryText(e.target.value)}
              placeholder="Describe your theory... e.g., 'Epstein was funneling money through Deutsche Bank to fund VI properties'"
              rows={3}
              className="w-full bg-[#2C2C2E] border border-[rgba(84,84,88,0.65)] rounded-xl px-4 py-2.5 text-[13px] text-white focus:outline-none focus:border-[#AF52DE] transition-colors placeholder:text-[rgba(235,235,245,0.2)] resize-none"
            />
            {cases.length > 0 && (
              <div>
                <p className="text-[11px] text-[rgba(235,235,245,0.4)] mb-2">Cross-reference with existing cases (optional)</p>
                <div className="flex flex-wrap gap-1.5">
                  {cases.slice(0, 10).map(c => {
                    const isSelected = selectedCaseIds.includes(c.id);
                    return (
                      <button
                        key={c.id}
                        onClick={() => setSelectedCaseIds(prev =>
                          isSelected ? prev.filter(id => id !== c.id) : [...prev, c.id]
                        )}
                        className={`text-[11px] px-2.5 py-1 rounded-full transition-colors ${
                          isSelected
                            ? 'bg-[#AF52DE]/20 text-[#AF52DE] ring-1 ring-[#AF52DE]/50'
                            : 'bg-[#2C2C2E] text-[rgba(235,235,245,0.4)] hover:text-[rgba(235,235,245,0.6)]'
                        }`}
                      >
                        {c.title.length > 30 ? c.title.slice(0, 30) + '...' : c.title}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            <button
              onClick={() => {
                if (theoryText.trim()) {
                  onTheoryInvestigate(theoryText.trim(), selectedCaseIds, theoryMode);
                }
              }}
              disabled={!theoryText.trim()}
              className="w-full flex items-center justify-center gap-2 bg-[#AF52DE] hover:bg-[#9B3DC8] disabled:opacity-30 px-4 py-2.5 rounded-xl text-[13px] font-semibold transition-colors"
            >
              <FlaskConical size={14} />
              Investigate Theory
            </button>
          </div>
        )}

        {/* Theory investigation progress */}
        {isTestingTheory && theoryResult && (
          <div className="mt-4 max-w-2xl mx-auto space-y-4">
            <div className="bg-[#1C1C1E] border border-[#AF52DE]/30 rounded-2xl p-4">
              <p className="text-[13px] text-[rgba(235,235,245,0.6)] mb-3 line-clamp-2">
                <span className="text-[#AF52DE] font-semibold">Testing:</span> {theoryResult.theory}
              </p>
              <InvestigationSteps steps={theoryResult.steps} />
              {theoryResult.reportText && (
                <div className="text-[13px] text-[rgba(235,235,245,0.6)] leading-relaxed whitespace-pre-wrap max-h-60 overflow-y-auto mt-3 border-t border-[rgba(84,84,88,0.35)] pt-3">
                  {theoryResult.reportText}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Theory result */}
        {!isTestingTheory && theoryResult?.verdict && (
          <div className="max-w-2xl mx-auto">
            <TheoryResultCard result={theoryResult} onAccept={onAcceptTheory} onDismiss={onDismissTheory} />
          </div>
        )}

        {/* Scanning overlay */}
        {isScanning && (
          <div className="flex flex-col items-center justify-center py-20">
            <Loader2 size={40} className="text-[#007AFF] animate-spin mb-6" />
            <p className="text-[17px] font-bold text-white mb-2">Scanning for Suspicious Activity</p>
            <p className="text-[13px] text-[rgba(235,235,245,0.4)] text-center max-w-sm">
              Analyzing knowledge graph and documents for patterns of money laundering, fraud, and other suspicious activity...
            </p>
          </div>
        )}

        {/* Proposals view */}
        {!isScanning && hasFindings && (
          <div className="space-y-4 max-w-2xl mx-auto">
            <div className="flex items-center justify-between">
              <p className="text-[15px] font-medium text-white">
                {scanFindings.length} finding{scanFindings.length !== 1 ? 's' : ''} detected
              </p>
                          <button
                            onClick={() => {
                              if (window.confirm(`Are you sure you want to accept all ${scanFindings.length} findings and create cases for them?`)) {
                                onAcceptAll();
                              }
                            }}
                            className="text-[13px] font-medium text-[#007AFF] hover:text-[#0A84FF] transition-colors"
                          >
                            Accept All
                          </button>            </div>
            {scanFindings.map((f, i) => (
              <FindingCard
                key={`${f.title}-${i}`}
                finding={f}
                onAccept={() => {
                  if (window.confirm(`Create a new investigation case for "${f.title}"?`)) {
                    onAccept(f);
                  }
                }}
                onDismiss={() => onDismiss(f)}
              />
            ))}
          </div>
        )}

        {/* Cases list */}
        {!isScanning && !hasFindings && (
          <div className="space-y-6 max-w-2xl mx-auto mt-6">
            {activeTab === 'my-cases' ? (
              <>
                {!hasCases && !showCreateForm && !showTheoryForm && (
                  <div className="flex-1 flex flex-col items-center justify-center py-20">
                    <div className="w-16 h-16 bg-[#1C1C1E] rounded-full flex items-center justify-center mb-6 border border-[rgba(84,84,88,0.65)]">
                      <Shield size={32} className="text-[rgba(235,235,245,0.3)]" />
                    </div>
                    <h2 className="text-[22px] font-bold text-white mb-2">AI Case Builder</h2>
                    <p className="text-[rgba(235,235,245,0.6)] text-[15px] max-w-sm mx-auto text-center leading-relaxed mb-8">
                      Scan your knowledge graph and documents for suspicious patterns. The AI will propose investigation cases for your review.
                    </p>
                    <button
                      onClick={onScan}
                      className="flex items-center gap-2 bg-[#007AFF] hover:bg-[#0071E3] px-6 py-3 rounded-full text-[15px] font-semibold transition-colors active:scale-95"
                    >
                      <Search size={18} />
                      Scan for Suspicious Activity
                    </button>
                  </div>
                )}

                {activeCases.length > 0 && (
                  <div className="space-y-3">
                    <h2 className="text-[13px] font-semibold text-[rgba(235,235,245,0.4)] uppercase tracking-wider">
                      Active ({activeCases.length})
                    </h2>
                    {activeCases.map(c => (
                      <CaseCard key={c.id} caseData={c} onOpen={() => onOpenCase(c.id)} />
                    ))}
                  </div>
                )}

                {closedCases.length > 0 && (
                  <div className="space-y-3">
                    <h2 className="text-[13px] font-semibold text-[rgba(235,235,245,0.4)] uppercase tracking-wider">
                      Closed ({closedCases.length})
                    </h2>
                    {closedCases.map(c => (
                      <CaseCard key={c.id} caseData={c} onOpen={() => onOpenCase(c.id)} />
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="space-y-6">
                <div className="relative">
                  <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-[rgba(235,235,245,0.3)]" size={16} />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    placeholder="Search community investigations..."
                    className="w-full bg-[#1C1C1E] border border-[rgba(84,84,88,0.65)] rounded-2xl pl-11 pr-4 py-3 text-[15px] text-white focus:outline-none focus:border-[#007AFF] transition-colors placeholder:text-[rgba(235,235,245,0.2)]"
                  />
                </div>

                {isExploreLoading ? (
                  <div className="flex flex-col items-center justify-center py-20">
                    <Loader2 size={32} className="text-[#007AFF] animate-spin mb-4" />
                    <p className="text-[13px] text-[rgba(235,235,245,0.4)]">Loading community cases...</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {exploreCases.length > 0 ? (
                      exploreCases.map(c => (
                        <CaseCard key={c.id} caseData={c} onOpen={() => onOpenCase(c.id)} />
                      ))
                    ) : (
                      <div className="text-center py-20">
                        <Globe size={40} className="mx-auto text-[rgba(235,235,245,0.1)] mb-4" />
                        <p className="text-[rgba(235,235,245,0.4)]">No public cases found matching your search.</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
